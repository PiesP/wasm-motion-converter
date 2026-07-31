// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  encodeRGBReuse: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  padLastFrameDuration: vi.fn(),
}));

vi.mock('@services/decoder-service', () => ({
  decodeFrames: vi.fn().mockImplementation(async (_demux, options) => {
    await options.onFrameAvailable(new Uint8Array(3), 100, 0);
    return {
      frames: [],
      outputTotalMs: 0,
      skippedByDecimation: 0,
      smartSkipped: 0,
      sourceTotalMs: 175,
      tailAccumulatedMs: 75,
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
vi.mock('@services/streaming-webp-encoder', () => ({
  extractVP8Bitstream: (value: Uint8Array) => value,
  StreamingWebpMuxer: class {
    frames = 0;
    addFrame(): void {
      this.frames++;
    }
    padLastFrameDuration = mocks.padLastFrameDuration;
    async finish(): Promise<Uint8Array> {
      return new Uint8Array([1, 2, 3]);
    }
  },
}));
vi.mock('@services/wasm-webp-singleton', () => ({
  encodeRGBReuse: mocks.encodeRGBReuse,
}));

import { encodeWebp } from '@services/webp-encoder-service';

describe('encodeWebp timing', () => {
  it('pads the last frame with decoder trailing duration', async () => {
    await encodeWebp(
      {
        chunks: [],
        config: { codec: 'vp09.00.10.08', codedWidth: 1, codedHeight: 1 },
        duration: 0.175,
        framerate: 30,
        sourceTotalMs: 175,
        totalFrames: 1,
      },
      { width: 1, height: 1, quality: 'medium', scale: 1 }
    );

    expect(mocks.padLastFrameDuration).toHaveBeenCalledWith(75);
    expect(mocks.encodeRGBReuse).toHaveBeenCalledWith(expect.any(Uint8Array), 1, 1, 75);
  });
});
