// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    allocations: [] as number[],
    bytesWrittenPerFrame: 16,
    capacity: 0,
    cursor: 0,
    frameCount: 2,
  };
  let stream: {
    readonly buffer: { byteLength: number };
    writeByte: (byte: number) => void;
    writeBytes: (bytes: Uint8Array, offset?: number, length?: number) => void;
    writeBytesView: (bytes: Uint8Array, offset?: number, length?: number) => void;
  };
  const writeFrame = vi.fn(() => {
    stream.writeBytesView(new Uint8Array(state.bytesWrittenPerFrame));
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
  GIFEncoder: ({ initialCapacity = 256 } = {}) => {
    mocks.state.capacity = initialCapacity;
    mocks.state.allocations.push(initialCapacity);
    const write = (length: number) => {
      const requiredCapacity = mocks.state.cursor + length;
      if (requiredCapacity > mocks.state.capacity) {
        const growth =
          mocks.state.capacity < 1024 * 1024
            ? mocks.state.capacity * 2
            : Math.floor(mocks.state.capacity * 1.125);
        mocks.state.capacity = Math.max(requiredCapacity, growth, 256);
        mocks.state.allocations.push(mocks.state.capacity);
      }
      mocks.state.cursor = requiredCapacity;
    };
    mocks.stream = {
      get buffer() {
        return { byteLength: mocks.state.capacity };
      },
      writeByte: () => {
        write(1);
      },
      writeBytes: (bytes: Uint8Array, _offset?: number, length?: number) => {
        write(length ?? bytes.length);
      },
      writeBytesView: (bytes: Uint8Array, _offset?: number, length?: number) => {
        write(length ?? bytes.byteLength);
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
  mocks.state.allocations = [];
  mocks.state.bytesWrittenPerFrame = 16;
  mocks.state.capacity = 0;
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

  it('rejects geometric capacity growth before allocating old and new buffers over budget', async () => {
    mocks.state.frameCount = 1;
    mocks.state.bytesWrittenPerFrame = 5000;

    await expect(
      encodeGif(demux, {
        width: 1,
        height: 1,
        quality: 'low',
        scale: 1,
        maxFrames: 1,
        maxOutputBytes: 10_000,
      })
    ).rejects.toThrow('GIF output byte limit exceeded');

    expect(mocks.state.allocations).toEqual([4096]);
    expect(mocks.state.cursor).toBe(0);
  });

  it('reports the GIF growth peak to the aggregate worker memory guard', async () => {
    mocks.state.frameCount = 1;
    mocks.state.bytesWrittenPerFrame = 5000;
    const assertAdditionalMemoryBytes = vi.fn((additionalBytes: number) => {
      if (additionalBytes > 10_000) throw new Error('aggregate memory limit exceeded');
    });

    await expect(
      encodeGif(demux, {
        width: 1,
        height: 1,
        quality: 'low',
        scale: 1,
        maxFrames: 1,
        maxOutputBytes: 20_000,
        assertAdditionalMemoryBytes,
      })
    ).rejects.toThrow('aggregate memory limit exceeded');

    expect(assertAdditionalMemoryBytes).toHaveBeenLastCalledWith(12_288);
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
      maxOutputBytes: 8192,
    });

    expect(output).toHaveLength(17);
    expect(mocks.writeFrame).toHaveBeenCalledOnce();
  });
});
