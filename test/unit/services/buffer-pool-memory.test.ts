// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it } from 'vitest';
import { BufferPool } from '@services/buffer-pool';

describe('BufferPool memory accounting', () => {
  it('accounts for checked-out buffers as well as idle pooled buffers', () => {
    const pool = new BufferPool(4, 1024);
    const first = pool.acquire(100);
    const second = pool.acquire(100);

    expect(pool.totalActiveMemory).toBe(256);
    expect(pool.totalRetainedMemory).toBe(256);

    pool.release(first);
    expect(pool.totalActiveMemory).toBe(128);
    expect(pool.totalPooledMemory).toBe(128);
    expect(pool.totalRetainedMemory).toBe(256);

    pool.releaseTransferred(second.buffer as ArrayBuffer);
    expect(pool.totalActiveMemory).toBe(0);
    expect(pool.totalRetainedMemory).toBe(128);
  });
});
