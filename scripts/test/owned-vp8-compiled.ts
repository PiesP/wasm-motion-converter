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

const wasmPath = resolve('crates/owned-vp8/target/wasm32-unknown-unknown/release/owned_vp8.wasm');
const compiled = compileVp8(readFileSync(wasmPath));
const root = mkdtempSync(join(tmpdir(), 'owned-vp8-abi2-'));
const results: object[] = [];
let succeeded = false;
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

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
  id: string
): Promise<void> {
  const job = new Vp8TestJob(compiled);
  try {
    const request = { width, height, stride, layout, quality };
    const result = await job.encode(pixels, request);
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
  const timer = setInterval(() => {
    const record = job.record();
    if (record.phase === 4 && record.stage === 2 && record.done > 0) {
      observed = true;
      stoppedAt = performance.now();
      controller.abort();
    }
  }, 1);
  try {
    await assert.rejects(
      job.encode(
        pixels,
        { width, height, stride: width * 4, layout: 0, quality: 75 },
        controller.signal
      ),
      { name: 'AbortError' }
    );
  } finally {
    clearInterval(timer);
  }
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

try {
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
  await leases();
  const cancel = await cancellation();
  console.log(
    JSON.stringify(
      {
        status: 'compiled-abi2-engineering-passed',
        scope: 'NOT_BROWSER_OR_PRODUCT_ACCEPTANCE',
        wasmSha256: compiled.sha256,
        node: process.version,
        ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
        leases: 'pending-input/output-stability-and-stale-publication-passed',
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
