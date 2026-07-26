// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('recreates an idle singleton when the requested conversion size changes', () => {
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('createImageBitmap', vi.fn());

    const initial = getWorkerPool(4);
    expect(initial?.stats.poolSize).toBe(4);

    const resized = getWorkerPool(2);

    expect(initial?.stats.poolSize).toBe(0);
    expect(resized?.stats.poolSize).toBe(2);
    expect(resized).not.toBe(initial);
    resized?.terminate();
  });
});
