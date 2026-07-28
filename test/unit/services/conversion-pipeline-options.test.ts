// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversionRequest } from '@t/conversion-types';

const mocks = vi.hoisted(() => ({
  encodeGif: vi.fn(),
  encodeWebp: vi.fn(),
  encodeWebpOffscreen: vi.fn(),
}));

vi.mock('@stores/conversion-store', () => ({ videoMetadata: () => null }));
vi.mock('@utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    performance: vi.fn(),
    warn: vi.fn(),
  },
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
vi.mock('@services/offscreen-webp-encoder', () => ({
  encodeWebpOffscreen: mocks.encodeWebpOffscreen,
}));
vi.mock('@services/worker-pool', () => ({
  getWorkerPool: () => null,
  WebpWorkerPool: { getOptimalWorkerCount: () => 1 },
}));

import { runConversionPipeline } from '@services/conversion-pipeline';

const baseRequest: ConversionRequest = {
  inputBuffer: new ArrayBuffer(8),
  fileName: 'test.webm',
  format: 'gif',
  quality: 'medium',
  scale: 1,
  trimStart: 0,
  trimEnd: 0,
  maxMemoryMB: 512,
  smartFrameSkip: 'adaptive',
};

beforeEach(() => {
  mocks.encodeGif.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.encodeWebp.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.encodeWebpOffscreen.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('main conversion pipeline encoder options', () => {
  it('forwards smartFrameSkip to the GIF encoder', async () => {
    await runConversionPipeline(baseRequest, vi.fn());

    expect(mocks.encodeGif).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ smartFrameSkip: 'adaptive' }),
      undefined
    );
  });

  it('forwards smartFrameSkip to the wasm WebP fallback', async () => {
    await runConversionPipeline({ ...baseRequest, format: 'webp' }, vi.fn());

    expect(mocks.encodeWebp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ smartFrameSkip: 'adaptive' }),
      expect.anything(),
      undefined
    );
  });

  it('forwards smartFrameSkip to the OffscreenCanvas WebP fallback', async () => {
    class FakeOffscreenCanvas {
      readonly convertToBlob = vi.fn();
      getContext(): object {
        return {};
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    vi.stubGlobal('Worker', undefined);

    await runConversionPipeline({ ...baseRequest, format: 'webp' }, vi.fn());

    expect(mocks.encodeWebpOffscreen).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ smartFrameSkip: 'adaptive' }),
      expect.anything(),
      undefined
    );
  });

  it('uses wasm WebP when OffscreenCanvas lacks a 2D context', async () => {
    class PartialOffscreenCanvas {
      readonly convertToBlob = vi.fn();
      getContext(): null {
        return null;
      }
    }
    vi.stubGlobal('OffscreenCanvas', PartialOffscreenCanvas);
    vi.stubGlobal('Worker', undefined);

    await runConversionPipeline({ ...baseRequest, format: 'webp' }, vi.fn());

    expect(mocks.encodeWebpOffscreen).not.toHaveBeenCalled();
    expect(mocks.encodeWebp).toHaveBeenCalledOnce();
  });
});
