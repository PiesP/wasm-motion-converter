import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      structuredClone(message, { transfer });
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

import {
  runPipelineViaWorker,
  runPipelineWithFallback,
} from '@services/conversion-worker/main-thread-proxy';
import type {
  SerializedConversionOptions,
  SerializedDecoderConfig,
} from '@services/conversion-worker/types';
import { getLastConversionProfileReport } from '@services/conversion-profile-store';
import { MAX_CODEC_DESCRIPTION_BYTES } from '@utils/constants';

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
      schemaVersion: 2 as const,
      totalDurationMs: 100,
      heapStartMB: 0,
      heapEndMB: 0,
      heapPeakMB: 0,
      stages: [],
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
