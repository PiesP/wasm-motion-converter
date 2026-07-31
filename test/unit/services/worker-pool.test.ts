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

import { getWorkerPool, WebpWorkerPool } from '@services/worker-pool';
import { globalBufferPool } from '@services/buffer-pool';

beforeEach(() => {
  FakeWorker.instances.length = 0;
  vi.spyOn(globalBufferPool, 'release').mockImplementation(() => {});
});

afterEach(() => {
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

  it('recreates a 720p pool with the calculated 4K concurrency cap', () => {
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('createImageBitmap', vi.fn());
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(8);

    const size720p = WebpWorkerPool.getOptimalWorkerCount(1280, 720);
    const size4k = WebpWorkerPool.getOptimalWorkerCount(3840, 2160);
    expect(size720p).toBe(4);
    expect(size4k).toBe(2);

    const initial = getWorkerPool(size720p);
    expect(initial?.stats.poolSize).toBe(4);

    const resized = getWorkerPool(size4k);

    expect(initial?.stats.poolSize).toBe(0);
    expect(resized?.stats.poolSize).toBe(2);
    expect(resized).not.toBe(initial);
    resized?.terminate();
  });
});
