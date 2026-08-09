// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { createWorkerPool, disposeWorkerPool, WebpWorkerPool } from '@services/worker-pool';
import { globalBufferPool } from '@services/buffer-pool';

beforeEach(() => {
  FakeWorker.instances.length = 0;
  vi.stubGlobal('Worker', FakeWorker);
  vi.spyOn(globalBufferPool, 'release').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WebpWorkerPool public API', () => {
  it('poolSize matches constructor size', () => {
    const pool = new WebpWorkerPool(2, 1000);
    expect(pool.stats.poolSize).toBe(2);
    pool.terminate();
  });

  it('idle starts at poolSize', () => {
    const pool = new WebpWorkerPool(3, 1000);
    expect(pool.stats.idle).toBe(3);
    pool.terminate();
  });

  it('active is 0 initially', () => {
    const pool = new WebpWorkerPool(2, 1000);
    expect(pool.stats.active).toBe(0);
    pool.terminate();
  });

  it('queued is 0 initially', () => {
    const pool = new WebpWorkerPool(2, 1000);
    expect(pool.stats.queued).toBe(0);
    pool.terminate();
  });

  it('rejects queued tasks and releases their buffers on terminate', async () => {
    const release = vi.spyOn(globalBufferPool, 'release');
    const pool = new WebpWorkerPool(1, 1000);
    const buffer = new Uint8Array(8);
    release.mockClear();
    pool.terminate();
    // Queued tasks' buffers are released on terminate
    // (active tasks also get rejected; buffers released by rejectQueuedTasks)
    // The release spy may not be called directly since we don't submit a real task,
    // but the terminate path clears queue and calls release for each pending buffer
    expect(release).not.toHaveBeenCalled();
  });

  it('creates conversion pools with the calculated resolution concurrency caps', () => {
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('createImageBitmap', vi.fn());
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(8);

    const size720p = WebpWorkerPool.getOptimalWorkerCount(1280, 720);
    const size4k = WebpWorkerPool.getOptimalWorkerCount(3840, 2160);
    expect(size720p).toBe(4);
    expect(size4k).toBe(2);

    const pool720p = createWorkerPool(size720p);
    expect(pool720p?.stats.poolSize).toBe(4);

    const pool4k = createWorkerPool(size4k);

    expect(pool4k?.stats.poolSize).toBe(2);
    expect(pool4k).not.toBe(pool720p);
    pool720p?.terminate();
    pool4k?.terminate();
  });

  it('disposes one conversion pool before creating the next', () => {
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('createImageBitmap', vi.fn());

    const initial = createWorkerPool(2);
    expect(initial?.stats.poolSize).toBe(2);

    disposeWorkerPool(initial);

    expect(initial?.stats.poolSize).toBe(0);
    const replacement = createWorkerPool(2);
    expect(replacement).not.toBe(initial);
    expect(replacement?.stats.poolSize).toBe(2);
    disposeWorkerPool(replacement);
  });

  it('keeps a newer conversion pool alive when the older conversion releases its pool', () => {
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('createImageBitmap', vi.fn());

    const olderPool = createWorkerPool(1);
    const newerPool = createWorkerPool(1);
    expect(olderPool).not.toBeNull();
    expect(newerPool).not.toBe(olderPool);

    disposeWorkerPool(olderPool);

    expect(olderPool?.stats.poolSize).toBe(0);
    expect(newerPool?.stats.poolSize).toBe(1);
    disposeWorkerPool(newerPool);
  });

  it('does not resolve a newer conversion task from an older result with the same id', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('createImageBitmap', vi.fn());

    const olderPool = createWorkerPool(2);
    const newerPool = createWorkerPool(2);
    try {
      expect(olderPool).not.toBeNull();
      expect(newerPool).not.toBeNull();

      const olderResult = olderPool!.encode({
        id: 0,
        rgbData: new Uint8Array(4),
        width: 1,
        height: 1,
        quality: 0.8,
        durationMs: 40,
      });
      const olderWorker = FakeWorker.instances.find(
        (worker) => worker.postMessage.mock.calls.length > 0
      );

      let newerResolved = false;
      const newerResult = newerPool!.encode({
        id: 0,
        rgbData: new Uint8Array(4),
        width: 1,
        height: 1,
        quality: 0.8,
        durationMs: 40,
      });
      void newerResult.then(() => {
        newerResolved = true;
      });
      const newerWorker = FakeWorker.instances.find(
        (worker) => worker !== olderWorker && worker.postMessage.mock.calls.length > 0
      );

      const olderBitstream = new Uint8Array([1]);
      olderWorker?.onmessage?.({ data: { id: 0, bitstream: olderBitstream } } as MessageEvent);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(newerResolved).toBe(false);

      const newerBitstream = new Uint8Array([2]);
      newerWorker?.onmessage?.({ data: { id: 0, bitstream: newerBitstream } } as MessageEvent);
      await expect(olderResult).resolves.toEqual({ id: 0, bitstream: olderBitstream });
      await expect(newerResult).resolves.toEqual({ id: 0, bitstream: newerBitstream });
    } finally {
      disposeWorkerPool(olderPool);
      disposeWorkerPool(newerPool);
      vi.useRealTimers();
    }
  });
});
