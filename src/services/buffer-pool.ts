// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import {
  BYTES_PER_MB,
  DEVICE_MEMORY_HEAP_RATIO,
  WORKER_MAX_MEMORY_MB,
} from '../utils/constants.js';
import { getMemoryInfo } from '../utils/memory-monitor.js';

/**
 * Default maximum total pooled memory: 512 MB.
 * Derived from WORKER_MAX_MEMORY_MB to maintain a single source of truth.
 *
 * Note: this is a conservative default. For large-video conversions on
 * memory-constrained devices, the pool can hold too much if uncapped.
 * Consider lowering this based on deviceMemory or jsHeapSizeLimit.
 */
const DEFAULT_MAX_TOTAL_MEMORY = WORKER_MAX_MEMORY_MB * BYTES_PER_MB;

/**
 * Determine a reasonable default maxTotalMemory based on available JS heap.
 * Uses DEVICE_MEMORY_HEAP_RATIO of jsHeapSizeLimit (capped at 512MB) so the
 * pool adapts to the browser's actual memory budget. Falls back to 512MB if
 * heap info unavailable.
 */
function getDefaultMaxTotalMemory(): number {
  const memInfo = getMemoryInfo();
  const limit = memInfo?.jsHeapSizeLimit;
  if (limit && limit > 0) {
    // Use DEVICE_MEMORY_HEAP_RATIO of total JS heap limit, capped at 512MB
    return Math.min(Math.round(limit * DEVICE_MEMORY_HEAP_RATIO), DEFAULT_MAX_TOTAL_MEMORY);
  }
  return DEFAULT_MAX_TOTAL_MEMORY;
}

/**
 * Buffer Pool — reuses Uint8Array allocations to reduce GC pressure.
 *
 * Video conversion allocates many same-sized buffers per frame (RGB, RGBA,
 * copyTo targets). Without pooling, each frame triggers 2-3 new allocations
 * followed by GC. With pooling, buffers are recycled across frames.
 *
 * A total memory cap prevents unbounded growth: when the pooled memory
 * exceeds the limit, release() silently discards buffers instead of pooling
 * them, allowing GC to reclaim the memory.
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
  private maxTotalMemory: number;
  private totalPooledBytes: number = 0;
  private activeAllocations = new WeakMap<ArrayBuffer, number>();
  private totalActiveBytes = 0;

  /**
   * @param maxPerBucket - Max buffers to retain per size bucket (default: 4)
   * @param maxTotalMemory - Max total bytes across all pooled buffers (default: auto-detect from heap limit)
   */
  constructor(maxPerBucket = 4, maxTotalMemory: number = getDefaultMaxTotalMemory()) {
    this.maxPerBucket = maxPerBucket;
    this.maxTotalMemory = maxTotalMemory;
  }

  /**
   * Acquire a buffer of at least `size` bytes.
   * Returns a pooled buffer if available, otherwise allocates new.
   */
  acquire(size: number): Uint8Array {
    const bucket = getPooledBufferSize(size);
    const pool = this.pools.get(bucket);
    if (pool && pool.length > 0) {
      const buf = pool.pop()!;
      this.totalPooledBytes -= buf.byteLength;
      this.trackActive(buf);
      return buf;
    }
    const buf = new Uint8Array(bucket);
    this.trackActive(buf);
    return buf;
  }

  /**
   * Release a buffer back to the pool for reuse.
   * Call after the buffer is no longer needed.
   * If adding this buffer would exceed the total memory cap,
   * it is silently discarded (GC will reclaim it).
   */
  release(buf: Uint8Array): void {
    this.releaseActive(buf.buffer);
    if (buf.byteLength === 0 || (buf.byteLength & (buf.byteLength - 1)) !== 0) {
      return;
    }

    // Check total memory cap before accepting
    if (this.totalPooledBytes + buf.byteLength > this.maxTotalMemory) {
      // Over budget — let GC collect it
      return;
    }
    let pool = this.pools.get(buf.byteLength);
    if (!pool) {
      pool = [];
      this.pools.set(buf.byteLength, pool);
    }
    if (pool.length < this.maxPerBucket) {
      pool.push(buf);
      this.totalPooledBytes += buf.byteLength;
    }
    // If pool is full or doesn't exist, let GC collect it
  }

  /** Clear all pooled buffers. Call between conversions. */
  clear(): void {
    this.pools.clear();
    this.totalPooledBytes = 0;
    this.activeAllocations = new WeakMap<ArrayBuffer, number>();
    this.totalActiveBytes = 0;
  }

  /** Current total bytes held in pooled buffers (for diagnostics) */
  get totalPooledMemory(): number {
    return this.totalPooledBytes;
  }

  /** Current bytes checked out by frame processing. */
  get totalActiveMemory(): number {
    return this.totalActiveBytes;
  }

  /** Pooled plus checked-out bytes retained by this realm. */
  get totalRetainedMemory(): number {
    return this.totalPooledBytes + this.totalActiveBytes;
  }

  /** Release accounting after a successful zero-copy transfer to another realm. */
  releaseTransferred(buffer: ArrayBuffer): void {
    this.releaseActive(buffer);
  }

  private trackActive(buf: Uint8Array): void {
    if (!(buf.buffer instanceof ArrayBuffer)) return;
    this.activeAllocations.set(buf.buffer, buf.byteLength);
    this.totalActiveBytes += buf.byteLength;
  }

  private releaseActive(buffer: ArrayBufferLike): void {
    if (!(buffer instanceof ArrayBuffer)) return;
    const bytes = this.activeAllocations.get(buffer);
    if (bytes === undefined) return;
    this.activeAllocations.delete(buffer);
    this.totalActiveBytes = Math.max(0, this.totalActiveBytes - bytes);
  }
}

/** Round a requested RGB allocation to the pool's power-of-two bucket. */
export function getPooledBufferSize(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError('Buffer allocation size must be a non-negative safe integer');
  }
  if (size === 0) return 0;
  return 2 ** Math.ceil(Math.log2(size));
}

/** Global pool instance shared across frame operations */
export const globalBufferPool = new BufferPool();
