// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { ownedReadCreditStats, readOwnedRange } from '@services/owned-demux-source-reads';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const CAP_BYTES = 16 * 1024 * 1024;
afterEach(() => vi.useRealTimers());

describe('owned demux realm read credit', () => {
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
