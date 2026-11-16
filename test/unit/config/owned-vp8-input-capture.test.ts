// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { describe, it } from 'vite-plus/test';

import {
  assertCaptureInventory,
  assertV8CaptureBuild,
  captureIndex,
  compareCapturedPixels,
  V8_CAPTURE_BUDGET,
  V8_CAPTURE_CHUNK,
  V8_CAPTURE_INDICES,
  V8_RGB_BYTES,
  V8_LEGACY_COPY_BYTES,
  installV8PixelCapture,
  type CapturedPixel,
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
