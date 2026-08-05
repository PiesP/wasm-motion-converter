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
import { getLastConversionProfileReport } from '@services/conversion-profile-store';

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

  it('rejects oversized display-aspect dimensions before constructing a Worker', async () => {
    ThrowingWorker.response = {
      type: 'error',
      requestId: 'request-1',
      message: 'synthetic worker failure',
      code: 'OUT_OF_MEMORY',
    };

    await expect(
      runPipelineWithFallback(
        new ArrayBuffer(8),
        {
          codec: 'vp09.00.30.08.01.02.02.02.00',
          codedWidth: 520,
          codedHeight: 520,
          displayAspectWidth: 52_000,
          displayAspectHeight: 520,
        },
        {} as never,
        vi.fn()
      )
    ).rejects.toThrow('Unable to determine video dimensions');

    expect(ThrowingWorker.constructionCount).toBe(0);
  });

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
