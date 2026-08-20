// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversionRequest } from '@t/conversion-types';

const mocks = vi.hoisted(() => ({
  demuxVideo: vi.fn(),
  disposeWorkerPool: vi.fn(),
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
  demuxVideo: mocks.demuxVideo,
}));

const demuxResult = {
  chunks: [],
  config: { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 },
  dispose: vi.fn(),
  duration: 1,
  framerate: 30,
  sourceTotalMs: 1000,
  totalFrames: 30,
};
vi.mock('@services/gif-encoder-service', () => ({ encodeGif: mocks.encodeGif }));
vi.mock('@services/webp-encoder-service', () => ({ encodeWebp: mocks.encodeWebp }));
vi.mock('@services/offscreen-webp-encoder', () => ({
  encodeWebpOffscreen: mocks.encodeWebpOffscreen,
}));
vi.mock('@services/worker-pool', () => ({
  createWorkerPool: () => null,
  disposeWorkerPool: mocks.disposeWorkerPool,
  WebpWorkerPool: { getOptimalWorkerCount: () => 1 },
}));

import { getLastConversionProfileReport } from '@services/conversion-profile-store';
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
  demuxResult.dispose.mockClear();
  mocks.demuxVideo.mockReset().mockResolvedValue(demuxResult);
  mocks.encodeGif.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.encodeWebp.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.encodeWebpOffscreen.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.disposeWorkerPool.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('main conversion pipeline encoder options', () => {
  it('retains the latest completed development profile for diagnostics', async () => {
    await runConversionPipeline(baseRequest, vi.fn());

    expect(getLastConversionProfileReport()).not.toBeNull();
  });

  it('forwards smartFrameSkip to the GIF encoder', async () => {
    await runConversionPipeline(baseRequest, vi.fn());

    expect(mocks.encodeGif).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        maxFrames: 9000,
        maxOutputBytes: 268435456,
        smartFrameSkip: 'adaptive',
      }),
      undefined
    );
  });

  it('forwards cancellation to demuxing', async () => {
    const signal = new AbortController().signal;

    await runConversionPipeline(baseRequest, vi.fn(), signal);

    expect(mocks.demuxVideo).toHaveBeenCalledWith(
      baseRequest,
      undefined,
      expect.any(Function),
      signal
    );
  });

  it('disposes the demux stream after conversion', async () => {
    await runConversionPipeline(baseRequest, vi.fn());

    expect(demuxResult.dispose).toHaveBeenCalledOnce();
  });

  it('rejects hostile decoded dimensions before encoding and releases pipeline resources', async () => {
    const dispose = vi.fn();
    const onProgress = vi.fn();
    mocks.demuxVideo.mockResolvedValueOnce({
      ...demuxResult,
      config: {
        codec: 'vp09.00.30.08.01.02.02.02.00',
        codedWidth: 520,
        codedHeight: 520,
        displayAspectWidth: 52_000,
        displayAspectHeight: 520,
      },
      dispose,
    });

    await expect(runConversionPipeline(baseRequest, onProgress)).rejects.toThrow(
      'Unable to determine video dimensions'
    );

    expect(mocks.encodeGif).not.toHaveBeenCalled();
    expect(mocks.encodeWebp).not.toHaveBeenCalled();
    expect(mocks.encodeWebpOffscreen).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(mocks.disposeWorkerPool).toHaveBeenCalledOnce();
  });

  it('returns only the encoder view bytes in a fresh ArrayBuffer', async () => {
    const backing = new Uint8Array([9, 1, 2, 3, 9]);
    mocks.encodeGif.mockResolvedValue(backing.subarray(1, 4));

    const result = await runConversionPipeline(baseRequest, vi.fn());

    expect(Array.from(new Uint8Array(result))).toEqual([1, 2, 3]);
    expect(result).not.toBe(backing.buffer);
  });

  it('reuses a WebP encoder buffer when its view covers the entire allocation', async () => {
    const encoded = new Uint8Array([1, 2, 3]);
    mocks.encodeWebp.mockResolvedValue(encoded);

    const result = await runConversionPipeline({ ...baseRequest, format: 'webp' }, vi.fn());

    expect(result).toBe(encoded.buffer);
  });

  it('forwards smartFrameSkip to the wasm WebP fallback', async () => {
    await runConversionPipeline({ ...baseRequest, format: 'webp' }, vi.fn());

    expect(mocks.encodeWebp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        maxFrames: 9000,
        maxOutputBytes: 100663296,
        smartFrameSkip: 'adaptive',
      }),
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
      expect.objectContaining({
        maxFrames: 9000,
        maxOutputBytes: 100663296,
        smartFrameSkip: 'adaptive',
      }),
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
