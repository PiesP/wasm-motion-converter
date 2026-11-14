// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Realm-local credit for Blob reads whose underlying I/O may outlive cancellation. */
const MAX_OUTSTANDING_READ_BYTES = 16 * 1024 * 1024;
const MAX_WAITERS = 8;
const WAIT_TIMEOUT_MS = 2_000;

type RangeSource = {
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
};
type Waiter = {
  length: number;
  grant(): void;
  reject(error: unknown): void;
};
const waiters: Waiter[] = [];
let liveBytes = 0;
let retiredBytes = 0;

export function ownedReadCreditStats(): Readonly<{
  liveBytes: number;
  retiredBytes: number;
  waiters: number;
}> {
  return { liveBytes, retiredBytes, waiters: waiters.length };
}

function drain(): void {
  while (waiters.length > 0 && liveBytes + waiters[0]!.length <= MAX_OUTSTANDING_READ_BYTES) {
    const waiter = waiters.shift()!;
    liveBytes += waiter.length;
    waiter.grant();
  }
}

function release(length: number, retired: boolean): void {
  liveBytes -= length;
  if (retired) retiredBytes -= length;
  drain();
}

function acquire(length: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_OUTSTANDING_READ_BYTES)
    return Promise.reject(new Error('Owned demux resource limit: read extent invalid'));
  signal?.throwIfAborted();
  if (waiters.length === 0 && liveBytes + length <= MAX_OUTSTANDING_READ_BYTES) {
    liveBytes += length;
    return Promise.resolve();
  }
  if (waiters.length >= MAX_WAITERS)
    return Promise.reject(new Error('Owned demux resource limit: read waiters exceeded'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const remove = (): void => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      remove();
      reject(error);
      drain();
    };
    const onAbort = (): void =>
      fail(signal?.reason ?? new DOMException('Owned demux read aborted', 'AbortError'));
    const timer = setTimeout(
      () => fail(new Error('Owned demux resource limit: read credit wait timed out')),
      WAIT_TIMEOUT_MS
    );
    const waiter: Waiter = {
      length,
      grant: () => {
        if (settled) return;
        settled = true;
        remove();
        resolve();
      },
      reject: fail,
    };
    waiters.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else drain();
  });
}

/** Return promptly on abort, retaining credit until the actual read promise settles. */
export async function readOwnedRange(
  source: RangeSource,
  start: number,
  end: number,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const length = end - start;
  await acquire(length, signal);
  if (signal?.aborted) {
    release(length, false);
    signal.throwIfAborted();
  }
  let read: Promise<ArrayBuffer>;
  try {
    read = source.slice(start, end).arrayBuffer();
  } catch (error) {
    release(length, false);
    throw error;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let retired = false;
    const onAbort = (): void => {
      if (settled || retired) return;
      retired = true;
      retiredBytes += length;
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new DOMException('Owned demux read aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    void read.then(
      (buffer) => {
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        release(length, retired);
        resolve(buffer);
      },
      (error: unknown) => {
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        release(length, retired);
        reject(error);
      }
    );
    if (signal?.aborted) onAbort();
  });
}
