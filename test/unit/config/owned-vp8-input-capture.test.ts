// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, it } from 'vite-plus/test';

import { writeOwnedVp8InputCaptureLock } from '../../../scripts/test/generate-owned-vp8-input-capture-lock.ts';
import {
  assertCaptureInventory,
  assertV8CaptureBuild,
  assertV8CaptureLock,
  captureIndex,
  compareCapturedPixels,
  compareV8StreamedHashes,
  createV8CaptureLock,
  installV8AllInputHashCapture,
  patchV8ExactCallback,
  patchV8MainEncoderCallback,
  V8_CAPTURE_BUDGET,
  V8_CAPTURE_CHUNK,
  V8_CAPTURE_INDICES,
  V8_COMBINED_MODULE_SHA256,
  V8_MAIN_ASSETS,
  V8_PRIOR_LEGACY_WASM_SHA256,
  V8_PRIOR_SOURCE_SHA,
  V8_RGB_BYTES,
  V8_LEGACY_COPY_BYTES,
  V8IncrementalHashReceiver,
  installV8PixelCapture,
  type CapturedPixel,
  type V8CaptureBuildSource,
  type V8HashMessage,
  type V8StreamedHashRow,
} from '../../../validation/windows/helpers/owned-vp8-input-capture.ts';

const valid = () => ({
  observedInputs: 77,
  selected: V8_CAPTURE_INDICES.map((index) => ({ index, ticket: index + 1, bytes: V8_RGB_BYTES })),
  retainedBytes: V8_CAPTURE_INDICES.length * V8_RGB_BYTES,
  error: null as string | null,
});

describe('V8 post-Canvas packed RGB capture contract', () => {
  it('keeps candidate source and allowlisted module digests separate', () => {
    const source = 'ee86865e30ee9395ee2c2c26041a197debf0114c';
    const historicalModule = 'f962b9e803a014febc96d9a59bbab8faeb032866e837136c6afd8dd972fc4186';
    const combinedModule = 'bd170496ba1f2574bd095effdc55b7cd102b203dcc347a472141fcfbd9284b0e';
    assert.doesNotThrow(() => assertV8CaptureBuild(source, historicalModule));
    assert.doesNotThrow(() =>
      assertV8CaptureBuild('bd1cbfdb267edc4b5617023f17234425a13da235', combinedModule)
    );
    assert.throws(() => assertV8CaptureBuild(combinedModule, combinedModule), /Git source SHA/);
    assert.throws(() => assertV8CaptureBuild(source, source), /WASM digest differs/);
    assert.throws(() => assertV8CaptureBuild(source, '0'.repeat(64)), /WASM digest differs/);
    assert.throws(
      () => assertV8CaptureBuild(source, historicalModule.slice(0, -1) + '0'),
      /WASM digest differs/
    );
    assert.throws(
      () => assertV8CaptureBuild(source, combinedModule.slice(0, -1) + '0'),
      /WASM digest differs/
    );
    assert.throws(
      () => assertV8CaptureBuild(source, combinedModule.slice(0, -1)),
      /WASM digest differs/
    );
  });

  it('selects five observed input ordinals within a 32 MiB per-context budget', () => {
    assert.deepEqual(
      Array.from({ length: 77 }, (_, index) => index).filter(captureIndex),
      [0, 19, 38, 57, 76]
    );
    assert.equal(V8_RGB_BYTES, 6_220_800);
    assert(V8_CAPTURE_INDICES.length * V8_RGB_BYTES <= V8_CAPTURE_BUDGET);
    assert.equal(V8_CAPTURE_CHUNK, 65_536);
    assert.doesNotThrow(() => assertCaptureInventory(valid()));
  });

  it('rejects missing work, stale tickets, wrong extents and retained copies', () => {
    const missing = valid();
    missing.observedInputs = 76;
    assert.throws(() => assertCaptureInventory(missing), /observed input count/);
    const stale = valid();
    stale.selected[2]!.ticket = 38;
    assert.throws(() => assertCaptureInventory(stale), /frame ticket is stale/);
    const extent = valid();
    extent.selected[0]!.bytes--;
    assert.throws(() => assertCaptureInventory(extent), /packed RGB extent/);
    const budget = valid();
    budget.retainedBytes = V8_CAPTURE_BUDGET + 1;
    assert.throws(() => assertCaptureInventory(budget), /retainedBytes|copy budget/);
    const failure = valid();
    failure.error = 'wrong ABI phase';
    assert.throws(() => assertCaptureInventory(failure), /wrong ABI phase/);
  });

  it('keeps same-index RGB digest differences as diagnostic mismatches', () => {
    const prior: CapturedPixel[] = V8_CAPTURE_INDICES.map((index) => ({
      index,
      ticket: index + 1,
      bytes: V8_RGB_BYTES,
      file: `prior-${index}.rgb`,
      sha256: 'a'.repeat(64),
    }));
    const candidate = prior.map((entry) => ({ ...entry, file: `candidate-${entry.index}.rgb` }));
    candidate[2]!.sha256 = 'b'.repeat(64);
    const comparison = compareCapturedPixels(prior, candidate);
    assert.deepEqual(
      comparison.map((entry) => entry.same),
      [true, true, false, true, true]
    );
    candidate[2]!.index = 39;
    assert.throws(() => compareCapturedPixels(prior, candidate), /selected pixel indices differ/);
  });

  it('copies only completed legacy RGB destination bytes and bounds each chunk', () => {
    const sandbox = { Uint8Array, btoa, WebAssembly: { Instance: class {}, Memory: class {} } };
    runInNewContext(`(${installV8PixelCapture.toString()})('prior')`, sandbox);
    const state = Reflect.get(sandbox, '__wmcV8PixelCapture') as {
      snapshot: () => { observedInputs: number; retainedBytes: number };
      chunk: (index: number, offset: number, length: number) => string;
      release: (index: number) => void;
    };
    const callback = Reflect.get(sandbox, '__wmcVp8LegacyCopy') as (
      heap: Uint8Array,
      unused: unknown,
      offset: number,
      count: number,
      source: Uint8Array
    ) => void;
    const heap = new Uint8Array(V8_LEGACY_COPY_BYTES + 20);
    const source = new Uint8Array(V8_LEGACY_COPY_BYTES);
    heap.fill(41, 10);
    callback(heap, null, 10, V8_LEGACY_COPY_BYTES, source);
    assert.equal(state.snapshot().observedInputs, 1);
    assert.equal(state.snapshot().retainedBytes, V8_RGB_BYTES);
    heap[10] = 99;
    assert.equal(Buffer.from(state.chunk(0, 0, 1), 'base64')[0], 41);
    assert.throws(() => state.chunk(0, 0, V8_CAPTURE_CHUNK + 1), /invalid pixel stream extent/);
    state.release(0);
    assert.equal(state.snapshot().retainedBytes, 0);
    assert.throws(
      () => callback(heap, null, 10, V8_RGB_BYTES, source),
      /legacy RGB destination is invalid/
    );
  });

  it('reads candidate ABI input after writes and before successful begin mutates memory', () => {
    class FakeMemory {
      buffer = new ArrayBuffer(V8_RGB_BYTES + 1024);
    }
    const memory = new FakeMemory();
    const words = new DataView(memory.buffer);
    const inputAt = 512;
    const requestAt = 128;
    const responseAt = 256;
    let beginStatus = 10;
    class FakeInstance {
      exports = {
        memory,
        vp8_v2_request_ptr: () => requestAt,
        vp8_v2_response_ptr: () => responseAt,
        vp8_v2_begin: (_generation: number, _frame: number) => {
          new Uint8Array(memory.buffer)[inputAt] = 99;
          return beginStatus;
        },
      };
    }
    const sandbox = {
      Uint8Array,
      DataView,
      ArrayBuffer,
      btoa,
      WebAssembly: { Instance: FakeInstance, Memory: FakeMemory },
    };
    runInNewContext(`(${installV8PixelCapture.toString()})('candidate')`, sandbox);
    const instance = new sandbox.WebAssembly.Instance();
    const state = Reflect.get(sandbox, '__wmcV8PixelCapture') as {
      snapshot: () => { observedInputs: number; retainedBytes: number };
      chunk: (index: number, offset: number, length: number) => string;
      release: (index: number) => void;
    };
    for (let frame = 1; frame <= 77; frame++) {
      const request = [2, 1920, 1080, 5760, 4, 60, V8_RGB_BYTES, 4_194_304, 1, frame, 0, 0];
      request.forEach((value, index) => words.setUint32(requestAt + index * 4, value, true));
      const response = [2, 0, 3, 1, frame, inputAt, V8_RGB_BYTES, 0, 0, memory.buffer.byteLength];
      response.forEach((value, index) => words.setUint32(responseAt + index * 4, value, true));
      new Uint8Array(memory.buffer)[inputAt] = 41;
      if (frame === 1) {
        beginStatus = 2;
        assert.equal(instance.exports.vp8_v2_begin(1, frame), 2);
        assert.equal(state.snapshot().observedInputs, 0);
        assert.equal(state.snapshot().retainedBytes, 0);
        beginStatus = 10;
        new Uint8Array(memory.buffer)[inputAt] = 41;
      }
      assert.equal(instance.exports.vp8_v2_begin(1, frame), 10);
    }
    assert.equal(state.snapshot().observedInputs, 77);
    assert.equal(Buffer.from(state.chunk(0, 0, 1), 'base64')[0], 41);
    assert.equal(state.snapshot().retainedBytes, 5 * V8_RGB_BYTES);
    for (const index of V8_CAPTURE_INDICES) state.release(index);
    assert.equal(state.snapshot().retainedBytes, 0);
    assert.throws(() => instance.exports.vp8_v2_begin(1, 77), /input lease, request or ticket/);
  });
});

describe('V8 all-input streamed hash observer', () => {
  const build = (kind: 'prior' | 'candidate'): V8CaptureBuildSource => ({
    manifestSha256: (kind === 'prior' ? '1' : '2').repeat(64),
    state: {
      sourceSha: kind === 'prior' ? V8_PRIOR_SOURCE_SHA : 'a'.repeat(40),
      treeSha: (kind === 'prior' ? '3' : '4').repeat(40),
      coreSha: '5'.repeat(40),
      files: [
        {
          path:
            kind === 'prior' ? 'assets/webp-wasm.12345678.wasm' : 'assets/owned-vp8.12345678.wasm',
          size: 1024,
          sha256: kind === 'prior' ? V8_PRIOR_LEGACY_WASM_SHA256 : V8_COMBINED_MODULE_SHA256,
        },
        {
          path:
            kind === 'prior'
              ? 'assets/conversion-pipeline.Dl9WEMix.js'
              : 'assets/conversion-pipeline.B-ebNt7j.js',
          size: kind === 'prior' ? 81_318 : 99_288,
          sha256: kind === 'prior' ? V8_MAIN_ASSETS.prior.sha256 : '9'.repeat(64),
        },
      ],
    },
  });

  it('locks source, module, inventory, callback asset and exact needle for both builds', () => {
    const prior = build('prior');
    const candidate = build('candidate');
    const lock = createV8CaptureLock(prior, candidate);
    assert.equal(lock.schemaVersion, 1);
    assert.equal(lock.candidate.sourceSha, 'a'.repeat(40));
    assert.equal(lock.candidate.module.sha256, V8_COMBINED_MODULE_SHA256);
    assert.equal(lock.candidate.callbackAsset.sha256, '9'.repeat(64));
    assert.equal(
      lock.candidate.callbackNeedleSha256,
      createHash('sha256').update(V8_MAIN_ASSETS.candidate.needle).digest('hex')
    );
    assert.doesNotThrow(() => assertV8CaptureLock(lock, prior, candidate));
    assert.throws(
      () => assertV8CaptureLock(lock, prior, { ...candidate, manifestSha256: '8'.repeat(64) }),
      /lock differs/
    );
    assert.throws(
      () =>
        assertV8CaptureLock(
          { ...lock, candidate: { ...lock.candidate, sourceSha: 'b'.repeat(40) } },
          prior,
          candidate
        ),
      /lock differs/
    );
    assert.throws(
      () =>
        createV8CaptureLock(
          { ...prior, state: { ...prior.state, sourceSha: 'b'.repeat(40) } },
          candidate
        ),
      /prior source pin/
    );
    assert.throws(
      () =>
        createV8CaptureLock(prior, {
          ...candidate,
          state: {
            ...candidate.state,
            files: candidate.state.files.map((file, index) =>
              index === 0 ? { ...file, sha256: '0'.repeat(64) } : file
            ),
          },
        }),
      /WASM digest differs/
    );
    assert.throws(
      () =>
        createV8CaptureLock(prior, {
          ...candidate,
          state: {
            ...candidate.state,
            files: candidate.state.files.map((file, index) =>
              index === 0
                ? {
                    ...file,
                    sha256: 'f962b9e803a014febc96d9a59bbab8faeb032866e837136c6afd8dd972fc4186',
                  }
                : file
            ),
          },
        }),
      /combined WASM pin/
    );
    assert.throws(
      () =>
        createV8CaptureLock(prior, {
          ...candidate,
          state: { ...candidate.state, files: candidate.state.files.slice(0, 1) },
        }),
      /main callback asset is not unique/
    );
  });

  it('creates a lock once, reuses identical bytes and preserves mismatched evidence', async () => {
    const output = await mkdtemp(join(tmpdir(), 'wmc-v8-lock-'));
    const path = join(output, 'owned-vp8-v8-input-capture-lock.json');
    const bytes = Buffer.from('exclusive lock\n');
    try {
      assert.equal(await writeOwnedVp8InputCaptureLock(path, bytes), 'new');
      assert.equal(await writeOwnedVp8InputCaptureLock(path, bytes), 'reused');
      await assert.rejects(
        writeOwnedVp8InputCaptureLock(path, Buffer.from('different lock\n')),
        /lock differs/
      );
      assert.deepEqual(await readFile(path), bytes);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it('pins both five-argument field maps and rejects drift before patching', () => {
    assert.match(V8_MAIN_ASSETS.prior.needle, /async\(n,i,a,c,u\)/);
    assert.equal(V8_MAIN_ASSETS.prior.insertion, 'await globalThis.__wmcV8HashCallback(n,a,u);');
    assert.match(V8_MAIN_ASSETS.candidate.needle, /async\(n,a,u,d,f\)/);
    assert.equal(
      V8_MAIN_ASSETS.candidate.insertion,
      'await globalThis.__wmcV8HashCallback(n,u,f);'
    );
    assert(V8_MAIN_ASSETS.prior.needle.endsWith('async()=>{'));
    assert(V8_MAIN_ASSETS.candidate.needle.endsWith('async()=>{'));
    assert.throws(
      () =>
        patchV8MainEncoderCallback(Buffer.from('wrong'), 'prior', 5, V8_MAIN_ASSETS.prior.sha256),
      /digest/
    );
    assert.throws(
      () => patchV8MainEncoderCallback(Buffer.from('wrong'), 'candidate', 6, '0'.repeat(64)),
      /size/
    );
    const candidateSource = Buffer.from(`${V8_MAIN_ASSETS.candidate.needle}return 1})}`);
    const candidateSha256 = createHash('sha256').update(candidateSource).digest('hex');
    assert.match(
      Buffer.from(
        patchV8MainEncoderCallback(
          candidateSource,
          'candidate',
          candidateSource.length,
          candidateSha256
        ).bytes
      ).toString(),
      /__wmcV8HashCallback\(n,u,f\)/
    );
  });

  it('requires exact bytes and one callback, with the hook inside pooled cleanup', async () => {
    const needle = 'return pooled(pixels,async()=>{';
    const insertion = 'await hook(pixels,frameNum,presentation);';
    const source = `async function callback(pixels,frameNum,presentation){${needle}return 1})}`;
    const bytes = Buffer.from(source);
    const contract = {
      expectedBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      needle,
      insertion,
    };
    const patched = patchV8ExactCallback(bytes, contract);
    assert.equal(patched.originalSha256, contract.sha256);
    assert.equal(patched.patchedSha256, createHash('sha256').update(patched.bytes).digest('hex'));
    assert.equal(Buffer.from(patched.bytes).toString(), source.replace(needle, needle + insertion));
    assert.throws(
      () => patchV8ExactCallback(bytes, { ...contract, expectedBytes: bytes.length + 1 }),
      /size/
    );
    assert.throws(
      () => patchV8ExactCallback(bytes, { ...contract, sha256: '0'.repeat(64) }),
      /digest/
    );
    for (const changed of [
      source.replace(needle, 'return other(pixels,async()=>{'),
      source + source,
    ]) {
      const input = Buffer.from(changed);
      assert.throws(
        () =>
          patchV8ExactCallback(input, {
            ...contract,
            expectedBytes: input.length,
            sha256: createHash('sha256').update(input).digest('hex'),
          }),
        /not unique/
      );
    }
    let released = 0;
    const sandbox = {
      hook: async () => {
        throw new Error('stream failed');
      },
      pooled: async (_pixels: Uint8Array, use: () => Promise<number>) => {
        try {
          return await use();
        } finally {
          released++;
        }
      },
    };
    const callback = runInNewContext(
      `${Buffer.from(patched.bytes).toString()}; callback`,
      sandbox
    ) as (
      pixels: Uint8Array,
      frameNum: number,
      presentation: { startUs: number; endUs: number }
    ) => Promise<number>;
    await assert.rejects(callback(new Uint8Array(1), 0, { startUs: 0, endUs: 1 }), /stream failed/);
    assert.equal(released, 1);
  });

  it('streams one borrowed RGB frame in bounded canonical chunks', async () => {
    const pixels = new Uint8Array(V8_RGB_BYTES);
    pixels.fill(41);
    const expected = createHash('sha256').update(pixels).digest('hex');
    const hash = createHash('sha256');
    let chunks = 0;
    let offset = 0;
    const messages: Array<Exclude<V8HashMessage, { kind: 'chunk' }>> = [];
    const sandbox = {
      Uint8Array,
      btoa,
      __wmcV8HashStream: async (message: V8HashMessage) => {
        if (message.kind !== 'chunk') {
          messages.push(message);
          return;
        }
        assert.equal(message.index, 0);
        assert.equal(message.offset, offset);
        assert(message.base64.length <= 4 * Math.ceil(V8_CAPTURE_CHUNK / 3));
        const bytes = Buffer.from(message.base64, 'base64');
        assert.equal(bytes.toString('base64'), message.base64);
        assert(bytes.length <= V8_CAPTURE_CHUNK);
        hash.update(bytes);
        offset += bytes.length;
        chunks++;
      },
    };
    runInNewContext(`(${installV8AllInputHashCapture.toString()})()`, sandbox);
    const callback = Reflect.get(sandbox, '__wmcV8HashCallback') as (
      bytes: Uint8Array,
      frameNum: number,
      timing: { startUs: number; endUs: number }
    ) => Promise<void>;
    await callback(pixels, 0, { startUs: 0, endUs: 33_333 });
    assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
      { kind: 'begin', index: 0, frameNum: 0, startUs: 0, endUs: 33_333 },
      { kind: 'end', index: 0 },
    ]);
    assert.equal(offset, V8_RGB_BYTES);
    assert.equal(chunks, 95);
    assert.equal(hash.digest('hex'), expected);
    await assert.rejects(callback(pixels.subarray(0, 1), 1, { startUs: 1, endUs: 2 }), /extent/);
  });

  it('rejects ticket, ordering, noncanonical data and truncation while retaining rows', async () => {
    const output = await mkdtemp(join(tmpdir(), 'wmc-v8-stream-'));
    try {
      const receiver = new V8IncrementalHashReceiver(output, 'candidate');
      const begin: V8HashMessage = {
        kind: 'begin',
        index: 0,
        frameNum: 0,
        startUs: 0,
        endUs: 33_333,
      };
      await receiver.consume(begin);
      await assert.rejects(receiver.consume(begin), /overlap/);
      await assert.rejects(receiver.consume({ kind: 'end', index: 0 }), /truncated/);
      await assert.rejects(
        receiver.consume({ kind: 'chunk', index: 1, offset: 0, base64: 'AA==' }),
        /ticket/
      );
      const full = Buffer.alloc(V8_CAPTURE_CHUNK, 41);
      const fullBase64 = full.toString('base64');
      assert(fullBase64.endsWith('Q=='));
      await assert.rejects(
        receiver.consume({ kind: 'chunk', index: 0, offset: 1, base64: fullBase64 }),
        /offset/
      );
      await assert.rejects(
        receiver.consume({
          kind: 'chunk',
          index: 0,
          offset: 0,
          base64: `${fullBase64.slice(0, -1)}\n`,
        }),
        /before decode/
      );
      await assert.rejects(
        receiver.consume({ kind: 'chunk', index: 0, offset: 0, base64: 'A'.repeat(87_384) }),
        /before decode/
      );
      await assert.rejects(
        receiver.consume({
          kind: 'chunk',
          index: 0,
          offset: 0,
          base64: fullBase64.replace(/Q==$/, 'R=='),
        }),
        /noncanonical/
      );
      const hash = createHash('sha256');
      for (let offset = 0; offset < V8_RGB_BYTES; offset += V8_CAPTURE_CHUNK) {
        const bytes = full.subarray(0, Math.min(V8_CAPTURE_CHUNK, V8_RGB_BYTES - offset));
        hash.update(bytes);
        await receiver.consume({
          kind: 'chunk',
          index: 0,
          offset,
          base64: bytes.toString('base64'),
        });
      }
      assert.deepEqual(receiver.snapshot().active, { index: 0, offset: V8_RGB_BYTES });
      await receiver.consume({ kind: 'end', index: 0 });
      assert.equal(receiver.snapshot().active, null);
      const rows = receiver.snapshot().rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.sha256, hash.digest('hex'));
      assert.equal(rows[0]!.chunks, 95);
      await assert.rejects(receiver.consume({ kind: 'end', index: 0 }), /ticket/);
      await assert.rejects(
        receiver.consume({ ...begin, index: 1, frameNum: 0, startUs: 0 }),
        /order/
      );
      await receiver.consume({
        kind: 'begin',
        index: 1,
        frameNum: 2,
        startUs: 33_333,
        endUs: 66_666,
      });
      for (let offset = 0; offset < V8_RGB_BYTES; offset += V8_CAPTURE_CHUNK) {
        const bytes = full.subarray(0, Math.min(V8_CAPTURE_CHUNK, V8_RGB_BYTES - offset));
        await receiver.consume({
          kind: 'chunk',
          index: 1,
          offset,
          base64: bytes.toString('base64'),
        });
      }
      await receiver.consume({ kind: 'end', index: 1 });
      assert.deepEqual(await readdir(output), ['owned-vp8-v8-all-input-candidate.jsonl']);
      const lines = (await readFile(join(output, 'owned-vp8-v8-all-input-candidate.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.deepEqual(lines, receiver.snapshot().rows);
      assert.throws(() => receiver.complete(), /count/);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it('compares all 77 hashes, decoder counters and presentation intervals', () => {
    const rows: V8StreamedHashRow[] = Array.from({ length: 77 }, (_, index) => ({
      index,
      frameNum: index * 2,
      startUs: index * 83_333,
      endUs: (index + 1) * 83_333,
      logicalRgbBytes: V8_RGB_BYTES,
      chunks: 95,
      sha256: 'a'.repeat(64),
    }));
    const candidate = rows.map((row) => ({ ...row }));
    candidate[19]!.sha256 = 'b'.repeat(64);
    candidate[38]!.frameNum++;
    candidate[57]!.startUs++;
    const comparison = compareV8StreamedHashes(rows, candidate);
    assert.deepEqual(
      comparison
        .filter((entry) => !entry.samePixels || !entry.sameFrameNum || !entry.samePresentation)
        .map((entry) => entry.index),
      [19, 38, 57]
    );
    assert.throws(() => compareV8StreamedHashes(rows.slice(0, -1), candidate), /76 !== 77/);
  });
});
