// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SerializedConversionOptions } from '@services/conversion-worker/types';

const mocks = vi.hoisted(() => ({
  demuxVideo: vi.fn(),
  encodeGif: vi.fn(),
  encodeWebp: vi.fn(),
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

import { runWorkerPipeline } from '@services/conversion-worker/pipeline-worker';

const baseOptions: SerializedConversionOptions = {
  format: 'gif',
  quality: 'medium',
  fps: 30,
  scale: 1,
  trimStart: 0,
  trimEnd: 0,
  maxFrames: 300,
  maxOutputBytes: 1024,
  smartFrameSkip: 'adaptive',
};

beforeEach(() => {
  demuxResult.dispose.mockClear();
  mocks.demuxVideo.mockReset().mockResolvedValue(demuxResult);
  mocks.encodeGif.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.encodeWebp.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
});

describe('worker pipeline smart frame skip forwarding', () => {
  it('forwards smartFrameSkip to the GIF encoder', async () => {
    const result = await runWorkerPipeline(
      new ArrayBuffer(8),
      baseOptions,
      vi.fn(),
      'request-1'
    );

    expect(mocks.encodeGif).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        assertAdditionalMemoryBytes: expect.any(Function),
        maxFrames: 300,
        maxOutputBytes: 1024,
        smartFrameSkip: 'adaptive',
      }),
      undefined
    );
    expect(result.profile?.phases.map((phase) => phase.phase)).toEqual([
      'demuxing',
      'decoding',
      'encoding',
      'assembling',
    ]);
    expect(result.profile?.phases.find((phase) => phase.phase === 'encoding')).toMatchObject({
      framesProcessed: 10,
      outputBytes: 3,
    });
  });

  it('combines GIF stream peaks with the worker aggregate memory budget', async () => {
    await runWorkerPipeline(new ArrayBuffer(8), baseOptions, vi.fn(), 'request-1');
    const encoderOptions = mocks.encodeGif.mock.calls[0]?.[1] as
      | { assertAdditionalMemoryBytes?: (bytes: number) => void }
      | undefined;

    expect(() => encoderOptions?.assertAdditionalMemoryBytes?.(1024)).not.toThrow();
    expect(() => encoderOptions?.assertAdditionalMemoryBytes?.(461 * 1024 * 1024)).toThrow(
      'Worker memory estimate reached'
    );
  });

  it('forwards smartFrameSkip to the WebP encoder', async () => {
    await runWorkerPipeline(
      new ArrayBuffer(8),
      { ...baseOptions, format: 'webp' },
      vi.fn(),
      'request-1'
    );

    expect(mocks.encodeWebp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        maxFrames: 300,
        maxOutputBytes: 1024,
        smartFrameSkip: 'adaptive',
      }),
      expect.anything(),
      undefined
    );
  });

  it('rejects hostile decoded dimensions before encoding and disposes the demux session', async () => {
    const dispose = vi.fn();
    const postMessage = vi.fn();
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

    await expect(
      runWorkerPipeline(new ArrayBuffer(8), baseOptions, postMessage, 'request-1')
    ).rejects.toThrow('Unable to determine video dimensions');

    expect(mocks.encodeGif).not.toHaveBeenCalled();
    expect(mocks.encodeWebp).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'log', requestId: 'request-1' })
    );
  });
});
