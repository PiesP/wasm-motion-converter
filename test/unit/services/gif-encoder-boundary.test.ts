// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  frameFactory: (): Uint8Array => new Uint8Array(),
  pixelFormats: [] as Array<string | undefined>,
  quantizeInputs: [] as Array<Uint8Array | Uint8ClampedArray>,
  quantizeResults: [] as number[][][],
  writeInputs: [] as Uint8Array[],
}));

vi.mock('@services/decoder-service', () => ({
  decodeFrames: vi.fn().mockImplementation(async (_demux, options) => {
    mocks.pixelFormats.push(options.pixelFormat);
    await options.onFrameAvailable(mocks.frameFactory(), 100, 0);
    return {
      frames: [],
      outputTotalMs: 0,
      skippedByDecimation: 0,
      smartSkipped: 0,
      sourceTotalMs: 140,
      tailAccumulatedMs: 40,
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

vi.mock('gifenc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gifenc')>();
  return {
    ...actual,
    GIFEncoder: (...args: Parameters<typeof actual.GIFEncoder>) => {
      const encoder = actual.GIFEncoder(...args);
      const writeFrame = encoder.writeFrame.bind(encoder);
      encoder.writeFrame = ((indexed: Uint8Array, ...writeArgs: unknown[]) => {
        mocks.writeInputs.push(indexed);
        return writeFrame(indexed, ...(writeArgs as [number, number, object | undefined]));
      }) as typeof encoder.writeFrame;
      return encoder;
    },
    quantize: (...args: Parameters<typeof actual.quantize>) => {
      mocks.quantizeInputs.push(args[0]);
      const result = actual.quantize(...args);
      mocks.quantizeResults.push(result);
      return result;
    },
  };
});

import { globalBufferPool } from '@services/buffer-pool';
import { encodeGif } from '@services/gif-encoder-service';
import { GIF_RGB565_PALETTE_CACHE_BYTES } from '@services/gif-rgb565-palette-indexer';
import { applyPalette } from 'gifenc';

const width = 3;
const height = 2;
const exactRgbaBytes = width * height * 4;
const validPixels = new Uint8Array([
  255, 0, 0, 255,
  0, 255, 0, 255,
  0, 0, 255, 255,
  255, 255, 0, 255,
  0, 255, 255, 255,
  255, 0, 255, 255,
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
  mocks.quantizeInputs.length = 0;
  mocks.quantizeResults.length = 0;
  mocks.writeInputs.length = 0;
  mocks.pixelFormats.length = 0;
  globalBufferPool.clear();
});

afterEach(() => {
  globalBufferPool.clear();
});

describe('GIF exact pixel boundaries', () => {
  it('ignores poisoned pooled tail bytes and writes exact palette indices directly', async () => {
    mocks.frameFactory = () => validPixels.slice();
    const cleanOutput = await encodeGif(demux, {
      height,
      quality: 'low',
      scale: 1,
      width,
    });

    mocks.quantizeInputs.length = 0;
    mocks.quantizeResults.length = 0;
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
    for (const input of mocks.quantizeInputs) {
      expect(input.byteLength).toBe(exactRgbaBytes);
      expect(input.buffer.byteLength).toBe(exactRgbaBytes);
      expect(input).toEqual(validPixels);
    }
    expect(mocks.writeInputs).toHaveLength(2);
    expect(mocks.writeInputs[0]).toEqual(
      applyPalette(validPixels, mocks.quantizeResults[0]!, 'rgb565')
    );
    expect(mocks.writeInputs[0]?.byteLength).toBe(width * height);
    expect(mocks.writeInputs[0]?.buffer.byteLength).toBe(width * height);
    expect(mocks.writeInputs[1]).toBe(mocks.writeInputs[0]);
    expect(
      memoryChecks.some(
        (bytes) =>
          bytes >=
          4096 + GIF_RGB565_PALETTE_CACHE_BYTES + exactRgbaBytes + width * height
      )
    ).toBe(true);
    expect(memoryChecks.at(-1)).toBeLessThan(GIF_RGB565_PALETTE_CACHE_BYTES);
  });
});
