// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { OwnedVp8CancelledError } from './owned-vp8-errors';

export interface CompiledOwnedVp8Module {
  module: WebAssembly.Module;
  initialPages: number;
  sourceBytes: number;
}

/** A realm owns one loader and caches only a module that has been instantiated. */
export const ownedVp8ModuleState: {
  loaderIdle: Promise<void> | undefined;
  cache: CompiledOwnedVp8Module | undefined;
  loadBytes: number;
} = { loaderIdle: undefined, cache: undefined, loadBytes: 0 };

/** Loader backing and logical source bytes held by compilation or the realm cache. */
export function getOwnedVp8ModuleBytes(): number {
  return ownedVp8ModuleState.cache?.sourceBytes ?? ownedVp8ModuleState.loadBytes;
}

/** Wait for an earlier conversion's loader before retaining new pipeline resources. */
export function waitForOwnedVp8Load(signal?: AbortSignal): Promise<void> | undefined {
  const idle = ownedVp8ModuleState.loaderIdle;
  return idle && awaitAbortable(idle, signal);
}

/** The serial product pipeline calls this after it selects a non-owned encoder. */
export function discardOwnedVp8Module(): void {
  ownedVp8ModuleState.cache = undefined;
}

export function cancelled(signal?: AbortSignal): OwnedVp8CancelledError {
  return new OwnedVp8CancelledError('Owned VP8 conversion cancelled', {
    cause: signal?.reason,
  });
}

export function awaitAbortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.reject(cancelled(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(cancelled(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
    if (signal.aborted) onAbort();
  });
}
