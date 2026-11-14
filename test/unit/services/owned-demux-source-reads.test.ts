// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import {
  ownedReadCreditStats,
  readOwnedRange,
  readOwnedRangeWithLease,
  tryAcquireOwnedReadLease,
} from '@services/owned-demux-source-reads';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const CAP_BYTES = 16 * 1024 * 1024;
afterEach(() => vi.useRealTimers());

describe('owned demux realm read credit', () => {
  it('retains a completed window charge until an idempotent release', async () => {
    const lease = tryAcquireOwnedReadLease(4);
    expect(lease).not.toBeNull();
    const source = { slice: vi.fn(() => ({ arrayBuffer: async () => new ArrayBuffer(4) })) };
    await expect(readOwnedRangeWithLease(source, 0, 4, lease!)).resolves.toHaveProperty(
      'byteLength',
      4
    );
    expect(ownedReadCreditStats().liveBytes).toBe(4);
    lease!.release();
    lease!.release();
    expect(ownedReadCreditStats()).toEqual({ liveBytes: 0, retiredBytes: 0, waiters: 0 });
  });

  it('rejects duplicate claims without settling or retiring the first pending lease', async () => {
    const delayed = Promise.withResolvers<ArrayBuffer>();
    const source = { slice: vi.fn(() => ({ arrayBuffer: () => delayed.promise })) };
    const lease = tryAcquireOwnedReadLease(4)!;
    const first = readOwnedRangeWithLease(source, 0, 4, lease);
    await vi.waitFor(() => expect(source.slice).toHaveBeenCalledOnce());
    await expect(readOwnedRangeWithLease(source, 0, 4, lease)).rejects.toThrow('lease invalid');
    await expect(readOwnedRangeWithLease(source, 0, 3, lease)).rejects.toThrow('lease invalid');
    const aborted = new AbortController();
    aborted.abort();
    await expect(readOwnedRangeWithLease(source, 0, 4, lease, aborted.signal)).rejects.toThrow(
      'lease invalid'
    );
    expect(source.slice).toHaveBeenCalledOnce();
    expect(ownedReadCreditStats()).toEqual({ liveBytes: 4, retiredBytes: 0, waiters: 0 });
    delayed.resolve(new ArrayBuffer(4));
    await expect(first).resolves.toHaveProperty('byteLength', 4);
    expect(ownedReadCreditStats().liveBytes).toBe(4);
    lease.release();
    expect(ownedReadCreditStats()).toEqual({ liveBytes: 0, retiredBytes: 0, waiters: 0 });
  });

  it('retains a released pending lease without an AbortSignal until I/O settles', async () => {
    const delayed = Promise.withResolvers<ArrayBuffer>();
    const source = { slice: vi.fn(() => ({ arrayBuffer: () => delayed.promise })) };
    const lease = tryAcquireOwnedReadLease(CAP_BYTES)!;
    const read = readOwnedRangeWithLease(source, 0, CAP_BYTES, lease);
    await vi.waitFor(() => expect(source.slice).toHaveBeenCalledOnce());
    lease.release();
    expect(ownedReadCreditStats()).toEqual({
      liveBytes: CAP_BYTES,
      retiredBytes: CAP_BYTES,
      waiters: 0,
    });
    delayed.resolve(new ArrayBuffer(0));
    await read;
    expect(ownedReadCreditStats()).toEqual({ liveBytes: 0, retiredBytes: 0, waiters: 0 });
  });

  it('keeps a released pending lease retired until unabortable I/O settles', async () => {
    const delayed = Promise.withResolvers<ArrayBuffer>();
    const source = { slice: vi.fn(() => ({ arrayBuffer: () => delayed.promise })) };
    const lease = tryAcquireOwnedReadLease(CAP_BYTES)!;
    const controller = new AbortController();
    const read = readOwnedRangeWithLease(source, 0, CAP_BYTES, lease, controller.signal);
    await vi.waitFor(() => expect(source.slice).toHaveBeenCalledOnce());
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    lease.release();
    expect(tryAcquireOwnedReadLease(1)).toBeNull();
    expect(ownedReadCreditStats()).toEqual({
      liveBytes: CAP_BYTES,
      retiredBytes: CAP_BYTES,
      waiters: 0,
    });
    delayed.resolve(new ArrayBuffer(CAP_BYTES));
    await vi.waitFor(() => expect(ownedReadCreditStats().liveBytes).toBe(0));
    expect(ownedReadCreditStats().retiredBytes).toBe(0);
  });

  it('keeps aborted unabortable Blob I/O charged until it settles, then recovers', async () => {
    const delayed = Promise.withResolvers<ArrayBuffer>();
    const firstSource = { slice: vi.fn(() => ({ arrayBuffer: () => delayed.promise })) };
    const firstAbort = new AbortController();
    const first = readOwnedRange(firstSource, 0, CAP_BYTES, firstAbort.signal);
    await vi.waitFor(() => expect(firstSource.slice).toHaveBeenCalledOnce());
    firstAbort.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(ownedReadCreditStats()).toEqual({
      liveBytes: CAP_BYTES,
      retiredBytes: CAP_BYTES,
      waiters: 0,
    });

    const secondSource = {
      slice: vi.fn(() => ({ arrayBuffer: async () => new ArrayBuffer(1) })),
    };
    const second = readOwnedRange(secondSource, 0, 1);
    await vi.waitFor(() => expect(ownedReadCreditStats().waiters).toBe(1));
    expect(secondSource.slice).not.toHaveBeenCalled();
    delayed.resolve(new ArrayBuffer(0));
    await expect(second).resolves.toHaveProperty('byteLength', 1);
    expect(secondSource.slice).toHaveBeenCalledOnce();
    expect(ownedReadCreditStats()).toEqual({ liveBytes: 0, retiredBytes: 0, waiters: 0 });
  });

  it('removes an aborted waiter without lending credit to a stale request', async () => {
    const delayed = Promise.withResolvers<ArrayBuffer>();
    const source = { slice: vi.fn(() => ({ arrayBuffer: () => delayed.promise })) };
    const first = readOwnedRange(source, 0, CAP_BYTES);
    await vi.waitFor(() => expect(source.slice).toHaveBeenCalledOnce());
    const cancelled = new AbortController();
    const waiting = readOwnedRange(source, 0, 1, cancelled.signal);
    await vi.waitFor(() => expect(ownedReadCreditStats().waiters).toBe(1));
    cancelled.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(source.slice).toHaveBeenCalledOnce();
    delayed.resolve(new ArrayBuffer(0));
    await first;
    expect(ownedReadCreditStats()).toEqual({ liveBytes: 0, retiredBytes: 0, waiters: 0 });
  });

  it('times out a credit waiter while leaving the original read charged', async () => {
    const delayed = Promise.withResolvers<ArrayBuffer>();
    const source = { slice: vi.fn(() => ({ arrayBuffer: () => delayed.promise })) };
    const first = readOwnedRange(source, 0, CAP_BYTES);
    await vi.waitFor(() => expect(source.slice).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    const waiting = readOwnedRange(source, 0, 1);
    const rejected = expect(waiting).rejects.toThrow('read credit wait timed out');
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(ownedReadCreditStats()).toEqual({ liveBytes: CAP_BYTES, retiredBytes: 0, waiters: 0 });
    delayed.resolve(new ArrayBuffer(0));
    await first;
    expect(ownedReadCreditStats().liveBytes).toBe(0);
  });
});
