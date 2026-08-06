import { beforeEach, describe, expect, it, vi } from 'vitest';

class ThrowingWorker {
  static constructionCount = 0;
  static instance: ThrowingWorker | null = null;
  static response: unknown = null;
  readonly terminate = vi.fn();
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor() {
    ThrowingWorker.constructionCount++;
    ThrowingWorker.instance = this;
  }

  postMessage(): void {
    if (ThrowingWorker.response) {
      queueMicrotask(() => this.onmessage?.(new MessageEvent('message', {
        data: ThrowingWorker.response,
      })));
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
import type { SerializedDecoderConfig } from '@services/conversion-worker/types';
import { getLastConversionProfileReport } from '@services/conversion-profile-store';

const validDecoderConfig: SerializedDecoderConfig = {
  codec: 'vp09.00.10.08',
  codedWidth: 16,
  codedHeight: 16,
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
    ThrowingWorker.instance = null;
    ThrowingWorker.response = null;
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

  it('retains a validated profile returned from the Worker realm', async () => {
    const outputBuffer = new ArrayBuffer(4);
    const profile = {
      totalDurationMs: 100,
      heapStartMB: 0,
      heapEndMB: 0,
      heapPeakMB: 0,
      phases: [],
      phaseTimePct: { demuxing: 0, decoding: 0, encoding: 0, assembling: 0 },
      bottleneck: 'demuxing',
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
        {} as never,
        vi.fn()
      )
    ).resolves.toBe(outputBuffer);

    expect(ThrowingWorker.constructionCount).toBe(1);
  });
});
