// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { readFileSync } from 'node:fs';

import { globalBufferPool } from '@services/buffer-pool';
import type { DecodeOptions } from '@services/decoder-service';
import { OwnedVp8Encoder } from '@services/owned-vp8-core';
import { encodeWebpOwned } from '@services/webp-encoder-service';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  decodeOptions: null as DecodeOptions | null,
}));

vi.mock('@services/decoder-service', () => ({
  decodeFrames: vi.fn().mockImplementation(async (_demux, options: DecodeOptions) => {
    mocks.decodeOptions = options;
    const budget = options.frameMemoryBudget;
    if (!budget) throw new Error('The selected route did not reserve frame memory');
    const target = await budget.acquireTarget();
    const handoff = budget.createHandoff(target);
    const pixels = globalBufferPool.acquire(3);
    pixels.set([16, 64, 192]);
    try {
      options.onFrameDecoded?.(1, 1);
      await options.onFrameAvailable(pixels, 100, 0, handoff, {
        startUs: 0,
        endUs: 100_000,
      });
      expect(handoff.isTaken).toBe(true);
      expect(target.isReleased).toBe(true);
    } finally {
      if (!handoff.isTaken) target.release();
    }
    return {
      outputTotalMs: 0,
      skippedByDecimation: 0,
      smartSkipped: 0,
      sourceTotalMs: 175,
      tailAccumulatedMs: 0,
      presentationEndUs: 175_000,
      totalInputFrames: 1,
      consumedChunks: 3,
      selectedFrames: 1,
    };
  }),
}));
vi.mock('@services/dynamic-decimation-controller', () => ({
  createDynamicDecimationController: () => ({
    getSkipCount: () => 0,
    shouldSkip: () => false,
  }),
}));
const wasmUrl = new URL('../../../crates/owned-vp8/owned-vp8.wasm', import.meta.url);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalBufferPool.clear();
});

describe('encodeWebpOwned timing', () => {
  it('finalizes the last hold at the visible source endpoint', async () => {
    vi.stubGlobal('fetch', async (input: string | URL) => {
      expect(String(input)).toBe(wasmUrl.href);
      return new Response(readFileSync(wasmUrl), {
        headers: { 'content-type': 'application/wasm' },
      });
    });
    const encode = vi.spyOn(OwnedVp8Encoder.prototype, 'encode');
    const onFrameDecoded = vi.fn();
    const onFrameEncoded = vi.fn();
    const onEncodingComplete = vi.fn();
    const output = await encodeWebpOwned(
      {
        chunks: [],
        config: { codec: 'vp09.00.10.08', codedWidth: 1, codedHeight: 1 },
        duration: 0.175,
        framerate: 30,
        sourceTotalMs: 175,
        totalFrames: 1,
      },
      {
        width: 1,
        height: 1,
        quality: 'medium',
        scale: 1,
        frameDecimation: 1.05,
        minimumSourceFrameGap: 2,
        pressureCadenceRatio: 1.4,
        onFrameDecoded,
        onFrameEncoded,
        onEncodingComplete,
      }
    );

    const holds: number[] = [];
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    for (let offset = 12; offset < output.length;) {
      const size = view.getUint32(offset + 4, true);
      if (view.getUint32(offset) === 0x414e4d46)
        holds.push(view.getUint32(offset + 20, true) & 0x00ff_ffff);
      offset += 8 + size + (size & 1);
    }
    expect(holds).toEqual([175]);
    expect(encode).toHaveBeenCalledExactlyOnceWith(
      new Uint8Array([16, 64, 192]),
      expect.objectContaining({ width: 1, height: 1, stride: 3, layout: 4, quality: 75 }),
      expect.any(Function)
    );
    expect(mocks.decodeOptions).not.toHaveProperty('maxInputChunks');
    expect(mocks.decodeOptions).toEqual(
      expect.objectContaining({
        pixelFormat: 'rgb',
        stagedCopyLookahead: false,
        frameDecimation: 1.05,
        minimumSourceFrameGap: 2,
        pressureCadenceRatio: 1.4,
      })
    );
    expect(onFrameDecoded).toHaveBeenCalledWith(1, 1);
    expect(onFrameEncoded).toHaveBeenCalledWith(1, 1);
    expect(onEncodingComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        consumedChunks: 3,
        decodedFrames: 1,
        selectedFrames: 1,
        encodedFrames: 1,
        emittedFrames: 1,
        ownedVp8Frames: 1,
      })
    );
  });
});
