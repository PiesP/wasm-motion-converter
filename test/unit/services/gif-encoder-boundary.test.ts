// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    applyPalette: (...args: Parameters<typeof actual.applyPalette>) => {
      mocks.applyInputs.push(args[0]);
      const result = actual.applyPalette(...args);
      mocks.applyResults.push(result);
      return result;
    },
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
      return actual.quantize(...args);
    },
  };
});

import { globalBufferPool } from '@services/buffer-pool';
import { encodeGif } from '@services/gif-encoder-service';

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
  it('ignores poisoned pooled tail bytes and writes applyPalette indices directly', async () => {
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
    expect(mocks.writeInputs).toHaveLength(2);
    expect(mocks.writeInputs[0]).toBe(mocks.applyResults[0]);
    expect(mocks.writeInputs[1]).toBe(mocks.applyResults[0]);
    expect(memoryChecks.some((bytes) => bytes >= 4096 + exactRgbaBytes + width * height)).toBe(
      true
    );
  });
});
