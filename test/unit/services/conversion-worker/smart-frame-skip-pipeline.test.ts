// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SerializedConversionOptions } from '@services/conversion-worker/types';

const mocks = vi.hoisted(() => ({
  encodeGif: vi.fn(),
  encodeWebp: vi.fn(),
}));

vi.mock('@services/demuxer-service', () => ({
  demuxVideo: vi.fn().mockResolvedValue({
    chunks: [],
    config: { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 },
    duration: 1,
    framerate: 30,
    sourceTotalMs: 1000,
    totalFrames: 30,
  }),
}));

vi.mock('@services/gif-encoder-service', () => ({ encodeGif: mocks.encodeGif }));
vi.mock('@services/webp-encoder-service', () => ({ encodeWebp: mocks.encodeWebp }));

import { runWorkerPipeline } from '@services/conversion-worker/pipeline-worker';

const baseOptions: SerializedConversionOptions = {
  format: 'gif',
  quality: 'medium',
  fps: 30,
  scale: 1,
  trimStart: 0,
  trimEnd: 0,
  maxFrames: 300,
  smartFrameSkip: 'adaptive',
};

beforeEach(() => {
  mocks.encodeGif.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.encodeWebp.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
});

describe('worker pipeline smart frame skip forwarding', () => {
  it('forwards smartFrameSkip to the GIF encoder', async () => {
    await runWorkerPipeline(new ArrayBuffer(8), baseOptions, vi.fn());

    expect(mocks.encodeGif).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ smartFrameSkip: 'adaptive' }),
      undefined
    );
  });

  it('forwards smartFrameSkip to the WebP encoder', async () => {
    await runWorkerPipeline(
      new ArrayBuffer(8),
      { ...baseOptions, format: 'webp' },
      vi.fn()
    );

    expect(mocks.encodeWebp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ smartFrameSkip: 'adaptive' }),
      expect.anything(),
      undefined
    );
  });
});
