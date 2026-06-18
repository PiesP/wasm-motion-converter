// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Buffer Pool — reuses Uint8Array allocations to reduce GC pressure.
 *
 * Video conversion allocates many same-sized buffers per frame (RGB, RGBA,
 * copyTo targets). Without pooling, each frame triggers 2-3 new allocations
 * followed by GC. With pooling, buffers are recycled across frames.
 *
 * Usage:
 *   const pool = new BufferPool();
 *   const buf = pool.acquire(size);
 *   // ... use buf ...
 *   pool.release(buf);
 */

export class BufferPool {
  private pools: Map<number, Uint8Array[]> = new Map();
  private maxPerBucket: number;

  /** @param maxPerBucket - Max buffers to retain per size bucket (default: 4) */
  constructor(maxPerBucket = 4) {
    this.maxPerBucket = maxPerBucket;
  }

  /**
   * Acquire a buffer of at least `size` bytes.
   * Returns a pooled buffer if available, otherwise allocates new.
   */
  acquire(size: number): Uint8Array {
    const bucket = BufferPool.nextPow2(size);
    const pool = this.pools.get(bucket);
    if (pool && pool.length > 0) {
      return pool.pop()!;
    }
    return new Uint8Array(bucket);
  }

  /**
   * Release a buffer back to the pool for reuse.
   * Call after the buffer is no longer needed.
   */
  release(buf: Uint8Array): void {
    const pool = this.pools.get(buf.byteLength);
    if (pool && pool.length < this.maxPerBucket) {
      pool.push(buf);
    }
    // If pool is full or doesn't exist, let GC collect it
  }

  /** Clear all pooled buffers. Call between conversions. */
  clear(): void {
    this.pools.clear();
  }

  /** Round up to next power of 2 for bucket sizing */
  private static nextPow2(v: number): number {
    v--;
    v |= v >> 1;
    v |= v >> 2;
    v |= v >> 4;
    v |= v >> 8;
    v |= v >> 16;
    return v + 1;
  }
}

/** Global pool instance shared across frame operations */
export const globalBufferPool = new BufferPool();
