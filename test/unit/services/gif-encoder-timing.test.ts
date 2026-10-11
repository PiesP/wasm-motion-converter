// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  quantize: vi.fn<(rgba: Uint8Array) => number[][]>(),
  skipSecond: true,
  timedFrames: null as Array<{ startUs: number; endUs: number; color: number }> | null,
  presentationEndUs: 0,
  writeFrame: vi.fn(),
}));

vi.mock('gifenc', () => ({
  applyPalette: () => new Uint8Array([0]),
  GIFEncoder: () => ({
    bytes: () => new Uint8Array(64),
    bytesView: () => new Uint8Array(0),
    finish: vi.fn(),
    stream: {
      buffer: new ArrayBuffer(4096),
      writeByte: vi.fn(),
      writeBytes: vi.fn(),
      writeBytesView: vi.fn(),
    },
    writeFrame: mocks.writeFrame,
  }),
  quantize: mocks.quantize,
}));
vi.mock('@services/decoder-service', () => ({
  decodeFrames: vi.fn().mockImplementation(async (_demux, options) => {
    if (mocks.timedFrames) {
      for (const [index, frame] of mocks.timedFrames.entries()) {
        await options.onFrameAvailable(
          new Uint8Array([frame.color, frame.color, frame.color, 255]),
          (frame.endUs - frame.startUs) / 1000,
          index,
          undefined,
          { startUs: frame.startUs, endUs: frame.endUs }
        );
      }
      return {
        frames: [],
        outputTotalMs: 0,
        skippedByDecimation: 0,
        smartSkipped: 0,
        sourceTotalMs: mocks.presentationEndUs / 1000,
        tailAccumulatedMs: 0,
        totalInputFrames: mocks.timedFrames.length,
        presentationEndUs: mocks.presentationEndUs,
      };
    }
    await options.onFrameAvailable(new Uint8Array([1, 1, 1, 255]), 100, 0, undefined, { startUs: 0, endUs: 100_000 });
    await options.onFrameAvailable(new Uint8Array([2, 2, 2, 255]), 40, 1, undefined, { startUs: 100_000, endUs: 140_000 });
    return {
      frames: [],
      outputTotalMs: 0,
      skippedByDecimation: 0,
      smartSkipped: 0,
      sourceTotalMs: 200,
      tailAccumulatedMs: 0,
      presentationEndUs: 200_000,
      totalInputFrames: 2,
    };
  }),
}));
vi.mock('@services/dynamic-decimation-controller', () => ({
  createDynamicDecimationController: () => ({
    getSkipCount: () => 1,
    shouldSkip: (frameNumber: number) => mocks.skipSecond && frameNumber === 1,
  }),
}));

import { encodeGif } from '@services/gif-encoder-service';

beforeEach(() => {
  mocks.quantize.mockReset().mockImplementation((rgba) => [[rgba[0]!, rgba[1]!, rgba[2]!]]);
  mocks.skipSecond = true;
  mocks.timedFrames = null;
  mocks.presentationEndUs = 0;
  mocks.writeFrame.mockClear();
});

describe('encodeGif timing', () => {
  it('combines decoder and dynamic-decimation trailing duration', async () => {
    const onFrameEncoded = vi.fn();
    const onEncodingComplete = vi.fn();
    await encodeGif(
      {
        chunks: [],
        config: { codec: 'vp09.00.10.08', codedWidth: 1, codedHeight: 1 },
        duration: 0.2,
        framerate: 30,
        sourceTotalMs: 200,
        totalFrames: 2,
      },
      {
        width: 1,
        height: 1,
        quality: 'low',
        scale: 1,
        onFrameEncoded,
        onEncodingComplete,
      }
    );

    expect(mocks.writeFrame).toHaveBeenCalledOnce();
    expect(mocks.writeFrame).toHaveBeenLastCalledWith(
      expect.any(Uint8Array),
      1,
      1,
      expect.objectContaining({ delay: 200 })
    );
    expect(mocks.writeFrame.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({ palette: [[1, 1, 1]] })
    );
    expect(onFrameEncoded).toHaveBeenCalledWith(1, expect.any(Number));
    expect(onEncodingComplete).toHaveBeenCalledWith({ decodedFrames: 2, encodedFrames: 1 });
  });

  it('writes each changed frame with the source tail included in its hold', async () => {
    mocks.skipSecond = false;

    await encodeGif(
      {
        chunks: [],
        config: { codec: 'vp09.00.10.08', codedWidth: 1, codedHeight: 1 },
        duration: 0.2,
        framerate: 30,
        sourceTotalMs: 200,
        totalFrames: 2,
      },
      { width: 1, height: 1, quality: 'low', scale: 1 }
    );

    expect(mocks.quantize).toHaveBeenCalledTimes(2);
    expect(mocks.writeFrame.mock.calls.map((call) => call[3]?.palette)).toEqual([
      [[1, 1, 1]],
      [[2, 2, 2]],
    ]);
    expect(mocks.writeFrame.mock.calls.map((call) => call[3]?.delay)).toEqual([100, 100]);
  });

  it('holds a selected source frame until the next actual encoded frame', async () => {
    mocks.skipSecond = false;
    mocks.timedFrames = [
      { startUs: 0, endUs: 100_000, color: 1 },
      { startUs: 300_000, endUs: 400_000, color: 2 },
    ];
    mocks.presentationEndUs = 400_000;

    await encodeGif(
      {
        chunks: [],
        config: { codec: 'vp09.00.10.08', codedWidth: 1, codedHeight: 1 },
        duration: 0.4,
        framerate: 10,
        sourceTotalMs: 400,
        totalFrames: 4,
      },
      { width: 1, height: 1, quality: 'low', scale: 1 }
    );

    expect(mocks.writeFrame.mock.calls.map((call) => call[3]?.delay)).toEqual([300, 100]);
    expect(mocks.writeFrame.mock.calls.map((call) => call[3]?.palette)).toEqual([
      [[1, 1, 1]],
      [[2, 2, 2]],
    ]);
  });

  it('quantizes many short source intervals cumulatively without duration inflation', async () => {
    mocks.skipSecond = false;
    mocks.timedFrames = Array.from({ length: 120 }, (_, index) => ({
      startUs: Math.round((index * 1_000_000) / 120),
      endUs: Math.round(((index + 1) * 1_000_000) / 120),
      color: index + 1,
    }));
    mocks.presentationEndUs = 1_000_000;

    await encodeGif(
      {
        chunks: [],
        config: { codec: 'vp09.00.10.08', codedWidth: 1, codedHeight: 1 },
        duration: 1,
        framerate: 120,
        sourceTotalMs: 1000,
        totalFrames: 120,
      },
      { width: 1, height: 1, quality: 'low', scale: 1 }
    );

    const delays = mocks.writeFrame.mock.calls.map((call) => call[3]?.delay as number);
    expect(delays.length).toBeLessThanOrEqual(100);
    expect(delays.reduce((total, delay) => total + delay, 0)).toBe(1000);
    expect(delays.every((delay) => delay >= 10)).toBe(true);
  });

  it('splits a long final hold within the configured GIF frame-delay limit', async () => {
    mocks.timedFrames = [{ startUs: 0, endUs: 5_000_000, color: 1 }];
    mocks.presentationEndUs = 5_000_000;

    await encodeGif(
      {
        chunks: [],
        config: { codec: 'vp09.00.10.08', codedWidth: 1, codedHeight: 1 },
        duration: 5,
        framerate: 1,
        sourceTotalMs: 5000,
        totalFrames: 1,
      },
      { width: 1, height: 1, quality: 'low', scale: 1 }
    );

    expect(mocks.writeFrame.mock.calls.map((call) => call[3]?.delay)).toEqual([
      2000,
      2000,
      1000,
    ]);
  });

  it('applies the 20 ms viewer floor only to a whole clip shorter than 20 ms', async () => {
    mocks.timedFrames = [{ startUs: 0, endUs: 12_000, color: 1 }];
    mocks.presentationEndUs = 12_000;

    await encodeGif(
      {
        chunks: [],
        config: { codec: 'vp09.00.10.08', codedWidth: 1, codedHeight: 1 },
        duration: 0.012,
        framerate: 120,
        sourceTotalMs: 12,
        totalFrames: 1,
      },
      { width: 1, height: 1, quality: 'low', scale: 1 }
    );

    expect(mocks.writeFrame.mock.calls.map((call) => call[3]?.delay)).toEqual([20]);
  });
});
