import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { globalBufferPool } from '@services/buffer-pool';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();

  constructor() {
    FakeWorker.instances.push(this);
  }
}

vi.stubGlobal('Worker', FakeWorker);

import { WebpWorkerPool } from '@services/worker-pool';

beforeEach(() => {
  FakeWorker.instances.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WebpWorkerPool buffer ownership', () => {
  it('releases queued frame buffers when the pool is terminated', async () => {
    const release = vi.spyOn(globalBufferPool, 'release');
    const pool = new WebpWorkerPool(1, 1000);
    const firstBuffer = new Uint8Array(8);
    const queuedBuffer = new Uint8Array(16);

    const first = pool.encode({
      id: 1,
      rgbData: firstBuffer,
      width: 2,
      height: 2,
      quality: 80,
      durationMs: 100,
    });
    const queued = pool.encode({
      id: 2,
      rgbData: queuedBuffer,
      width: 2,
      height: 2,
      quality: 80,
      durationMs: 100,
    });

    pool.terminate();

    await expect(first).rejects.toThrow('Worker pool terminated');
    await expect(queued).rejects.toThrow('Worker pool terminated');
    expect(release).toHaveBeenCalledWith(queuedBuffer);
    expect(release).not.toHaveBeenCalledWith(firstBuffer);
    release.mockRestore();
  });

  it('removes a failed idle worker before adding its replacement', () => {
    const pool = new WebpWorkerPool(1, 1000);
    const worker = FakeWorker.instances[0];

    worker?.onerror?.(new ErrorEvent('error', { message: 'module failed to load' }));

    expect(pool.stats).toMatchObject({ poolSize: 1, idle: 1, active: 0, queued: 0 });
  });

  it('cancels task timeouts when the pool is terminated', async () => {
    vi.useFakeTimers();
    try {
      const pool = new WebpWorkerPool(1, 1000);
      const pending = pool.encode({
        id: 1,
        rgbData: new Uint8Array(8),
        width: 2,
        height: 2,
        quality: 80,
        durationMs: 100,
      });

      expect(vi.getTimerCount()).toBe(1);
      pool.terminate();

      await expect(pending).rejects.toThrow('Worker pool terminated');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns buffer ownership and clears the timeout when transfer throws synchronously', async () => {
    vi.useFakeTimers();
    try {
      const release = vi.spyOn(globalBufferPool, 'release').mockImplementation(() => {});
      const pool = new WebpWorkerPool(1, 1000);
      const worker = FakeWorker.instances[0];
      const buffer = new Uint8Array(16);
      worker?.postMessage.mockImplementationOnce(() => {
        throw new DOMException('transfer failed', 'DataCloneError');
      });

      const pending = pool.encode({
        id: 7,
        rgbData: buffer,
        width: 2,
        height: 2,
        quality: 80,
        durationMs: 100,
      });

      await expect(pending).rejects.toThrow('transfer failed');
      expect(release).toHaveBeenCalledWith(buffer);
      expect(vi.getTimerCount()).toBe(0);
      expect(pool.stats).toMatchObject({ poolSize: 1, idle: 1, active: 0, queued: 0 });
      pool.terminate();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: 'a mismatched task id',
      response: { id: 999, bitstream: new Uint8Array([1, 2, 3]) },
    },
    {
      name: 'a non-binary bitstream',
      response: { id: 21, bitstream: 'not-a-bitstream' },
    },
    {
      name: 'an empty bitstream',
      response: { id: 21, bitstream: new Uint8Array() },
    },
  ])('rejects and retires the worker after $name response', async ({ response }) => {
    const pool = new WebpWorkerPool(1, 1000);
    const worker = FakeWorker.instances[0];
    const pending = pool.encode({
      id: 21,
      rgbData: new Uint8Array([0, 0, 0]),
      width: 1,
      height: 1,
      quality: 0.8,
      durationMs: 40,
    });

    worker?.onmessage?.({ data: response } as MessageEvent);
    try {
      expect(worker?.terminate).toHaveBeenCalled();
      await expect(pending).rejects.toThrow('Invalid WebP worker response for task 21');
    } finally {
      pool.terminate();
    }
  });

  it('accepts a matching non-empty bitstream response', async () => {
    const pool = new WebpWorkerPool(1, 1000);
    const worker = FakeWorker.instances[0];
    const pending = pool.encode({
      id: 22,
      rgbData: new Uint8Array([0, 0, 0]),
      width: 1,
      height: 1,
      quality: 0.8,
      durationMs: 40,
    });
    const bitstream = new Uint8Array([1, 2, 3]);

    worker?.onmessage?.({ data: { id: 22, bitstream } } as MessageEvent);

    await expect(pending).resolves.toEqual({ id: 22, bitstream });
    expect(worker?.terminate).not.toHaveBeenCalled();
    expect(pool.stats).toMatchObject({ poolSize: 1, idle: 1, active: 0, queued: 0 });
    pool.terminate();
  });
});
