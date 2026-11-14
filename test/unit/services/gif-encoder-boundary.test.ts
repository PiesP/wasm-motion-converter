// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  applyInputs: [] as Array<Uint8Array | Uint8ClampedArray>,
  applyResults: [] as Uint8Array[],
  frameFactory: (): Uint8Array => new Uint8Array(),
  pixelFormats: [] as Array<string | undefined>,
  quantizeInputs: [] as Array<Uint8Array | Uint8ClampedArray>,
  writeInputs: [] as Uint8Array[],
}));

vi.mock('@services/decoder-service', () => ({
  decodeFrames: vi.fn().mockImplementation(async (_demux, options) => {
    mocks.pixelFormats.push(options.pixelFormat);
    await options.onFrameAvailable(mocks.frameFactory(), 100, 0, undefined, {
      startUs: 0,
      endUs: 100_000,
    });
    return {
      outputTotalMs: 0,
      skippedByDecimation: 0,
      smartSkipped: 0,
      sourceTotalMs: 140,
      tailAccumulatedMs: 0,
      presentationEndUs: 140_000,
      totalInputFrames: 1,
    };
  }),
}));

vi.mock('@services/dynamic-decimation-controller', () => ({
  createDynamicDecimationController: () => ({
    getSkipCount: () => 0,
    shouldSkip: () => false,
  }),
}));

vi.mock('@services/gif-scalar-wasm', async () => {
  const gifenc = await import('gifenc');
  return {
    createGifScalarQuantizer: async () => {
      let prepared = new Uint8Array();
      const quantize = (rgba: Uint8Array, colors: number) =>
        gifenc.quantize(rgba, colors, { format: 'rgb565' });
      return Object.assign(quantize, {
        prepare: (rgba: Uint8Array) => {
          prepared = rgba.slice();
        },
        quantizePrepared: (colors: number) => {
          mocks.quantizeInputs.push(prepared);
          return quantize(prepared, colors);
        },
        mapPalette: (_rgba: Uint8Array, palette: number[][]) => {
          mocks.applyInputs.push(prepared);
          const result = gifenc.applyPalette(prepared, palette, 'rgb565');
          mocks.applyResults.push(result);
          return result;
        },
        compress: (indices: Uint8Array, depth: number) => {
          mocks.writeInputs.push(indices);
          const palette = Array.from({ length: 1 << depth }, (_, index) => [index, index, index]);
          const encoder = gifenc.GIFEncoder({ auto: true });
          encoder.writeFrame(indices, indices.byteLength, 1, {
            palette,
            colorDepth: depth,
            repeat: 0,
            delay: 20,
          });
          encoder.finish();
          return encoder.bytes().subarray(6 + 7 + palette.length * 3 + 19 + 8 + 10, -1);
        },
      });
    },
  };
});

import { globalBufferPool } from '@services/buffer-pool';
import { encodeGif } from '@services/gif-encoder-service';

const width = 3;
const height = 2;
const exactRgbaBytes = width * height * 4;
const validPixels = new Uint8Array([
  255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255, 0, 255, 255, 255, 255, 0, 255,
  255,
]);

const demux = {
  chunks: [],
  config: { codec: 'vp09.00.10.08', codedWidth: width, codedHeight: height },
  duration: 0.14,
  framerate: 10,
  sourceTotalMs: 140,
  totalFrames: 1,
};

beforeEach(() => {
  mocks.applyInputs.length = 0;
  mocks.applyResults.length = 0;
  mocks.quantizeInputs.length = 0;
  mocks.writeInputs.length = 0;
  mocks.pixelFormats.length = 0;
  globalBufferPool.clear();
});

afterEach(() => {
  globalBufferPool.clear();
});

describe('GIF exact pixel boundaries', () => {
  it('ignores poisoned pooled tail bytes and writes exact mapped indices directly', async () => {
    mocks.frameFactory = () => validPixels.slice();
    const cleanOutput = await encodeGif(demux, {
      height,
      quality: 'low',
      scale: 1,
      width,
    });

    mocks.applyInputs.length = 0;
    mocks.applyResults.length = 0;
    mocks.quantizeInputs.length = 0;
    mocks.writeInputs.length = 0;
    const memoryChecks: number[] = [];
    mocks.frameFactory = () => {
      const pooledBacking = new Uint8Array(32);
      pooledBacking.set(validPixels);
      pooledBacking.fill(0x7f, exactRgbaBytes);
      return pooledBacking;
    };
    const poisonedOutput = await encodeGif(demux, {
      assertAdditionalMemoryBytes: (bytes) => memoryChecks.push(bytes),
      height,
      quality: 'low',
      scale: 1,
      width,
    });

    expect(poisonedOutput).toEqual(cleanOutput);
    expect(mocks.pixelFormats).toEqual(['rgba', 'rgba']);
    expect(mocks.quantizeInputs).toHaveLength(1);
    expect(mocks.applyInputs).toHaveLength(1);
    for (const input of [...mocks.quantizeInputs, ...mocks.applyInputs]) {
      expect(input.byteLength).toBe(exactRgbaBytes);
      expect(input.buffer.byteLength).toBe(exactRgbaBytes);
      expect(input).toEqual(validPixels);
    }
    expect(mocks.applyResults[0]?.byteLength).toBe(width * height);
    expect(mocks.applyResults[0]?.buffer.byteLength).toBe(width * height);
    expect(mocks.writeInputs).toHaveLength(1);
    expect(mocks.writeInputs[0]).toBe(mocks.applyResults[0]);
    expect(memoryChecks.some((bytes) => bytes >= 4096 + width * height)).toBe(true);
  });
});
