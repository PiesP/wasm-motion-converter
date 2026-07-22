import { describe, expect, it, vi } from 'vitest';

class ThrowingWorker {
  static instance: ThrowingWorker | null = null;
  readonly terminate = vi.fn();
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor() {
    ThrowingWorker.instance = this;
  }

  postMessage(): never {
    throw new Error('structured clone failed');
  }
}

vi.stubGlobal('Worker', ThrowingWorker);
vi.stubGlobal('crypto', { randomUUID: () => 'request-1' });

import { runPipelineViaWorker } from '@services/conversion-worker/main-thread-proxy';

describe('runPipelineViaWorker lifecycle', () => {
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
});
