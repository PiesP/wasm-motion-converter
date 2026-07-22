import { describe, expect, it, vi } from 'vitest';

import { globalBufferPool } from '@services/buffer-pool';
import { withPooledBuffer } from '@services/pooled-buffer';

describe('withPooledBuffer', () => {
  it('returns the pooled buffer when the operation rejects', async () => {
    const buffer = new Uint8Array(12);
    const release = vi.spyOn(globalBufferPool, 'release');
    const failure = new Error('encode failed');

    await expect(
      withPooledBuffer(buffer, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);

    expect(release).toHaveBeenCalledWith(buffer);
    release.mockRestore();
  });
});
