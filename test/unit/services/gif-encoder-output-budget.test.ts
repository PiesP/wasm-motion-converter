// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    bytesWrittenPerFrame: 16,
    cursor: 0,
    frameCount: 2,
  };
  let stream: {
    writeByte: (byte: number) => void;
    writeBytes: (bytes: Uint8Array, offset?: number, length?: number) => void;
  };
  const writeFrame = vi.fn(() => {
    stream.writeBytes(new Uint8Array(state.bytesWrittenPerFrame));
  });
  return {
    state,
    get stream() {
      return stream;
    },
    set stream(value) {
      stream = value;
    },
    writeFrame,
  };
});

vi.mock('gifenc', () => ({
  applyPalette: () => new Uint8Array([0]),
  GIFEncoder: () => {
    mocks.stream = {
      writeByte: () => {
        mocks.state.cursor++;
      },
      writeBytes: (bytes: Uint8Array, _offset?: number, length?: number) => {
        mocks.state.cursor += length ?? bytes.length;
      },
    };
    return {
      bytes: () => new Uint8Array(mocks.state.cursor),
      bytesView: () => new Uint8Array(mocks.state.cursor),
      finish: () => mocks.stream.writeByte(0x3b),
      stream: mocks.stream,
      writeFrame: mocks.writeFrame,
    };
  },
  quantize: () => [[0, 0, 0]],
}));
vi.mock('@services/decoder-service', () => ({
  decodeFrames: vi.fn().mockImplementation(async (_demux, options) => {
    for (let frame = 0; frame < mocks.state.frameCount; frame++) {
      await options.onFrameAvailable(new Uint8Array([frame, frame, frame]), 100, frame);
    }
    return {
      frames: [],
      outputTotalMs: 0,
      skippedByDecimation: 0,
      smartSkipped: 0,
      sourceTotalMs: mocks.state.frameCount * 100,
      tailAccumulatedMs: 0,
      totalInputFrames: mocks.state.frameCount,
    };
  }),
}));
vi.mock('@services/dynamic-decimation-controller', () => ({
  createDynamicDecimationController: () => ({
    getSkipCount: () => 0,
    shouldSkip: () => false,
  }),
}));

import { encodeGif } from '@services/gif-encoder-service';

const demux = {
  chunks: [],
  config: { codec: 'vp09.00.10.08', codedWidth: 1, codedHeight: 1 },
  duration: 0.2,
  framerate: 30,
  sourceTotalMs: 200,
  totalFrames: 2,
};

beforeEach(() => {
  mocks.state.bytesWrittenPerFrame = 16;
  mocks.state.cursor = 0;
  mocks.state.frameCount = 2;
  mocks.writeFrame.mockClear();
});

describe('encodeGif output budgets', () => {
  it('rejects cumulative frame overflow before writing the frame', async () => {
    await expect(
      encodeGif(demux, {
        width: 1,
        height: 1,
        quality: 'low',
        scale: 1,
        maxFrames: 1,
        maxOutputBytes: 1024,
      })
    ).rejects.toThrow('GIF output frame limit exceeded');

    expect(mocks.writeFrame).toHaveBeenCalledOnce();
  });

  it('rejects cumulative byte overflow before the stream write', async () => {
    mocks.state.frameCount = 1;
    mocks.state.bytesWrittenPerFrame = 17;

    await expect(
      encodeGif(demux, {
        width: 1,
        height: 1,
        quality: 'low',
        scale: 1,
        maxFrames: 1,
        maxOutputBytes: 16,
      })
    ).rejects.toThrow('GIF output byte limit exceeded');

    expect(mocks.state.cursor).toBe(0);
  });

  it('allows ordinary output within both limits', async () => {
    mocks.state.frameCount = 1;

    const output = await encodeGif(demux, {
      width: 1,
      height: 1,
      quality: 'low',
      scale: 1,
      maxFrames: 1,
      maxOutputBytes: 32,
    });

    expect(output).toHaveLength(17);
    expect(mocks.writeFrame).toHaveBeenCalledOnce();
  });
});
