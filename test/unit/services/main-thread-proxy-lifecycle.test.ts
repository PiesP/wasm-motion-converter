import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { runConversionPipeline } = vi.hoisted(() => ({
  runConversionPipeline: vi.fn(),
}));
const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@services/conversion-pipeline', () => ({ runConversionPipeline }));
vi.mock('@utils/logger', () => ({ logger }));

class ThrowingWorker {
  static constructionCount = 0;
  static constructionError: Error | null = null;
  static instance: ThrowingWorker | null = null;
  static response: unknown = null;
  static workerError: ErrorEvent | null = null;
  readonly terminate = vi.fn();
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor() {
    ThrowingWorker.constructionCount++;
    if (ThrowingWorker.constructionError) throw ThrowingWorker.constructionError;
    ThrowingWorker.instance = this;
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    if (ThrowingWorker.workerError) {
      transfer ? structuredClone(message, { transfer }) : structuredClone(message);
      queueMicrotask(() => this.onerror?.(ThrowingWorker.workerError!));
      return;
    }
    if (ThrowingWorker.response) {
      const responses = Array.isArray(ThrowingWorker.response)
        ? ThrowingWorker.response
        : [ThrowingWorker.response];
      queueMicrotask(() => {
        for (const response of responses) {
          this.onmessage?.(new MessageEvent('message', { data: response }));
        }
      });
      return;
    }
    throw new Error('structured clone failed');
  }
}

vi.stubGlobal('Worker', ThrowingWorker);
vi.stubGlobal('crypto', { randomUUID: () => 'request-1' });

import { getLastConversionProfileReport } from '@services/conversion-profile-store';
import {
  runPipelineViaWorker,
  runPipelineWithFallback,
} from '@services/conversion-worker/main-thread-proxy';
import type {
  SerializedConversionOptions,
  SerializedDecoderConfig,
} from '@services/conversion-worker/types';
import { MAX_CODEC_DESCRIPTION_BYTES, WORKER_PIPELINE_TIMEOUT_MS } from '@utils/constants';

const validDecoderConfig: SerializedDecoderConfig = {
  codec: 'vp09.00.10.08',
  codedWidth: 16,
  codedHeight: 16,
};

const validOptions: SerializedConversionOptions = {
  format: 'gif',
  quality: 'medium',
  fps: 30,
  scale: 1,
  trimStart: 0,
  trimEnd: 0,
  maxFrames: 100,
  maxOutputBytes: 1024,
};

const progressMessage = (
  phase: 'demuxing' | 'decoding' | 'encoding' | 'assembling',
  percent: number,
  fps: number,
  decodedFrames: number,
  requestId = 'request-1'
) => ({
  type: 'progress' as const,
  requestId,
  phase,
  percent,
  fps,
  etaSeconds: null,
  memoryMB: null,
  decodedFrames,
  currentFrame: decodedFrames,
  totalFrames: 360,
});

const emitWorkerMessage = (worker: ThrowingWorker, data: unknown): void => {
  worker.onmessage?.(new MessageEvent('message', { data }));
};

const invalidPreWorkerConfigs: Array<{
  name: string;
  config: SerializedDecoderConfig;
}> = [
  {
    name: 'zero display width',
    config: { ...validDecoderConfig, displayAspectWidth: 0, displayAspectHeight: 16 },
  },
  {
    name: 'negative display height',
    config: {
      ...validDecoderConfig,
      displayAspectWidth: 16,
      displayAspectHeight: -1,
    },
  },
  {
    name: 'fractional display width',
    config: {
      ...validDecoderConfig,
      displayAspectWidth: 16.5,
      displayAspectHeight: 16,
    },
  },
  {
    name: 'NaN display height',
    config: {
      ...validDecoderConfig,
      displayAspectWidth: 16,
      displayAspectHeight: Number.NaN,
    },
  },
  {
    name: 'infinite display width',
    config: {
      ...validDecoderConfig,
      displayAspectWidth: Number.POSITIVE_INFINITY,
      displayAspectHeight: 16,
    },
  },
  {
    name: 'one-sided display-aspect metadata',
    config: { ...validDecoderConfig, displayAspectHeight: 16 },
  },
  {
    name: 'hostile pixel-aspect dimensions above the rounded RGB pool budget',
    config: {
      codec: 'vp09.00.30.08.01.02.02.02.00',
      codedWidth: 520,
      codedHeight: 520,
      displayAspectWidth: 52_000,
      displayAspectHeight: 520,
    },
  },
  {
    name: 'an unsafe coded-dimension product',
    config: {
      ...validDecoderConfig,
      codedWidth: Number.MAX_SAFE_INTEGER,
      codedHeight: 2,
    },
  },
];

describe('runPipelineViaWorker lifecycle', () => {
  beforeEach(() => {
    ThrowingWorker.constructionCount = 0;
    ThrowingWorker.constructionError = null;
    ThrowingWorker.instance = null;
    ThrowingWorker.response = null;
    ThrowingWorker.workerError = null;
    runConversionPipeline.mockReset();
    for (const method of Object.values(logger)) method.mockReset();
  });

  it('delivers a valid intermediate update received at 99ms while conversion remains active', async () => {
    vi.useFakeTimers();
    const post = vi.spyOn(ThrowingWorker.prototype, 'postMessage').mockImplementation(() => {});
    try {
      const onProgress = vi.fn();
      const pending = runPipelineViaWorker(
        new Blob(['video']),
        validDecoderConfig,
        validOptions,
        onProgress
      );
      const worker = ThrowingWorker.instance!;
      emitWorkerMessage(worker, progressMessage('demuxing', 5, 0, 0));
      expect(onProgress).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(99);
      emitWorkerMessage(worker, progressMessage('encoding', 40, 18, 120));
      expect(onProgress).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(onProgress.mock.calls[1]?.[0]).toMatchObject({
        phase: 'encoding',
        progress: 40,
        fps: 18,
        decodedFrames: 120,
      });
      await vi.advanceTimersByTimeAsync(70);
      const outputBuffer = new ArrayBuffer(4);
      emitWorkerMessage(worker, {
        type: 'complete',
        requestId: 'request-1',
        outputBuffer,
        durationMs: 170,
      });
      await expect(pending).resolves.toBe(outputBuffer);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      post.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not schedule a fractional trailing interval before 100ms has elapsed', async () => {
    vi.useFakeTimers();
    let clockMs = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clockMs);
    const post = vi.spyOn(ThrowingWorker.prototype, 'postMessage').mockImplementation(() => {});
    try {
      const deliveredAt: number[] = [];
      const onProgress = vi.fn(() => deliveredAt.push(clockMs));
      const pending = runPipelineViaWorker(
        new Blob(['video']),
        validDecoderConfig,
        validOptions,
        onProgress
      );
      const worker = ThrowingWorker.instance!;
      emitWorkerMessage(worker, progressMessage('demuxing', 5, 0, 0));
      await vi.advanceTimersByTimeAsync(99);
      clockMs = 99.5;
      const schedule = vi.spyOn(globalThis, 'setTimeout');
      try {
        emitWorkerMessage(worker, progressMessage('encoding', 40, 18, 120));
        expect(onProgress).toHaveBeenCalledTimes(1);
        // Browsers may truncate a fractional timeout. Round up so no engine can run it early.
        expect(schedule.mock.calls.at(-1)?.[1]).toBeGreaterThanOrEqual(1);
      } finally {
        schedule.mockRestore();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(deliveredAt).toEqual([0]);
      clockMs = 100.5;
      await vi.advanceTimersByTimeAsync(1);
      expect(deliveredAt).toEqual([0, 100.5]);
      const outputBuffer = new ArrayBuffer(4);
      emitWorkerMessage(worker, {
        type: 'complete',
        requestId: 'request-1',
        outputBuffer,
        durationMs: 101,
      });
      await expect(pending).resolves.toBe(outputBuffer);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      post.mockRestore();
      now.mockRestore();
      vi.useRealTimers();
    }
  });

  it('coalesces a burst to its latest phase, count, and fps, then delivers sparse and terminal updates', async () => {
    vi.useFakeTimers();
    const post = vi.spyOn(ThrowingWorker.prototype, 'postMessage').mockImplementation(() => {});
    try {
      const onProgress = vi.fn();
      const pending = runPipelineViaWorker(
        new Blob(['video']),
        validDecoderConfig,
        validOptions,
        onProgress
      );
      const worker = ThrowingWorker.instance!;
      emitWorkerMessage(worker, progressMessage('demuxing', 5, 0, 0));
      await vi.advanceTimersByTimeAsync(20);
      emitWorkerMessage(worker, progressMessage('decoding', 10, 2, 2));
      await vi.advanceTimersByTimeAsync(50);
      emitWorkerMessage(worker, progressMessage('encoding', 30, 8, 2));
      await vi.advanceTimersByTimeAsync(29);
      emitWorkerMessage(worker, {
        ...progressMessage('encoding', 31, 12, 2),
        selectedFrames: 2,
        encodedFrames: 1,
      });
      expect(onProgress).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(onProgress.mock.calls[1]?.[0]).toMatchObject({
        phase: 'encoding',
        progress: 31,
        fps: 12,
        decodedFrames: 2,
        selectedFrames: 2,
        encodedFrames: 1,
      });
      await vi.advanceTimersByTimeAsync(120);
      emitWorkerMessage(worker, progressMessage('assembling', 80, 0, 360));
      expect(onProgress.mock.calls[2]?.[0]).toMatchObject({
        phase: 'assembling',
        progress: 80,
        decodedFrames: 360,
      });
      await vi.advanceTimersByTimeAsync(1);
      emitWorkerMessage(worker, progressMessage('assembling', 90, 0, 360));
      expect(onProgress).toHaveBeenCalledTimes(3);
      emitWorkerMessage(worker, progressMessage('assembling', 100, 0, 360));
      expect(onProgress.mock.calls[3]?.[0]).toMatchObject({
        phase: 'assembling',
        progress: 100,
        decodedFrames: 360,
      });
      const outputBuffer = new ArrayBuffer(4);
      emitWorkerMessage(worker, {
        type: 'complete',
        requestId: 'request-1',
        outputBuffer,
        durationMs: 230,
      });
      await expect(pending).resolves.toBe(outputBuffer);
      expect(onProgress.mock.calls.map(([update]) => update.progress)).toEqual([5, 31, 80, 100]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      post.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['complete', 'error', 'abort', 'bootstrap error'] as const)(
    'discards a pending update when %s settles a short conversion',
    async (terminal) => {
      vi.useFakeTimers();
      const post = vi.spyOn(ThrowingWorker.prototype, 'postMessage').mockImplementation(() => {});
      const controller = new AbortController();
      try {
        const onProgress = vi.fn();
        const outcome = runPipelineViaWorker(
          new Blob(['video']),
          validDecoderConfig,
          validOptions,
          onProgress,
          controller.signal
        ).then(
          (value) => ({ value }),
          (error: unknown) => ({ error })
        );
        const worker = ThrowingWorker.instance!;
        emitWorkerMessage(worker, progressMessage('demuxing', 5, 0, 0));
        await vi.advanceTimersByTimeAsync(20);
        emitWorkerMessage(worker, progressMessage('encoding', 45, 18, 120));
        expect(onProgress).toHaveBeenCalledTimes(1);
        if (terminal === 'complete') {
          emitWorkerMessage(worker, {
            type: 'complete',
            requestId: 'request-1',
            outputBuffer: new ArrayBuffer(4),
            durationMs: 30,
          });
          expect(await outcome).toHaveProperty('value');
        } else if (terminal === 'error') {
          emitWorkerMessage(worker, {
            type: 'error',
            requestId: 'request-1',
            code: 'DECODER_ERROR',
            message: 'fixture failure',
          });
          expect(await outcome).toMatchObject({ error: { name: 'WorkerPipelineError' } });
        } else if (terminal === 'abort') {
          controller.abort();
          expect(await outcome).toMatchObject({ error: { name: 'AbortError' } });
        } else {
          worker.onerror?.(new ErrorEvent('error', { message: 'module failed' }));
          expect(await outcome).toMatchObject({ error: { name: 'WorkerUnavailableError' } });
        }
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(200);
        emitWorkerMessage(worker, progressMessage('encoding', 60, 20, 180));
        expect(onProgress).toHaveBeenCalledTimes(1);
      } finally {
        post.mockRestore();
        vi.useRealTimers();
      }
    }
  );

  it('clears a pending update when the pipeline timeout settles first', async () => {
    vi.useFakeTimers();
    const post = vi.spyOn(ThrowingWorker.prototype, 'postMessage').mockImplementation(() => {});
    try {
      const onProgress = vi.fn();
      const outcome = runPipelineViaWorker(
        new Blob(['video']),
        validDecoderConfig,
        validOptions,
        onProgress
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
      const worker = ThrowingWorker.instance!;
      await vi.advanceTimersByTimeAsync(WORKER_PIPELINE_TIMEOUT_MS - 2);
      emitWorkerMessage(worker, progressMessage('demuxing', 5, 0, 0));
      await vi.advanceTimersByTimeAsync(1);
      emitWorkerMessage(worker, progressMessage('encoding', 45, 18, 120));
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toMatchObject({ error: { name: 'WorkerTimeoutError' } });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(onProgress).toHaveBeenCalledTimes(1);
    } finally {
      post.mockRestore();
      vi.useRealTimers();
    }
  });

  it('rejects foreign and malformed updates without replacing a valid pending update', async () => {
    vi.useFakeTimers();
    const post = vi.spyOn(ThrowingWorker.prototype, 'postMessage').mockImplementation(() => {});
    try {
      const onProgress = vi.fn();
      const pending = runPipelineViaWorker(
        new Blob(['video']),
        validDecoderConfig,
        validOptions,
        onProgress
      );
      const worker = ThrowingWorker.instance!;
      emitWorkerMessage(worker, progressMessage('demuxing', 5, 0, 0));
      await vi.advanceTimersByTimeAsync(20);
      emitWorkerMessage(worker, progressMessage('encoding', 40, 18, 120));
      emitWorkerMessage(worker, progressMessage('encoding', 90, 20, 300, 'foreign-request'));
      emitWorkerMessage(worker, { ...progressMessage('encoding', 95, 20, 300), fps: -1 });
      await vi.advanceTimersByTimeAsync(80);
      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(onProgress.mock.calls[1]?.[0]).toMatchObject({
        phase: 'encoding',
        progress: 40,
        fps: 18,
        decodedFrames: 120,
      });
      const outputBuffer = new ArrayBuffer(4);
      emitWorkerMessage(worker, {
        type: 'complete',
        requestId: 'request-1',
        outputBuffer,
        durationMs: 110,
      });
      await expect(pending).resolves.toBe(outputBuffer);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      post.mockRestore();
      vi.useRealTimers();
    }
  });

  it('clears progress queued during a failing postMessage', async () => {
    vi.useFakeTimers();
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(1);
    const post = vi.spyOn(ThrowingWorker.prototype, 'postMessage').mockImplementation(function (
      this: ThrowingWorker
    ) {
      emitWorkerMessage(this, progressMessage('demuxing', 5, 0, 0));
      emitWorkerMessage(this, progressMessage('encoding', 40, 18, 120));
      throw new Error('structured clone failed');
    });
    try {
      const onProgress = vi.fn();
      await expect(
        runPipelineViaWorker(new Blob(['video']), validDecoderConfig, validOptions, onProgress)
      ).rejects.toMatchObject({ name: 'WorkerUnavailableError' });
      expect(onProgress).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(onProgress).toHaveBeenCalledTimes(1);
    } finally {
      post.mockRestore();
      now.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not leak an old pending update into a newer run', async () => {
    vi.useFakeTimers();
    const post = vi.spyOn(ThrowingWorker.prototype, 'postMessage').mockImplementation(() => {});
    try {
      const firstProgress = vi.fn();
      const first = runPipelineViaWorker(
        new Blob(['first']),
        validDecoderConfig,
        validOptions,
        firstProgress
      );
      const priorWorker = ThrowingWorker.instance!;
      emitWorkerMessage(priorWorker, progressMessage('demuxing', 5, 0, 0));
      await vi.advanceTimersByTimeAsync(20);
      emitWorkerMessage(priorWorker, progressMessage('encoding', 40, 18, 120));
      const firstOutput = new ArrayBuffer(4);
      emitWorkerMessage(priorWorker, {
        type: 'complete',
        requestId: 'request-1',
        outputBuffer: firstOutput,
        durationMs: 30,
      });
      await expect(first).resolves.toBe(firstOutput);

      const nextProgress = vi.fn();
      const next = runPipelineViaWorker(
        new Blob(['next']),
        validDecoderConfig,
        validOptions,
        nextProgress
      );
      const nextWorker = ThrowingWorker.instance!;
      emitWorkerMessage(priorWorker, progressMessage('encoding', 90, 30, 300));
      emitWorkerMessage(nextWorker, progressMessage('demuxing', 5, 0, 0));
      await vi.advanceTimersByTimeAsync(100);
      expect(firstProgress).toHaveBeenCalledTimes(1);
      expect(nextProgress).toHaveBeenCalledTimes(1);
      const nextOutput = new ArrayBuffer(4);
      emitWorkerMessage(nextWorker, {
        type: 'complete',
        requestId: 'request-1',
        outputBuffer: nextOutput,
        durationMs: 100,
      });
      await expect(next).resolves.toBe(nextOutput);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      post.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['complete', 'error'] as const)(
    'ignores malformed responses and foreign %s terminals before its own completion',
    async (type) => {
      const outputBuffer = new ArrayBuffer(4);
      const foreign =
        type === 'complete'
          ? { type, requestId: 'other-request', outputBuffer: new ArrayBuffer(8), durationMs: 1 }
          : { type, requestId: 'other-request', message: 'foreign failure', code: 'DECODER_ERROR' };
      ThrowingWorker.response = [
        null,
        1,
        'primitive',
        [],
        { type: 'complete', requestId: 'request-1', outputBuffer: 'invalid', durationMs: 1 },
        foreign,
        { type: 'complete', requestId: 'request-1', outputBuffer, durationMs: 1 },
      ];
      const onProgress = vi.fn();
      await expect(
        runPipelineWithFallback(new Blob(['video']), validDecoderConfig, validOptions, onProgress)
      ).resolves.toBe(outputBuffer);
      expect(onProgress).not.toHaveBeenCalled();
      expect(runConversionPipeline).not.toHaveBeenCalled();
      expect(ThrowingWorker.instance?.terminate).toHaveBeenCalledOnce();
    }
  );

  it.each(['post-bootstrap error', 'memory limit', 'abort', 'timeout'] as const)(
    'settles %s without fallback, retained timers/listeners, or late progress',
    async (terminal) => {
      vi.useFakeTimers();
      const post = vi.spyOn(ThrowingWorker.prototype, 'postMessage').mockImplementation(() => {});
      const controller = new AbortController();
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
      const onProgress = vi.fn();
      try {
        const pending = runPipelineWithFallback(
          new Blob(['video']),
          validDecoderConfig,
          validOptions,
          onProgress,
          controller.signal
        );
        const rejection = expect(pending).rejects.toThrow(
          terminal === 'post-bootstrap error'
            ? 'Worker error: post-bootstrap failure'
            : terminal === 'memory limit'
              ? 'Worker ran out of memory'
              : terminal === 'abort'
                ? 'Cancelled'
                : 'Worker timed out'
        );
        const worker = ThrowingWorker.instance;
        if (!worker) throw new Error('Worker did not start');
        if (terminal === 'post-bootstrap error') {
          worker.onmessage?.(
            new MessageEvent('message', {
              data: {
                type: 'log',
                requestId: '',
                level: 'info',
                category: 'general',
                message: 'Worker initialized',
              },
            })
          );
          worker.onerror?.(new ErrorEvent('error', { message: 'post-bootstrap failure' }));
        } else if (terminal === 'memory limit') {
          worker.onmessage?.(
            new MessageEvent('message', {
              data: {
                type: 'error',
                requestId: 'request-1',
                code: 'OUT_OF_MEMORY',
                message: 'budget',
              },
            })
          );
        } else if (terminal === 'abort') {
          controller.abort();
        } else {
          await vi.advanceTimersByTimeAsync(WORKER_PIPELINE_TIMEOUT_MS);
        }
        await rejection;
        expect(runConversionPipeline).not.toHaveBeenCalled();
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
        expect(vi.getTimerCount()).toBe(0);
        worker.onmessage?.(
          new MessageEvent('message', {
            data: {
              type: 'progress',
              requestId: 'request-1',
              phase: 'encoding',
              percent: 100,
              fps: 1,
              memoryMB: null,
              etaSeconds: null,
            },
          })
        );
        worker.onmessage?.(
          new MessageEvent('message', {
            data: {
              type: 'complete',
              requestId: 'request-1',
              outputBuffer: new ArrayBuffer(4),
              durationMs: 1,
            },
          })
        );
        expect(onProgress).not.toHaveBeenCalled();
        expect(worker.terminate).toHaveBeenCalledOnce();
      } finally {
        post.mockRestore();
        removeListener.mockRestore();
        vi.useRealTimers();
      }
    }
  );

  it('cleans up the worker when starting the pipeline throws synchronously', async () => {
    vi.useFakeTimers();

    try {
      await expect(
        runPipelineViaWorker(new ArrayBuffer(8), {} as never, {} as never, vi.fn())
      ).rejects.toThrow('structured clone failed');
      expect(ThrowingWorker.instance?.terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a Blob handle without a transfer list or a full-file read', async () => {
    const input = new Blob(['video']);
    const readWholeFile = vi.fn().mockRejectedValue(new Error('Unexpected full-file read'));
    Object.defineProperty(input, 'arrayBuffer', { value: readWholeFile });
    const outputBuffer = new ArrayBuffer(4);
    ThrowingWorker.response = {
      type: 'complete',
      requestId: 'request-1',
      outputBuffer,
      durationMs: 10,
    };
    const postMessage = vi.spyOn(ThrowingWorker.prototype, 'postMessage');
    try {
      await expect(
        runPipelineViaWorker(input, validDecoderConfig, validOptions, vi.fn())
      ).resolves.toBe(outputBuffer);
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'start', inputBlob: input }),
        []
      );
      expect(postMessage.mock.calls[0]?.[0]).not.toHaveProperty('inputBuffer');
      expect(readWholeFile).not.toHaveBeenCalled();
    } finally {
      postMessage.mockRestore();
    }
  });

  it('keeps the Blob available for lazy fallback after worker bootstrap fails', async () => {
    const input = new Blob(['video']);
    const readWholeFile = vi.fn().mockRejectedValue(new Error('Unexpected full-file read'));
    Object.defineProperty(input, 'arrayBuffer', { value: readWholeFile });
    ThrowingWorker.workerError = new ErrorEvent('error', { message: 'Worker bootstrap failed' });
    const output = new ArrayBuffer(4);
    runConversionPipeline.mockResolvedValue(output);

    await expect(
      runPipelineWithFallback(input, validDecoderConfig, validOptions, vi.fn())
    ).resolves.toBe(output);

    expect(runConversionPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ inputBlob: input }),
      expect.any(Function),
      undefined
    );
    expect(runConversionPipeline.mock.calls[0]?.[0]).not.toHaveProperty('inputBuffer');
    expect(readWholeFile).not.toHaveBeenCalled();
    expect(ThrowingWorker.instance?.terminate).toHaveBeenCalledOnce();
  });

  it('materializes WebP Blob only at the legacy fallback ArrayBuffer boundary', async () => {
    ThrowingWorker.workerError = new ErrorEvent('error', { message: 'Worker bootstrap failed' });
    const output = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
    const read = vi.spyOn(output, 'arrayBuffer');
    runConversionPipeline.mockResolvedValueOnce(output);

    const result = await runPipelineWithFallback(
      new Blob(['video']),
      validDecoderConfig,
      { ...validOptions, format: 'webp' },
      vi.fn()
    );

    expect(Array.from(new Uint8Array(result))).toEqual([1, 2, 3]);
    expect(read).toHaveBeenCalledOnce();
  });

  it('rejects an oversized codec description before constructing a Worker', async () => {
    const config = {
      ...validDecoderConfig,
      description: new ArrayBuffer(MAX_CODEC_DESCRIPTION_BYTES + 1),
    };

    await expect(
      runPipelineViaWorker(new ArrayBuffer(8), config, {} as never, vi.fn())
    ).rejects.toThrow('Invalid worker codec description');

    expect(ThrowingWorker.constructionCount).toBe(0);
  });

  it('retains a validated profile returned from the Worker realm', async () => {
    const outputBuffer = new ArrayBuffer(4);
    const profile = {
      schemaVersion: 4 as const,
      totalDurationMs: 100,
      heapStartMB: null,
      heapEndMB: null,
      heapPeakMB: null,
      encoderRoute: 'gif-worker' as const,
      stages: [],
      operationTotals: {
        pixelCopy: { wallMs: 0, samples: 0 },
        motionFeatures: { wallMs: 0, samples: 0 },
        motionDecision: { wallMs: 0, samples: 0 },
        gifPixelPreparation: { wallMs: 0, samples: 0 },
        gifQuantization: { wallMs: 0, samples: 0 },
        gifPaletteMapping: { wallMs: 0, samples: 0 },
        gifFrameWrite: { wallMs: 0, samples: 0 },
        webpEncoding: { wallMs: 0, samples: 0 },
        encoderQueueWait: { wallMs: 0, samples: 0 },
        webpMuxing: { wallMs: 0, samples: 0 },
        muxFinalization: { wallMs: 0, samples: 0 },
        outputCopy: { wallMs: 0, samples: 0 },
      },
      copyPathCounts: { RGBX: 0, RGBA: 0, BGRA: 0, BGRX: 0, canvas: 0, unknown: 0 },
      stageWallTimePct: { demuxing: 0, transcoding: 0, finalizing: 0 },
      dominantStage: null,
      summary: '[100ms total]',
    };
    ThrowingWorker.response = {
      type: 'complete',
      requestId: 'request-1',
      outputBuffer,
      durationMs: 100,
      profile,
    };

    try {
      await expect(
        runPipelineViaWorker(new ArrayBuffer(8), {} as never, {} as never, vi.fn())
      ).resolves.toBe(outputBuffer);
      expect(getLastConversionProfileReport()).toEqual(profile);
      expect(ThrowingWorker.instance?.terminate).toHaveBeenCalledOnce();
    } finally {
      ThrowingWorker.response = null;
    }
  });

  it('preserves exact worker counters and delivers terminal progress through the throttle', async () => {
    const outputBuffer = new ArrayBuffer(4);
    const onProgress = vi.fn();
    ThrowingWorker.response = [
      {
        type: 'progress',
        requestId: 'request-1',
        phase: 'encoding',
        percent: 50,
        fps: 10,
        etaSeconds: null,
        memoryMB: null,
        accountedMemoryMB: 12,
        decodedFrames: 20,
        encodedFrames: 4,
      },
      {
        type: 'progress',
        requestId: 'request-1',
        phase: 'assembling',
        percent: 100,
        fps: 0,
        etaSeconds: 0,
        memoryMB: null,
        accountedMemoryMB: 14,
        consumedChunks: 24,
        decodedFrames: 20,
        selectedFrames: 5,
        encodedFrames: 4,
        emittedFrames: 3,
        outputFrames: 3,
      },
      { type: 'complete', requestId: 'request-1', outputBuffer, durationMs: 10 },
    ];

    await expect(
      runPipelineViaWorker(new ArrayBuffer(8), validDecoderConfig, validOptions, onProgress)
    ).resolves.toBe(outputBuffer);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls.at(-1)?.[0]).toMatchObject({
      progress: 100,
      memoryMB: null,
      accountedMemoryMB: 14,
      consumedChunks: 24,
      decodedFrames: 20,
      selectedFrames: 5,
      encodedFrames: 4,
      emittedFrames: 3,
      outputFrames: 3,
      etaSeconds: 0,
    });
  });

  it.each(['complete', 'error', 'cancel'] as const)(
    'ignores late %s progress during the next Worker conversion',
    async (ending) => {
      const workerProgress = (decodedFrames: number) => ({
        type: 'progress' as const,
        requestId: 'request-1',
        phase: 'decoding' as const,
        percent: 30,
        fps: 10,
        etaSeconds: 1,
        memoryMB: null,
        accountedMemoryMB: 12,
        decodedFrames,
        currentFrame: decodedFrames,
        totalFrames: 13,
      });
      const firstOutput = new ArrayBuffer(4);
      ThrowingWorker.response = [
        workerProgress(3),
        ...(ending === 'complete'
          ? [
              {
                type: 'complete',
                requestId: 'request-1',
                outputBuffer: firstOutput,
                durationMs: 10,
              },
            ]
          : ending === 'error'
            ? [
                {
                  type: 'error',
                  requestId: 'request-1',
                  message: 'fixture failure',
                  code: 'DECODER_ERROR',
                },
              ]
            : []),
      ];
      const firstProgress = vi.fn();
      const controller = new AbortController();
      const first = runPipelineViaWorker(
        new ArrayBuffer(8),
        validDecoderConfig,
        validOptions,
        firstProgress,
        controller.signal
      );
      const priorWorker = ThrowingWorker.instance!;
      if (ending === 'cancel') {
        await vi.waitFor(() => expect(firstProgress).toHaveBeenCalledOnce());
        controller.abort();
        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
      } else if (ending === 'error') {
        await expect(first).rejects.toThrow('Worker error: fixture failure');
      } else {
        await expect(first).resolves.toBe(firstOutput);
      }
      expect(firstProgress).toHaveBeenCalledOnce();

      const nextOutput = new ArrayBuffer(4);
      ThrowingWorker.response = [
        workerProgress(1),
        {
          type: 'progress',
          requestId: 'request-1',
          phase: 'assembling',
          percent: 100,
          fps: 0,
          etaSeconds: 0,
          memoryMB: null,
          accountedMemoryMB: 14,
          decodedFrames: 13,
          selectedFrames: 5,
          emittedFrames: 2,
          outputFrames: 2,
        },
        { type: 'complete', requestId: 'request-1', outputBuffer: nextOutput, durationMs: 10 },
      ];
      const nextProgress = vi.fn();
      const next = runPipelineViaWorker(
        new ArrayBuffer(8),
        validDecoderConfig,
        validOptions,
        nextProgress
      );
      priorWorker.onmessage?.(new MessageEvent('message', { data: workerProgress(99) }));
      await expect(next).resolves.toBe(nextOutput);
      expect(firstProgress).toHaveBeenCalledOnce();
      expect(nextProgress.mock.calls.map(([progress]) => progress.decodedFrames)).toEqual([1, 13]);
      expect(nextProgress.mock.calls.at(-1)?.[0]).toMatchObject({
        progress: 100,
        decodedFrames: 13,
        selectedFrames: 5,
        emittedFrames: 2,
        outputFrames: 2,
      });
    }
  );

  it('ignores worker diagnostics that do not belong to the current request', async () => {
    const outputBuffer = new ArrayBuffer(4);
    ThrowingWorker.response = [
      {
        type: 'log',
        requestId: '',
        level: 'warn',
        category: 'general',
        message: 'not a valid bootstrap message',
      },
      {
        type: 'log',
        requestId: 'another-request',
        level: 'error',
        category: 'conversion',
        message: 'foreign request',
      },
      {
        type: 'log',
        requestId: 'request-1',
        level: 'warn',
        category: 'encoders',
        message: 'request checkpoint',
      },
      {
        type: 'complete',
        requestId: 'request-1',
        outputBuffer,
        durationMs: 10,
      },
    ];

    await expect(
      runPipelineViaWorker(new ArrayBuffer(8), validDecoderConfig, validOptions, vi.fn())
    ).resolves.toBe(outputBuffer);

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith('encoders', 'request checkpoint', {
      source: 'worker',
      requestId: 'request-1',
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each(['debug', 'info', 'warn', 'error'] as const)(
    'preserves worker %s severity in the main logger',
    async (level) => {
      const outputBuffer = new ArrayBuffer(4);
      ThrowingWorker.response = [
        {
          type: 'log',
          requestId: 'request-1',
          level,
          category: 'conversion',
          message: `${level} checkpoint`,
        },
        {
          type: 'complete',
          requestId: 'request-1',
          outputBuffer,
          durationMs: 10,
        },
      ];

      await expect(
        runPipelineViaWorker(new ArrayBuffer(8), validDecoderConfig, validOptions, vi.fn())
      ).resolves.toBe(outputBuffer);

      expect(logger[level]).toHaveBeenCalledWith('conversion', `${level} checkpoint`, {
        source: 'worker',
        requestId: 'request-1',
      });
    }
  );

  it.each(invalidPreWorkerConfigs)(
    'rejects $name before constructing a Worker or transferring input',
    async ({ config }) => {
      const inputBuffer = new ArrayBuffer(8);
      const onProgress = vi.fn();

      await expect(
        runPipelineWithFallback(inputBuffer, config, {} as never, onProgress)
      ).rejects.toThrow('Unable to determine video dimensions');

      expect(ThrowingWorker.constructionCount).toBe(0);
      expect(inputBuffer.byteLength).toBe(8);
      expect(onProgress).not.toHaveBeenCalled();
    }
  );

  it('continues through the Worker path for safe display-aspect dimensions', async () => {
    const outputBuffer = new ArrayBuffer(4);
    ThrowingWorker.response = {
      type: 'complete',
      requestId: 'request-1',
      outputBuffer,
      durationMs: 1,
    };

    await expect(
      runPipelineWithFallback(
        new ArrayBuffer(8),
        {
          codec: 'vp09.00.10.08',
          codedWidth: 16,
          codedHeight: 16,
          displayAspectWidth: 32,
          displayAspectHeight: 16,
        },
        validOptions,
        vi.fn()
      )
    ).resolves.toBe(outputBuffer);

    expect(ThrowingWorker.constructionCount).toBe(1);
  });

  it('falls back from an unavailable Worker without copying a transferred Blob', async () => {
    const outputBuffer = new ArrayBuffer(4);
    const inputBlob = new Blob([new Uint8Array([1, 2, 3])]);
    const arrayBufferSpy = vi.spyOn(inputBlob, 'arrayBuffer');
    ThrowingWorker.workerError = new ErrorEvent('error', { message: 'module failed to load' });
    runConversionPipeline.mockResolvedValue(outputBuffer);

    await expect(
      runPipelineWithFallback(
        new ArrayBuffer(8),
        validDecoderConfig,
        validOptions,
        vi.fn(),
        undefined,
        inputBlob
      )
    ).resolves.toBe(outputBuffer);

    expect(arrayBufferSpy).not.toHaveBeenCalled();
    expect(runConversionPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ inputBlob }),
      expect.any(Function),
      undefined
    );
    expect(runConversionPipeline.mock.calls[0]?.[0]).not.toHaveProperty('inputBuffer');
  });

  it('does not retry a media pipeline failure on the main thread', async () => {
    const inputBlob = new Blob([new Uint8Array([1, 2, 3])]);
    const arrayBufferSpy = vi.spyOn(inputBlob, 'arrayBuffer');
    ThrowingWorker.response = {
      type: 'error',
      requestId: 'request-1',
      message: 'Unable to parse media container',
      code: 'DECODER_ERROR',
    };

    await expect(
      runPipelineWithFallback(
        new ArrayBuffer(8),
        validDecoderConfig,
        validOptions,
        vi.fn(),
        undefined,
        inputBlob
      )
    ).rejects.toThrow('Worker error: Unable to parse media container');

    expect(arrayBufferSpy).not.toHaveBeenCalled();
    expect(runConversionPipeline).not.toHaveBeenCalled();
  });

  it('preserves main-thread fallback when Worker construction is unavailable', async () => {
    const outputBuffer = new ArrayBuffer(4);
    const inputBuffer = new ArrayBuffer(8);
    ThrowingWorker.constructionError = new Error('Worker constructor unavailable');
    runConversionPipeline.mockResolvedValue(outputBuffer);

    await expect(
      runPipelineWithFallback(
        inputBuffer,
        validDecoderConfig,
        validOptions,
        vi.fn(),
        undefined,
        new Blob()
      )
    ).resolves.toBe(outputBuffer);

    expect(runConversionPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ inputBuffer }),
      expect.any(Function),
      undefined
    );
    expect(runConversionPipeline.mock.calls[0]?.[0]).not.toHaveProperty('inputBlob');
  });
});
