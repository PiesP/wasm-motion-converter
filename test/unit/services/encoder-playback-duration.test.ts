// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { readFileSync } from 'node:fs';

import { globalBufferPool } from '@services/buffer-pool';
import type { DecodeOptions } from '@services/decoder-service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('@services/decoder-service', () => ({
  decodeFrames: vi.fn().mockImplementation(async (_demux, options: DecodeOptions) => {
    for (const [index, startUs, endUs, color] of [
      [0, 0, 100_000, [0x20, 0x40, 0x60]],
      [1, 100_000, 140_000, [0x30, 0x50, 0x70]],
    ] as const) {
      const budget = options.frameMemoryBudget;
      const target = await budget?.acquireTarget();
      const handoff = target && budget?.createHandoff(target);
      const pixels = globalBufferPool.acquire(options.pixelFormat === 'rgba' ? 4 : 3);
      pixels.set(color);
      if (options.pixelFormat === 'rgba') pixels[3] = 0xff;
      try {
        await options.onFrameAvailable(pixels, (endUs - startUs) / 1000, index, handoff, {
          startUs,
          endUs,
        });
      } finally {
        if (target && !handoff?.isTaken) target.release();
      }
      if (target) expect(target.isReleased).toBe(true);
    }
    return {
      outputTotalMs: 0,
      skippedByDecimation: 0,
      smartSkipped: 0,
      sourceTotalMs: 200,
      tailAccumulatedMs: 0,
      totalInputFrames: 2,
      presentationEndUs: 200000,
      consumedChunks: 2,
      decodedFrames: 2,
      selectedFrames: 2,
    };
  }),
}));

vi.mock('@services/dynamic-decimation-controller', () => ({
  createDynamicDecimationController: () => ({
    getSkipCount: () => 1,
    shouldSkip: (frameNumber: number) => frameNumber === 1,
  }),
}));

import { encodeGif } from '@services/gif-encoder-service';
import { encodeWebpOwned } from '@services/webp-encoder-service';

const modules = new Map(
  [
    new URL('../../../src/services/gif-scalar-quantizer.wasm', import.meta.url),
    new URL('../../../crates/owned-vp8/owned-vp8.wasm', import.meta.url),
  ].map((url) => [url.href, readFileSync(url)])
);

beforeEach(() => {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const bytes = modules.get(String(input));
    if (!bytes) throw new Error(`Unexpected WASM request: ${input}`);
    return new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/wasm' },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalBufferPool.clear();
});

const demux = {
  chunks: [],
  config: { codec: 'vp09.00.10.08', codedWidth: 1, codedHeight: 1 },
  duration: 0.2,
  framerate: 30,
  sourceTotalMs: 200,
  totalFrames: 2,
};

function readGifDurationMs(output: Uint8Array): number {
  let totalCentiseconds = 0;
  for (let offset = 0; offset + 7 < output.length; offset++) {
    if (output[offset] === 0x21 && output[offset + 1] === 0xf9 && output[offset + 2] === 0x04) {
      totalCentiseconds += output[offset + 4]! | (output[offset + 5]! << 8);
    }
  }
  return totalCentiseconds * 10;
}

function readWebpDurationMs(output: Uint8Array): number {
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  let totalMilliseconds = 0;
  for (let offset = 12; offset < output.length;) {
    const size = view.getUint32(offset + 4, true);
    if (view.getUint32(offset) === 0x414e4d46)
      totalMilliseconds += view.getUint32(offset + 20, true) & 0x00ff_ffff;
    offset += 8 + size + (size & 1);
  }
  return totalMilliseconds;
}

describe('encoder final playback duration', () => {
  it('preserves decoder and dynamic-decimation tails in the GIF container', async () => {
    const output = await encodeGif(demux, {
      height: 1,
      quality: 'low',
      scale: 1,
      width: 1,
    });

    expect(readGifDurationMs(output)).toBe(200);
  });

  it('preserves decoder and dynamic-decimation tails in the WebP container', async () => {
    const onProgress = vi.fn();
    const onEncodingComplete = vi.fn();
    const output = await encodeWebpOwned(
      demux,
      {
        height: 1,
        quality: 'medium',
        scale: 1,
        width: 1,
        onEncodingComplete,
      },
      onProgress
    );

    expect(readWebpDurationMs(output)).toBe(200);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'encoding', currentFrame: 1, totalFrames: 2 })
    );
    expect(onEncodingComplete).toHaveBeenCalledWith(
      expect.objectContaining({ decodedFrames: 2, encodedFrames: 1 })
    );
  });
});
