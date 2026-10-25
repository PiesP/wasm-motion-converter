// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ConversionRequest } from '@t/conversion-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  createWorkerPool: vi.fn(),
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
  createWorkerPool: mocks.createWorkerPool,
  disposeWorkerPool: mocks.disposeWorkerPool,
  WebpWorkerPool: { getOptimalWorkerCount: () => 1 },
}));

import { runConversionPipeline } from '@services/conversion-pipeline';
import { getLastConversionProfileReport } from '@services/conversion-profile-store';

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

function stubCanvasWebpSupport(): void {
  class FakeOffscreenCanvas {
    getContext(): object {
      return { fillStyle: '', fillRect() {} };
    }
    async convertToBlob(): Promise<Blob> {
      const frame = new Uint8Array([0x10, 0, 0, 0x9d, 0x01, 0x2a, 2, 0, 2, 0]);
      const webp = new Uint8Array(20 + frame.length);
      webp.set([0x52, 0x49, 0x46, 0x46], 0);
      webp.set([0x57, 0x45, 0x42, 0x50], 8);
      webp.set([0x56, 0x50, 0x38, 0x20], 12);
      const view = new DataView(webp.buffer);
      view.setUint32(4, webp.length - 8, true);
      view.setUint32(16, frame.length, true);
      webp.set(frame, 20);
      return new Blob([webp], { type: 'image/webp' });
    }
  }
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
}

beforeEach(() => {
  demuxResult.dispose.mockClear();
  mocks.demuxVideo.mockReset().mockResolvedValue(demuxResult);
  mocks.createWorkerPool.mockReset().mockReturnValue(null);
  mocks.encodeGif.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.encodeWebp.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.encodeWebpOffscreen.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.disposeWorkerPool.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('main conversion pipeline encoder options', () => {
  it.each(['gif', 'webp-wasm', 'webp-canvas'] as const)(
    'forwards independent normal, pressure, and explicit-gap policies to %s',
    async (route) => {
      if (route === 'webp-canvas') {
        stubCanvasWebpSupport();
        vi.stubGlobal('Worker', undefined);
      }
      await runConversionPipeline(
        {
          ...baseRequest,
          format: route === 'gif' ? 'gif' : 'webp',
          forceDecimation: 2,
          memoryPressureCadenceRatio: 4.2,
        },
        vi.fn()
      );
      const encoder =
        route === 'gif'
          ? mocks.encodeGif
          : route === 'webp-canvas'
            ? mocks.encodeWebpOffscreen
            : mocks.encodeWebp;
      expect(encoder).toHaveBeenCalledOnce();
      expect(encoder.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          frameDecimation: 2,
          minimumSourceFrameGap: 2,
          pressureCadenceRatio: 4.2,
        })
      );
    }
  );
  it('keeps decode ETA unknown when a measurable stream has no total-frame estimate', async () => {
    let elapsedMs = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
    mocks.demuxVideo.mockResolvedValueOnce({ ...demuxResult, totalFrames: 0 });
    mocks.encodeGif.mockImplementationOnce(async (_demux, options) => {
      elapsedMs = 1_000;
      options.onFrameDecoded?.(1, 0);
      options.onEncodingComplete?.({
        consumedChunks: 1,
        decodedFrames: 1,
        selectedFrames: 1,
        encodedFrames: 1,
        emittedFrames: 1,
      });
      return new Uint8Array([1, 2, 3]);
    });
    const onProgress = vi.fn();
    try {
      await runConversionPipeline(baseRequest, onProgress);
      const progress = onProgress.mock.calls.map(([update]) => update);
      const decoding = progress.find((update) => update.phase === 'decoding');
      expect(decoding).toMatchObject({
        decodedFrames: 1,
        currentFrame: 1,
        totalFrames: 0,
        etaSeconds: null,
      });
      expect(decoding.fps).toBeGreaterThan(0);
      expect(Number.isFinite(decoding.fps)).toBe(true);
      expect(decoding.progress).toBeLessThan(100);
      expect(progress.at(-1)).toMatchObject({
        phase: 'assembling',
        progress: 100,
        decodedFrames: 1,
        emittedFrames: 1,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['gif-main', 'webp-serial-canvas', 'webp-wasm'] as const)(
    'reports finite decode rates and exact terminal counters on %s',
    async (route) => {
      if (route === 'webp-serial-canvas') {
        stubCanvasWebpSupport();
        vi.stubGlobal('Worker', undefined);
      } else if (route === 'webp-wasm') {
        vi.stubGlobal('OffscreenCanvas', undefined);
        vi.stubGlobal('Worker', undefined);
      }
      let elapsedMs = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
      mocks.demuxVideo.mockResolvedValueOnce({ ...demuxResult, totalFrames: 13 });
      const encoder =
        route === 'gif-main'
          ? mocks.encodeGif
          : route === 'webp-serial-canvas'
            ? mocks.encodeWebpOffscreen
            : mocks.encodeWebp;
      encoder.mockImplementationOnce(async (_demux, options) => {
        for (const [time, count] of [
          [100, 1],
          [250, 7],
          [450, 13],
        ] as const) {
          elapsedMs = time;
          options.onFrameDecoded?.(count, 13);
        }
        options.onEncodingComplete?.({
          consumedChunks: 13,
          decodedFrames: 13,
          selectedFrames: 5,
          encodedFrames: 3,
          emittedFrames: 2,
        });
        return new Uint8Array([1, 2, 3]);
      });
      const onProgress = vi.fn();
      try {
        await runConversionPipeline(
          { ...baseRequest, format: route === 'gif-main' ? 'gif' : 'webp' },
          onProgress
        );
        const progress = onProgress.mock.calls.map(([update]) => update);
        const decoding = progress.filter((update) => update.phase === 'decoding');
        expect(decoding.map((update) => update.decodedFrames)).toEqual([1, 7, 13]);
        expect(decoding.at(-1)?.etaSeconds).toBeNull();
        for (const update of decoding.slice(0, -1)) {
          expect(Number.isFinite(update.etaSeconds)).toBe(true);
          expect(update.etaSeconds).toBeGreaterThan(0);
        }
        for (const update of decoding) {
          expect(Number.isFinite(update.fps)).toBe(true);
          expect(update.fps).toBeGreaterThan(0);
          expect(update.progress).toBeLessThan(100);
        }
        expect(progress.at(-1)).toMatchObject({
          phase: 'assembling',
          progress: 100,
          decodedFrames: 13,
          selectedFrames: 5,
          encodedFrames: 3,
          emittedFrames: 2,
          currentFrame: 13,
          outputFrames: 2,
        });
        expect(getLastConversionProfileReport()?.encoderRoute).toBe(route);
      } finally {
        clock.mockRestore();
      }
    }
  );

  it('retains the latest completed development profile for diagnostics', async () => {
    await runConversionPipeline(baseRequest, vi.fn());

    expect(getLastConversionProfileReport()).not.toBeNull();
  });

  it('forwards smartFrameSkip to the GIF encoder', async () => {
    await runConversionPipeline(baseRequest, vi.fn());

    expect(mocks.encodeGif).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        assertAdditionalMemoryBytes: expect.any(Function),
        maxFrames: 9000,
        maxOutputBytes: 268435456,
        smartFrameSkip: 'adaptive',
      }),
      undefined
    );
  });

  it('uses rotated display dimensions on the main-thread pipeline', async () => {
    mocks.demuxVideo.mockResolvedValueOnce({
      ...demuxResult,
      config: { codec: 'avc1.640028', codedWidth: 80, codedHeight: 48 },
      rotation: 270,
    });

    await runConversionPipeline(baseRequest, vi.fn());

    expect(mocks.encodeGif).toHaveBeenCalledWith(
      expect.objectContaining({ rotation: 270 }),
      expect.objectContaining({ width: 48, height: 80 }),
      undefined
    );
  });

  it('enforces the aggregate GIF memory budget on the main-thread fallback', async () => {
    mocks.encodeGif.mockImplementationOnce(async (_demux, options) => {
      options.assertAdditionalMemoryBytes(461 * 1024 * 1024);
      return new Uint8Array([1, 2, 3]);
    });

    await expect(runConversionPipeline(baseRequest, vi.fn())).rejects.toThrow(
      'Main-thread memory estimate reached'
    );
    expect(demuxResult.dispose).toHaveBeenCalledOnce();
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
    stubCanvasWebpSupport();
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

  it('creates only one memory-safe RGBA Worker for full-resolution 4K WebP', async () => {
    stubCanvasWebpSupport();
    vi.stubGlobal('Worker', class {});
    mocks.demuxVideo.mockResolvedValueOnce({
      ...demuxResult,
      config: { codec: 'avc1.640033', codedWidth: 3840, codedHeight: 2160 },
      totalFrames: 1,
    });

    await runConversionPipeline({ ...baseRequest, format: 'webp' }, vi.fn());

    expect(mocks.createWorkerPool).toHaveBeenCalledWith(1);
    expect(mocks.encodeWebpOffscreen).toHaveBeenCalledOnce();
    expect(mocks.encodeWebp).not.toHaveBeenCalled();
  });
});
