/** Execute ABI2 WASM, independently decode keyframes, and exercise physical leases. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';

import { compileVp8, Vp8TestJob } from './owned-vp8-v2-abi.ts';
import { FIXTURES, generateFixture, QUALITIES } from './owned-vp8-v2-fixtures.ts';
import { generateV7Fixture } from './owned-vp8-v7-fixtures.ts';

const wasmPath = resolve('crates/owned-vp8/owned-vp8.wasm');
const compiled = compileVp8(readFileSync(wasmPath));
const root = mkdtempSync(join(tmpdir(), 'owned-vp8-abi2-'));
const results: object[] = [];
let succeeded = false;
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function v9ChromaEdge(): Uint8Array {
  const width = 407;
  const height = 277;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const rgb = (Math.floor((13 * x + 5 * y) / 19) & 1) !== 0 ? [221, 44, 184] : [35, 207, 71];
      pixels.set([...rgb, 255], (y * width + x) * 4);
    }
  return pixels;
}

function asIvf(frame: Uint8Array, width: number, height: number): Buffer {
  const ivf = Buffer.alloc(44 + frame.length);
  ivf.write('DKIF');
  ivf.writeUInt16LE(32, 6);
  ivf.write('VP80', 8);
  ivf.writeUInt16LE(width, 12);
  ivf.writeUInt16LE(height, 14);
  ivf.writeUInt32LE(1, 16);
  ivf.writeUInt32LE(1, 20);
  ivf.writeUInt32LE(1, 24);
  ivf.writeUInt32LE(frame.length, 32);
  Buffer.from(frame).copy(ivf, 44);
  return ivf;
}

async function check(
  pixels: Uint8Array,
  width: number,
  height: number,
  stride: number,
  layout: number,
  quality: number,
  id: string,
  onStage?: (stage: number) => void
): Promise<void> {
  const job = new Vp8TestJob(compiled);
  try {
    const request = { width, height, stride, layout, quality };
    let previousStage = -1;
    let previousDone = 0;
    const result = await job.encode(pixels, request, undefined, (record) => {
      if (
        (record.stage >= 27 && record.stage <= 40) ||
        (record.stage >= 41 && record.stage <= 57)
      ) {
        assert.equal(record.outputLength, 0, 'Refinement stages cannot publish output');
        assert.equal(record.outputPointer, 0, 'Refinement stages cannot lease output');
      }
      if (record.stage === previousStage && record.stage >= 41 && record.stage <= 57) {
        const bound = [42, 46, 50].includes(record.stage)
          ? 65_536
          : [43, 47, 51, 54, 56].includes(record.stage)
            ? 1
            : record.stage === 55 || record.stage === 57
              ? 1_024
              : [44, 48, 52].includes(record.stage)
                ? 64
                : 546;
        assert.ok(
          record.done >= previousDone && record.done - previousDone <= bound,
          `Quality stage ${record.stage} must progress within its work bound`
        );
      }
      previousStage = record.stage;
      previousDone = record.done;
      onStage?.(record.stage);
    });
    assert.deepEqual(
      (await job.encode(pixels, request)).bytes,
      result.bytes,
      'Within-conversion determinism'
    );
    const other = new Vp8TestJob(compiled, 2);
    try {
      assert.deepEqual(
        (await other.encode(pixels, request)).bytes,
        result.bytes,
        'Fresh-job determinism'
      );
    } finally {
      other.retire();
    }
    const frame = result.bytes;
    assert.equal(frame[0]! & 1, 0);
    assert.equal(frame[0]! & 0x10, 0x10);
    assert.deepEqual([...frame.subarray(3, 6)], [0x9d, 0x01, 0x2a]);
    const header = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    assert.equal(header.getUint16(6, true), width);
    assert.equal(header.getUint16(8, true), height);
    const ivf = join(root, `${id}-q${quality}.ivf`);
    writeFileSync(ivf, asIvf(frame, width, height));
    const decodedHashes: string[] = [];
    for (const decoder of ['vp8', 'libvpx']) {
      const decoded = execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-c:v',
          decoder,
          '-i',
          ivf,
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgba',
          'pipe:1',
        ],
        { maxBuffer: width * height * 4 + 4096 }
      );
      assert.equal(decoded.length, width * height * 4);
      for (let offset = 3; offset < decoded.length; offset += 4) assert.equal(decoded[offset], 255);
      decodedHashes.push(sha(decoded));
    }
    assert.equal(decodedHashes[0], decodedHashes[1], 'Distinct decoders must agree');
    results.push({
      id,
      width,
      height,
      stride,
      layout,
      quality,
      inputSha256: sha(pixels),
      rawBytes: frame.length,
      sha256: sha(frame),
      decodedSha256: decodedHashes[0],
      capacity: result.capacity,
      steps: result.steps,
      nodeEngineeringMaxStepMs: result.maxStepMs,
    });
  } finally {
    job.retire();
  }
}

function rawPlan(job: Vp8TestJob, frame = 1): void {
  const pointer = job.api.vp8_v2_request_ptr();
  const request = new DataView(job.api.memory.buffer, pointer, 48);
  [2, 16, 16, 64, 0, 75, 1024, 1_048_576, job.generation, frame, 1024, 0].forEach((value, index) =>
    request.setUint32(index * 4, value, true)
  );
  assert.equal(job.api.vp8_v2_plan(), 0);
}

async function leases(): Promise<void> {
  const job = new Vp8TestJob(compiled, 7);
  rawPlan(job);
  assert.equal(job.api.vp8_v2_reserve_step(7, 1), 0);
  const input = job.record();
  const view = new Uint8Array(job.api.memory.buffer, input.inputPointer, input.inputLength);
  const buffer = view.buffer;
  const copy = (async () => {
    await setImmediate();
    view.fill(37);
  })();
  assert.equal(job.api.vp8_v2_abort(7, 1), 9);
  job.retire();
  assert.equal(job.api.vp8_v2_plan(), 8);
  assert.equal(job.api.memory.buffer, buffer);
  await copy;
  assert.ok(
    view.every((value) => value === 37),
    'Pending input destination remained stable'
  );
  assert.equal(job.api.vp8_v2_release_input(7, 1), 0);
  assert.equal(job.record().phase, 6);

  const outputJob = new Vp8TestJob(compiled, 8);
  rawPlan(outputJob);
  assert.equal(outputJob.api.vp8_v2_reserve_step(8, 1), 0);
  const destination = outputJob.record();
  const rgba = new Uint8Array(
    outputJob.api.memory.buffer,
    destination.inputPointer,
    destination.inputLength
  );
  for (let index = 0; index < rgba.length; index += 4) rgba.set([128, 128, 128, 255], index);
  assert.equal(outputJob.api.vp8_v2_begin(8, 1), 10);
  let status = 10;
  while (status === 10) {
    status = outputJob.api.vp8_v2_step(8, 1);
    await setImmediate();
  }
  assert.equal(status, 11);
  const output = outputJob.record();
  const leased = new Uint8Array(
    outputJob.api.memory.buffer,
    output.outputPointer,
    output.outputLength
  );
  const saved = leased.slice();
  const oldBuffer = leased.buffer;
  assert.equal(outputJob.api.vp8_v2_release_output(8, 0), 7);
  assert.equal(
    outputJob.record().outputPointer,
    0,
    'Stale call must not publish the current lease'
  );
  assert.equal(outputJob.api.vp8_v2_abort(8, 1), 9);
  outputJob.retire();
  await setImmediate();
  assert.equal(outputJob.api.memory.buffer, oldBuffer);
  assert.deepEqual(leased, saved, 'Pending output stays finalized and stable');
  assert.equal(outputJob.api.vp8_v2_release_output(8, 1), 0);
  assert.equal(outputJob.record().phase, 6);
}

async function cancellation(): Promise<object> {
  const job = new Vp8TestJob(compiled, 9);
  const controller = new AbortController();
  const width = 256;
  const height = 128;
  const pixels = new Uint8Array(width * height * 4);
  let seed = 0x501;
  for (let at = 0; at < pixels.length; at += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels.set([seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255, 255], at);
  }
  let observed = false;
  let stoppedAt = 0;
  await assert.rejects(
    job.encode(
      pixels,
      { width, height, stride: width * 4, layout: 0, quality: 75 },
      controller.signal,
      (record) => {
        if (!observed && record.phase === 4 && record.stage === 2 && record.done > 0) {
          observed = true;
          stoppedAt = performance.now();
          controller.abort();
        }
      }
    ),
    { name: 'AbortError' }
  );
  assert.ok(observed, 'Cancellation must observe actual owned macroblock analysis');
  assert.equal(job.record().outputLength, 0);
  const idleMs = performance.now() - stoppedAt;
  const recovered = new Vp8TestJob(compiled, 10);
  try {
    assert.ok(
      (
        await recovered.encode(pixels.subarray(0, 1024), {
          width: 16,
          height: 16,
          stride: 64,
          layout: 0,
          quality: 75,
        })
      ).bytes.length > 10
    );
  } finally {
    recovered.retire();
  }
  return {
    activeAnalysisObserved: observed,
    nodeEngineeringStopToIdleMs: idleMs,
    newInstanceRecovery: true,
  };
}

async function qualityCancellation(): Promise<object> {
  const fixture = generateV7Fixture('fresh7-tiny-5x1');
  const job = new Vp8TestJob(compiled, 11);
  const controller = new AbortController();
  let observed = false;
  try {
    await assert.rejects(
      job.encode(
        fixture.pixels,
        {
          width: fixture.width,
          height: fixture.height,
          stride: fixture.stride,
          layout: 0,
          quality: 85,
        },
        controller.signal,
        (record) => {
          if (!observed && record.phase === 4 && record.stage === 42) {
            observed = true;
            controller.abort();
          }
        }
      ),
      { name: 'AbortError' }
    );
    assert.ok(observed, 'Cancellation must observe the filtered-copy stage');
    assert.equal(job.record().outputLength, 0);
    assert.equal(job.record().outputPointer, 0);
  } finally {
    job.retire();
  }
  return { filteredCopyObserved: observed, noOutputLease: true };
}

async function profileCancellation(): Promise<object> {
  const pixels = v9ChromaEdge();
  const reached: number[] = [];
  for (const [index, target] of [54, 55, 56, 57].entries()) {
    const job = new Vp8TestJob(compiled, 30 + index);
    const controller = new AbortController();
    try {
      await assert.rejects(
        job.encode(
          pixels,
          { width: 407, height: 277, stride: 407 * 4, layout: 0, quality: 60 },
          controller.signal,
          (record) => {
            if (record.phase === 4 && record.stage === target && record.done > 0) {
              assert.equal(job.api.vp8_v2_step(job.generation, 2), 7);
              assert.equal(job.record().stage, target);
              reached.push(target);
              controller.abort();
            }
          }
        ),
        { name: 'AbortError' }
      );
      assert.equal(job.record().outputLength, 0);
      assert.equal(job.record().outputPointer, 0);
    } finally {
      job.retire();
    }
    const recovered = new Vp8TestJob(compiled, 40 + index);
    try {
      const neutral = new Uint8Array(16 * 16 * 4);
      for (let at = 0; at < neutral.length; at += 4) neutral.set([128, 128, 128, 255], at);
      assert.ok(
        (
          await recovered.encode(neutral, {
            width: 16,
            height: 16,
            stride: 64,
            layout: 0,
            quality: 75,
          })
        ).bytes.length > 10
      );
    } finally {
      recovered.retire();
    }
  }
  assert.deepEqual(reached, [54, 55, 56, 57]);
  return { profileStagesCancelled: reached, noOutputLease: true, newInstanceRecovery: true };
}

try {
  const largeOnly = process.argv.includes('--large-only');
  let leaseCheck = 'NOT_RUN';
  if (!largeOnly) {
    for (const [width, height, layout] of [
      [16, 16, 0],
      [17, 13, 1],
    ] as const) {
      const stride = width * 4 + 8;
      const pixels = new Uint8Array(stride * height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) pixels.set([128, 128, 128, 255], y * stride + x * 4);
      for (const quality of QUALITIES)
        await check(pixels, width, height, stride, layout, quality, `neutral-${width}x${height}`);
    }
    for (const fixture of FIXTURES.filter((entry) => entry.split === 'tuning')) {
      const pixels = generateFixture(fixture.id);
      for (const quality of QUALITIES)
        await check(
          pixels.pixels,
          pixels.width,
          pixels.height,
          pixels.stride,
          0,
          quality,
          fixture.id
        );
    }
    const frontierWidth = 33;
    const frontierHeight = 33;
    const frontier = new Uint8Array(frontierWidth * frontierHeight * 4);
    for (let y = 0; y < frontierHeight; y++)
      for (let x = 0; x < frontierWidth; x++) {
        const gray = 48 + ((x * 9 + y * 13 + ((x * y) % 7) * 3) % 160);
        frontier.set(
          [gray + ((x * 5 + y * 3) % 17), gray, gray - ((x * 3 + y * 7) % 13), 255],
          (y * frontierWidth + x) * 4
        );
      }
    const refinementStages = new Set<number>();
    for (const quality of QUALITIES)
      await check(
        frontier,
        frontierWidth,
        frontierHeight,
        frontierWidth * 4,
        0,
        quality,
        'refinement-frontier-33x33',
        (stage) => refinementStages.add(stage)
      );
    for (const [id, quality] of [
      ['fresh7-tiny-2x9', 60],
      ['fresh7-tiny-5x1', 85],
      ['fresh7-tiny-1x11', 75],
    ] as const) {
      const fixture = generateV7Fixture(id);
      await check(
        fixture.pixels,
        fixture.width,
        fixture.height,
        fixture.stride,
        0,
        quality,
        id,
        (stage) => refinementStages.add(stage)
      );
    }
    // Synthetic 7x1 control: the already-counted extended frame earns one byte.
    const tinyChroma = Uint8Array.from([
      244, 29, 171, 255, 89, 61, 239, 255, 89, 61, 239, 255, 89, 61, 239, 255, 244, 29, 171, 255,
      89, 61, 239, 255, 89, 61, 239, 255,
    ]);
    assert.equal(
      sha(tinyChroma),
      '98327a8e2b199892e85c2ff74865b026c6b4e478c3711a015a19590e02cf1c0e'
    );
    await check(tinyChroma, 7, 1, 28, 0, 85, 'synthetic-tiny-chroma-7x1');
    const tinyChromaResult = results.at(-1) as { rawBytes: number; sha256: string };
    assert.equal(tinyChromaResult.rawBytes, 69);
    assert.equal(
      tinyChromaResult.sha256,
      '44311bcce84a2fc6aa42ee2c56b586672ccb7ed66edca1d4f8faf8a9b4d676fa'
    );
    for (const decoder of ['vp8', 'libvpx']) {
      const yuv = execFileSync('ffmpeg', [
        '-v',
        'error',
        '-c:v',
        decoder,
        '-i',
        join(root, 'synthetic-tiny-chroma-7x1-q85.ivf'),
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'yuv420p',
        'pipe:1',
      ]);
      assert.equal(sha(yuv), '4f072056a8e663df2a1614af55583af59e6cb88b8aec9ad13f9c41b5f674f70b');
    }
    const v9 = v9ChromaEdge();
    assert.equal(sha(v9), '5eb62c1a42930b9bec9eeed26ae60778b4c80243e890cf9c6a40d7005896f313');
    const profileStages = new Set<number>();
    await check(v9, 407, 277, 407 * 4, 0, 60, 'frozen-v9-chroma-edge', (stage) =>
      profileStages.add(stage)
    );
    assert.deepEqual(
      [...profileStages].filter((stage) => stage >= 54 && stage <= 57).sort(),
      [54, 55, 56, 57],
      'Compiled Original and Reduced filter and RGB score stages'
    );
    const v9Result = results.at(-1) as { rawBytes: number; sha256: string };
    assert.equal(v9Result.rawBytes, 40_869);
    assert.equal(
      v9Result.sha256,
      '8660307d21aac70d59a53d3e2f78764cfa2d270cac4a7d60ca1e3d5afc5ce79f'
    );
    for (const decoder of ['vp8', 'libvpx']) {
      const yuv = execFileSync('ffmpeg', [
        '-v',
        'error',
        '-c:v',
        decoder,
        '-i',
        join(root, 'frozen-v9-chroma-edge-q60.ivf'),
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'yuv420p',
        'pipe:1',
      ]);
      assert.equal(sha(yuv), '399d837e7b36403510975d12a529d1dbf9cb5271b95e3ac84168d692dee4125c');
    }
    assert.deepEqual(
      results
        .filter((entry) => (entry as { id: string }).id.startsWith('fresh7-tiny-'))
        .map((entry) => (entry as { rawBytes: number }).rawBytes),
      [96, 81, 96]
    );
    for (const stage of [36, 37, 38, 39, 40, 27, 28, 29, 35, 42, 44, 46, 48, 50, 52, 53])
      assert.ok(refinementStages.has(stage), `Compiled ABI2 must reach refinement stage ${stage}`);
    for (const layout of [0, 1, 2, 3, 4]) {
      const width = 17;
      const height = 13;
      const bpp = layout === 4 ? 3 : 4;
      const stride = width * bpp + 8;
      const pixels = new Uint8Array(stride * height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const rgb = [x * 11, y * 15, (x + y) * 7];
          if (layout === 1 || layout === 3) rgb.reverse();
          pixels.set(bpp === 3 ? rgb : [...rgb, layout < 2 ? 255 : 13], y * stride + x * bpp);
        }
      await check(pixels, width, height, stride, layout, 75, `layout-${layout}`);
    }
    const layoutResults = results.filter((entry) =>
      (entry as { id: string }).id.startsWith('layout-')
    ) as Array<{ decodedSha256: string }>;
    assert.equal(
      new Set(layoutResults.map((entry) => entry.decodedSha256)).size,
      1,
      'Equivalent packed layouts preserve color'
    );
    for (const [width, height] of [
      [16383, 1],
      [1, 16383],
    ] as const) {
      const pixels = new Uint8Array(width * height * 4);
      for (let at = 0; at < pixels.length; at += 4) pixels.set([128, 128, 128, 255], at);
      await check(pixels, width, height, width * 4, 0, 75, `axis-${width}x${height}`);
    }
    await leases();
    leaseCheck = 'pending-input/output-stability-and-stale-publication-passed';
  }
  let cancel: object | null = null;
  if (largeOnly) {
    const width = 4096;
    const height = 2048;
    const pixels = new Uint8Array(width * height * 4);
    let seed = 0x501b0a;
    for (let at = 0; at < pixels.length; at += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels.set([seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255, 255], at);
    }
    await check(pixels, width, height, width * 4, 0, 85, 'engineering-large-noise');
    assert.ok(
      (results[0] as { rawBytes: number }).rawBytes > 4 * 1024 * 1024,
      'Resource probe must cross the retired prototype output cap'
    );
  } else {
    cancel = {
      analysis: await cancellation(),
      quality: await qualityCancellation(),
      profile: await profileCancellation(),
    };
  }
  console.log(
    JSON.stringify(
      {
        status: 'compiled-abi2-engineering-passed',
        scope: 'NOT_BROWSER_OR_PRODUCT_ACCEPTANCE',
        wasmSha256: compiled.sha256,
        node: process.version,
        ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
        leases: leaseCheck,
        cancellation: cancel,
        results,
      },
      null,
      2
    )
  );
  succeeded = true;
} finally {
  if (succeeded) rmSync(root, { recursive: true, force: true });
  else console.error(`Failed VP8 compiled evidence retained: ${root}`);
}
