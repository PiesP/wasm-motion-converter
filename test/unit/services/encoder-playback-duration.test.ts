// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it, vi } from 'vitest';

vi.mock('@services/decoder-service', () => ({
  decodeFrames: vi.fn().mockImplementation(async (_demux, options) => {
    await options.onFrameAvailable(new Uint8Array([0x20, 0x40, 0x60]), 100, 0);
    await options.onFrameAvailable(new Uint8Array([0x30, 0x50, 0x70]), 40, 1);
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

vi.mock('@services/wasm-webp-singleton', () => ({
  encodeRGBReuse: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
}));

vi.mock('@services/streaming-webp-encoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@services/streaming-webp-encoder')>();
  return {
    ...actual,
    extractVP8Bitstream: () => new Uint8Array(8),
  };
});

import { encodeGif } from '@services/gif-encoder-service';
import { encodeWebp } from '@services/webp-encoder-service';

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
  let totalMilliseconds = 0;
  for (let offset = 0; offset + 24 <= output.length; offset++) {
    if (
      output[offset] === 0x41 &&
      output[offset + 1] === 0x4e &&
      output[offset + 2] === 0x4d &&
      output[offset + 3] === 0x46
    ) {
      totalMilliseconds +=
        output[offset + 20]! |
        (output[offset + 21]! << 8) |
        (output[offset + 22]! << 16);
    }
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
    const output = await encodeWebp(
      demux,
      {
        height: 1,
        quality: 'medium',
        scale: 1,
        width: 1,
      },
      onProgress
    );

    expect(readWebpDurationMs(output)).toBe(200);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'encoding', currentFrame: 1 })
    );
  });
});
