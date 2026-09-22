// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  quantize: vi.fn<(rgba: Uint8Array) => number[][]>(),
  skipSecond: true,
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
    await options.onFrameAvailable(new Uint8Array([1, 1, 1, 255]), 100, 0);
    await options.onFrameAvailable(new Uint8Array([2, 2, 2, 255]), 40, 1);
    return {
      frames: [],
      outputTotalMs: 0,
      skippedByDecimation: 0,
      smartSkipped: 0,
      sourceTotalMs: 200,
      tailAccumulatedMs: 60,
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

    expect(mocks.writeFrame).toHaveBeenLastCalledWith(
      expect.any(Uint8Array),
      1,
      1,
      expect.objectContaining({ delay: 100 })
    );
    expect(mocks.writeFrame.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({ palette: [[1, 1, 1]] })
    );
    expect(mocks.writeFrame.mock.calls[1]?.[3]).toEqual(
      expect.objectContaining({ palette: [[1, 1, 1]] })
    );
    expect(onFrameEncoded).toHaveBeenCalledWith(1, expect.any(Number));
    expect(onEncodingComplete).toHaveBeenCalledWith({ decodedFrames: 2, encodedFrames: 1 });
  });

  it('writes a local palette for each changed frame and retains the last palette for tail delay', async () => {
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
      [[2, 2, 2]],
    ]);
  });
});
