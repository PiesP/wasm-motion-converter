// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

export const V8_RGB_BYTES = 1920 * 1080 * 3;
export const V8_CAPTURE_INDICES = [0, 19, 38, 57, 76] as const;
export const V8_CAPTURE_BUDGET = 32 * 1024 * 1024;
export const V8_CAPTURE_CHUNK = 64 * 1024;
const EXPECTED_ENCODES = 77;

export function captureIndex(ordinal: number): boolean {
  return V8_CAPTURE_INDICES.includes(ordinal as (typeof V8_CAPTURE_INDICES)[number]);
}

/** Pure contract for the complete successful-encode stream, independent of ANMF coalescing. */
export function assertCaptureInventory(snapshot: {
  successfulEncodes: number;
  selected: Array<{ index: number; ticket: number; bytes: number }>;
  retainedBytes: number;
  error: string | null;
}): void {
  assert.equal(snapshot.error, null, `Pixel capture failed: ${snapshot.error}`);
  assert.equal(snapshot.successfulEncodes, EXPECTED_ENCODES, 'V8 successful encode count differs');
  assert.deepEqual(
    snapshot.selected.map((entry) => entry.index),
    V8_CAPTURE_INDICES,
    'Selected successful encode ordinals differ'
  );
  for (const entry of snapshot.selected) {
    assert.equal(entry.ticket, entry.index + 1, 'Selected frame ticket is stale');
    assert.equal(entry.bytes, V8_RGB_BYTES, 'Selected packed RGB extent differs');
  }
  assert(snapshot.retainedBytes <= V8_CAPTURE_BUDGET, 'Page copy budget exceeded');
  assert.equal(snapshot.retainedBytes, V8_CAPTURE_INDICES.length * V8_RGB_BYTES);
}

/** Installed before app code. It owns only five new host ArrayBuffers, never a WASM view. */
export function installV8PixelCapture(mode: 'prior' | 'candidate') {
  const width = 1920;
  const height = 1080;
  const stride = width * 3;
  const pixelBytes = stride * height;
  const selected = [0, 19, 38, 57, 76];
  const budget = 32 * 1024 * 1024;
  const frames = new Map<number, { ticket: number; bytes: Uint8Array }>();
  let successfulEncodes = 0;
  let retainedBytes = 0;
  let error: string | null = null;
  let generation: number | null = null;
  const fail = (reason: string): never => {
    error = reason;
    throw new Error(`V8 pixel capture: ${reason}`);
  };
  const validWord = (word: number) => Number.isSafeInteger(word) && word > 0;
  const save = (index: number, ticket: number, source: Uint8Array, alreadyOwned = false) => {
    if (!selected.includes(index)) return;
    if (ticket !== index + 1) fail('stale selected frame ticket');
    if (source.byteLength !== pixelBytes || retainedBytes + pixelBytes > budget)
      fail('selected pixel extent or copy budget differs');
    if (frames.has(index)) fail('duplicate selected frame');
    const copy = alreadyOwned ? source : new Uint8Array(source);
    frames.set(index, { ticket, bytes: copy });
    retainedBytes += copy.byteLength;
  };
  const state = {
    snapshot() {
      return {
        mode,
        successfulEncodes,
        selected: [...frames]
          .sort(([a], [b]) => a - b)
          .map(([index, frame]) => ({
            index,
            ticket: frame.ticket,
            bytes: frame.bytes.byteLength,
          })),
        retainedBytes,
        error,
      };
    },
    chunk(index: number, offset: number, length: number) {
      const frame = frames.get(index);
      if (
        !frame ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length <= 0 ||
        length > 64 * 1024 ||
        offset + length > frame.bytes.byteLength
      )
        return fail('invalid pixel stream extent');
      // At most 64 KiB raw becomes 87,384 base64 characters, plus the RPC envelope.
      const bytes = frame.bytes.subarray(offset, offset + length);
      let binary = '';
      for (let at = 0; at < bytes.length; at += 8192)
        binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
      return btoa(binary);
    },
    release(index: number) {
      const frame = frames.get(index);
      if (!frame) return fail('pixel frame already released');
      retainedBytes -= frame.bytes.byteLength;
      frames.delete(index);
    },
  };
  Reflect.set(globalThis, '__wmcV8PixelCapture', state);
  if (mode === 'prior') {
    Reflect.set(
      globalThis,
      '__wmcVp8LegacyCopy',
      (heap: Uint8Array, _unused: unknown, offset: number, count: number) => {
        // The pinned main loader calls this *after* its actual indexed copy loop.
        // Different-sized heap copies do not advance the frame ordinal.
        if (count !== pixelBytes) return;
        if (
          !(heap instanceof Uint8Array) ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset + count > heap.byteLength
        )
          fail('legacy RGB destination is invalid');
        const index = successfulEncodes++;
        save(index, index + 1, heap.subarray(offset, offset + count));
      }
    );
    return;
  }
  const NativeInstance = WebAssembly.Instance;
  WebAssembly.Instance = new Proxy(NativeInstance, {
    construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget);
      const exported = instance.exports as Record<string, unknown>;
      if (typeof exported.vp8_v2_begin !== 'function') return instance;
      const memory = exported.memory;
      const responsePointer = exported.vp8_v2_response_ptr;
      const requestPointer = exported.vp8_v2_request_ptr;
      if (
        !(memory instanceof WebAssembly.Memory) ||
        typeof responsePointer !== 'function' ||
        typeof requestPointer !== 'function'
      )
        return fail('owned ABI exports are absent');
      const wrapped = Object.fromEntries(
        Object.entries(exported).map(([key, value]) => [
          key,
          key === 'vp8_v2_begin' && typeof value === 'function'
            ? (...parameters: unknown[]) => {
                const buffer = memory.buffer;
                const responseAt = Reflect.apply(responsePointer, exported, []) as number;
                const requestAt = Reflect.apply(requestPointer, exported, []) as number;
                if (
                  !validWord(responseAt) ||
                  !validWord(requestAt) ||
                  responseAt + 96 > buffer.byteLength ||
                  requestAt + 48 > buffer.byteLength
                )
                  return fail('owned ABI record extent is invalid');
                const response = new DataView(buffer, responseAt, 96);
                const request = new DataView(buffer, requestAt, 48);
                const rw = (index: number) => response.getUint32(index * 4, true);
                const qw = (index: number) => request.getUint32(index * 4, true);
                const ticket = successfulEncodes + 1;
                if (
                  rw(0) !== 2 ||
                  rw(1) !== 0 ||
                  rw(2) !== 3 ||
                  rw(3) !== parameters[0] ||
                  rw(4) !== parameters[1] ||
                  !validWord(rw(3)) ||
                  rw(4) !== ticket ||
                  qw(0) !== 2 ||
                  qw(1) !== width ||
                  qw(2) !== height ||
                  qw(3) !== stride ||
                  qw(4) !== 4 ||
                  qw(5) !== 60 ||
                  qw(6) !== pixelBytes ||
                  qw(8) !== rw(3) ||
                  qw(9) !== ticket ||
                  rw(6) !== pixelBytes ||
                  !validWord(rw(5)) ||
                  rw(5) + rw(6) > buffer.byteLength ||
                  rw(9) !== buffer.byteLength
                )
                  return fail(
                    'owned input lease, request or ticket differs from frozen RGB contract'
                  );
                if (generation === null) generation = rw(3);
                else if (generation !== rw(3)) return fail('owned generation changed');
                const index = successfulEncodes;
                // Copy before begin mutates phase/lease. Publish only after success.
                const pending = selected.includes(index)
                  ? new Uint8Array(new Uint8Array(buffer, rw(5), pixelBytes))
                  : null;
                const status = Reflect.apply(value, exported, parameters) as number;
                if (status !== 10) return status;
                successfulEncodes++;
                if (pending) save(index, ticket, pending, true);
                return status;
              }
            : value,
        ])
      );
      return new Proxy(instance, {
        get(source, key) {
          return key === 'exports' ? wrapped : Reflect.get(source, key);
        },
      });
    },
  });
}

export type CapturedPixel = {
  index: number;
  ticket: number;
  file: string;
  bytes: number;
  sha256: string;
};

export function compareCapturedPixels(
  prior: readonly CapturedPixel[],
  candidate: readonly CapturedPixel[]
) {
  assert.deepEqual(
    prior.map((pixel) => pixel.index),
    V8_CAPTURE_INDICES,
    'Prior selected pixel indices differ'
  );
  assert.deepEqual(
    candidate.map((pixel) => pixel.index),
    V8_CAPTURE_INDICES,
    'Candidate selected pixel indices differ'
  );
  return prior.map((pixel, at) => ({
    index: pixel.index,
    priorSha256: pixel.sha256,
    candidateSha256: candidate[at]!.sha256,
    same: pixel.sha256 === candidate[at]!.sha256,
  }));
}

export async function streamCapturedRgb(
  page: Page,
  output: string,
  build: 'prior' | 'candidate'
): Promise<CapturedPixel[]> {
  const snapshot = (await page.evaluate(() => {
    const state = Reflect.get(globalThis, '__wmcV8PixelCapture') as {
      snapshot: () => Parameters<typeof assertCaptureInventory>[0];
    };
    return state.snapshot();
  })) as Parameters<typeof assertCaptureInventory>[0];
  assertCaptureInventory(snapshot);
  const result: CapturedPixel[] = [];
  for (const index of V8_CAPTURE_INDICES) {
    const file = `owned-vp8-v8-low-input-${build}-${String(index).padStart(2, '0')}.rgb`;
    const handle = await open(join(output, file), 'wx');
    const hash = createHash('sha256');
    try {
      for (let offset = 0; offset < V8_RGB_BYTES; offset += V8_CAPTURE_CHUNK) {
        const length = Math.min(V8_CAPTURE_CHUNK, V8_RGB_BYTES - offset);
        const base64 = await page.evaluate(
          ({ index, offset, length }) => {
            const state = Reflect.get(globalThis, '__wmcV8PixelCapture') as {
              chunk: (index: number, offset: number, length: number) => string;
            };
            return state.chunk(index, offset, length);
          },
          { index, offset, length }
        );
        const bytes = Buffer.from(base64, 'base64');
        assert(
          base64.length <= 4 * Math.ceil(length / 3) && bytes.toString('base64') === base64,
          'Pixel stream encoding is noncanonical or exceeds its encoded bound'
        );
        assert.equal(bytes.length, length, 'Pixel stream chunk changed size');
        const written = await handle.write(bytes, 0, bytes.length, offset);
        assert.equal(written.bytesWritten, length, 'Pixel stream write was short');
        hash.update(bytes);
      }
    } finally {
      await handle.close();
    }
    const expectedSha256 = hash.digest('hex');
    assert.equal((await stat(join(output, file))).size, V8_RGB_BYTES, 'Saved RGB size differs');
    const savedHash = createHash('sha256');
    for await (const bytes of createReadStream(join(output, file), {
      highWaterMark: V8_CAPTURE_CHUNK,
    }))
      savedHash.update(bytes);
    assert.equal(
      savedHash.digest('hex'),
      expectedSha256,
      'Saved RGB digest differs from page stream'
    );
    result.push({ index, ticket: index + 1, file, bytes: V8_RGB_BYTES, sha256: expectedSha256 });
    await page.evaluate((index) => {
      const state = Reflect.get(globalThis, '__wmcV8PixelCapture') as {
        release: (index: number) => void;
      };
      state.release(index);
    }, index);
  }
  const remaining = await page.evaluate(() => {
    const state = Reflect.get(globalThis, '__wmcV8PixelCapture') as {
      snapshot: () => { retainedBytes: number; selected: unknown[] };
    };
    return state.snapshot();
  });
  assert.equal(remaining.retainedBytes, 0, 'Pixel copies remained in page');
  assert.deepEqual(remaining.selected, [], 'Pixel frame references remained in page');
  return result;
}
