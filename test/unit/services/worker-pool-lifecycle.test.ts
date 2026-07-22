import { describe, expect, it, vi } from 'vitest';

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
});
