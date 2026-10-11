// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  mocks.encodeGif
    .mockReset()
    .mockImplementation(
      async (
        _demux: unknown,
        options: {
          onFrameDecoded?: (frameCount: number, totalFrames: number) => void;
          onFrameEncoded?: (frameCount: number, totalFrames: number) => void;
          onEncodingComplete?: (counts: {
            consumedChunks?: number;
            decodedFrames: number;
            selectedFrames?: number;
            encodedFrames: number;
            emittedFrames?: number;
          }) => void;
        }
      ) => {
        options.onFrameDecoded?.(10, 30);
        options.onFrameEncoded?.(10, 10);
        options.onEncodingComplete?.({
          consumedChunks: 30,
          decodedFrames: 30,
          selectedFrames: 12,
          encodedFrames: 10,
          emittedFrames: 10,
        });
        return new Uint8Array([1, 2, 3]);
      }
    );
  mocks.encodeWebp
    .mockReset()
    .mockImplementation(
      async (
        _demux: unknown,
        options: {
          onEncodingComplete?: (counts: {
            consumedChunks?: number;
            decodedFrames: number;
            selectedFrames?: number;
            encodedFrames: number;
            emittedFrames?: number;
          }) => void;
        },
        onProgress?: (progress: { currentFrame?: number; totalFrames?: number }) => void
      ) => {
        onProgress?.({ currentFrame: 1, totalFrames: 30 });
        options.onEncodingComplete?.({
          consumedChunks: 3,
          decodedFrames: 2,
          selectedFrames: 1,
          encodedFrames: 1,
          emittedFrames: 1,
        });
        return new Uint8Array([1, 2, 3]);
      }
    );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('worker pipeline smart frame skip forwarding', () => {
  it('passes Blob input to demux without reading the whole file first', async () => {
    const input = new Blob(['video']);
    const readWholeFile = vi.fn().mockRejectedValue(new Error('Unexpected full-file read'));
    Object.defineProperty(input, 'arrayBuffer', { value: readWholeFile });

    await runWorkerPipeline(input, baseOptions, vi.fn(), 'blob-request');

    expect(mocks.demuxVideo).toHaveBeenCalledWith(
      expect.objectContaining({ inputBlob: input }),
      undefined,
      expect.any(Function),
      undefined
    );
    expect(mocks.demuxVideo.mock.calls[0]?.[0]).not.toHaveProperty('inputBuffer');
    expect(readWholeFile).not.toHaveBeenCalled();
    expect(demuxResult.dispose).toHaveBeenCalledOnce();
  });

  it('forwards smartFrameSkip to the GIF encoder', async () => {
    const postMessage = vi.fn();
    const result = await runWorkerPipeline(
      new ArrayBuffer(8),
      baseOptions,
      postMessage,
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
    expect(result.profile?.stages.map((stage) => stage.stage)).toEqual([
      'demuxing',
      'transcoding',
      'finalizing',
    ]);
    expect(result.profile?.stages.find((stage) => stage.stage === 'transcoding')).toMatchObject({
      consumedChunks: 30,
      decodedFrames: 30,
      selectedFrames: 12,
      encodedFrames: 10,
      emittedFrames: 10,
      outputBytes: 3,
    });
    expect(result.profile?.encoderRoute).toBe('gif-worker');
    const progress = postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === 'progress');
    expect(progress.at(-1)).toMatchObject({
      phase: 'assembling',
      percent: 100,
      memoryMB: null,
      accountedMemoryMB: expect.any(Number),
      consumedChunks: 30,
      decodedFrames: 30,
      selectedFrames: 12,
      encodedFrames: 10,
      emittedFrames: 10,
      outputFrames: 10,
      etaSeconds: 0,
    });
    expect(progress.map((entry) => entry.percent)).toEqual(
      [...progress.map((entry) => entry.percent)].sort((a, b) => a - b)
    );
    expect(postMessage).toHaveBeenCalledWith({
      type: 'log',
      requestId: 'request-1',
      level: 'info',
      category: 'conversion',
      message: '▶ Worker pipeline started: gif medium 1x',
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'log',
      requestId: 'request-1',
      level: 'info',
      category: 'encoders',
      message: '├─ GIF encoder (streaming decode→encode)',
    });
  });

  it('preserves container rotation through worker metadata and output dimensions', async () => {
    mocks.demuxVideo.mockResolvedValueOnce({
      ...demuxResult,
      config: { codec: 'avc1.640028', codedWidth: 80, codedHeight: 48 },
      rotation: 270,
    });

    await runWorkerPipeline(
      new ArrayBuffer(8),
      baseOptions,
      vi.fn(),
      'rotation-request',
      undefined,
      { codec: 'avc1.640028', codedWidth: 80, codedHeight: 48, rotation: 270 },
      1,
      4
    );

    expect(mocks.demuxVideo.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ rotation: 270 })
    );
    expect(mocks.encodeGif).toHaveBeenCalledWith(
      expect.objectContaining({ rotation: 270 }),
      expect.objectContaining({ width: 48, height: 80 }),
      undefined
    );
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
    const result = await runWorkerPipeline(
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
    expect(result.profile?.stages.find((stage) => stage.stage === 'transcoding')).toMatchObject({
      consumedChunks: 3,
      decodedFrames: 2,
      selectedFrames: 1,
      encodedFrames: 1,
      emittedFrames: 1,
    });
    expect(result.profile?.encoderRoute).toBe('webp-wasm');
  });

  it('transfers only output view bytes when the encoder returns spare capacity', async () => {
    mocks.encodeGif.mockImplementationOnce(async () =>
      new Uint8Array([99, 1, 2, 3, 99]).subarray(1, 4)
    );

    const result = await runWorkerPipeline(new ArrayBuffer(8), baseOptions, vi.fn(), 'view-output');
    expect([...new Uint8Array(result.outputBuffer)]).toEqual([1, 2, 3]);
    expect(result.outputBuffer.byteLength).toBe(3);
    expect(result.profile?.operationTotals.outputCopy.samples).toBe(1);
  });

  it('uses native decode counts and separate encoded completion rate for streaming progress', async () => {
    let nowMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    mocks.encodeGif.mockImplementationOnce(
      async (
        _demux: unknown,
        options: {
          onFrameDecoded?: (count: number, total: number) => void;
          onFrameEncoded?: (count: number, total: number) => void;
          onEncodingComplete?: (counts: {
            decodedFrames: number;
            encodedFrames: number;
            emittedFrames: number;
          }) => void;
        }
      ) => {
        nowMs = 120;
        options.onFrameDecoded?.(10, 30);
        nowMs = 240;
        options.onFrameEncoded?.(1, 12);
        nowMs = 360;
        options.onFrameDecoded?.(20, 30);
        nowMs = 480;
        options.onFrameEncoded?.(2, 12);
        options.onEncodingComplete?.({ decodedFrames: 30, encodedFrames: 2, emittedFrames: 2 });
        return new Uint8Array([1, 2, 3]);
      }
    );
    const postMessage = vi.fn();

    await runWorkerPipeline(new ArrayBuffer(8), baseOptions, postMessage, 'cadence-progress');
    const progress = postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === 'progress');
    const decoding = progress.find((message) => message.phase === 'decoding');
    const encoding = progress.find((message) => message.phase === 'encoding');

    expect(decoding).toMatchObject({
      decodedFrames: 10,
      currentFrame: 10,
      totalFrames: 30,
      fps: 83.3,
      memoryMB: null,
      etaSeconds: 1,
    });
    expect(encoding).toMatchObject({
      decodedFrames: 10,
      encodedFrames: 1,
      currentFrame: 1,
      totalFrames: 12,
      fps: 4.2,
      etaSeconds: 3,
    });
    expect(encoding).not.toHaveProperty('outputFrames');
    expect(progress.map((message) => message.percent)).toEqual(
      [...progress.map((message) => message.percent)].sort((a, b) => a - b)
    );
    expect(progress.at(-1)).toMatchObject({ emittedFrames: 2, outputFrames: 2 });
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
