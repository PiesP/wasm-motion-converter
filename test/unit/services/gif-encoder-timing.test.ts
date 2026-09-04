// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
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
  quantize: () => [[0, 0, 0]],
}));
vi.mock('@services/decoder-service', () => ({
  decodeFrames: vi.fn().mockImplementation(async (_demux, options) => {
    await options.onFrameAvailable(new Uint8Array([1, 1, 1]), 100, 0);
    await options.onFrameAvailable(new Uint8Array([2, 2, 2]), 40, 1);
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
    shouldSkip: (frameNumber: number) => frameNumber === 1,
  }),
}));

import { encodeGif } from '@services/gif-encoder-service';

beforeEach(() => {
  mocks.writeFrame.mockClear();
});

describe('encodeGif timing', () => {
  it('combines decoder and dynamic-decimation trailing duration', async () => {
    const onFrameEncoded = vi.fn();
    await encodeGif(
      {
        chunks: [],
        config: { codec: 'vp09.00.10.08', codedWidth: 1, codedHeight: 1 },
        duration: 0.2,
        framerate: 30,
        sourceTotalMs: 200,
        totalFrames: 2,
      },
      { width: 1, height: 1, quality: 'low', scale: 1, onFrameEncoded }
    );

    expect(mocks.writeFrame).toHaveBeenLastCalledWith(
      expect.any(Uint8Array),
      1,
      1,
      expect.objectContaining({ delay: 100 })
    );
    expect(mocks.writeFrame.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({ palette: [[0, 0, 0]] })
    );
    for (const call of mocks.writeFrame.mock.calls.slice(1)) {
      expect(call[3]).not.toHaveProperty('palette');
    }
    expect(onFrameEncoded).toHaveBeenCalledWith(1, expect.any(Number));
  });
});
