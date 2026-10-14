// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { appState } from '@stores/conversion-store';
import { logger } from '@utils/logger';
import { createSignal, onCleanup } from 'solid-js';

/** Vite replaces this with the clean source SHA; unknown local builds receive null. */
declare const __APP_SOURCE_SHA__: string | null;

export type AssetFailureSource = 'vite-preload' | 'service-worker';
export type AssetFailureReason = 'preload-rejected' | 'invalid-response' | 'network-error';

export interface AssetFailure {
  path: string | null;
  status: number | null;
  reason: AssetFailureReason;
  source: AssetFailureSource;
}

/** Bound diagnostic path storage even when a worker message has a valid shape. */
const MAX_ASSET_PATH_LENGTH = 256;
const ASSET_PATH = /^\/assets\/[\w.-]+[.-][\w-]{8}\.(?:js|css|wasm)$/;
const URL_IN_MESSAGE = /(?:[a-zA-Z][a-zA-Z\d+.-]*:\/\/|\/\/|\/assets\/)[^\s"'<>]+/;
const [assetFailure, setAssetFailure] = createSignal<AssetFailure | null>(null);
let preloadListener: ((event: Event) => void) | null = null;
let preloadOwners = 0;

export { assetFailure };

export function isAppAssetPath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= MAX_ASSET_PATH_LENGTH && ASSET_PATH.test(path);
}

/** Keep only an app asset pathname; an import error does not identify an HTTP status. */
export function pathFromPreloadError(payload: unknown): string | null {
  if (!(payload instanceof Error)) return null;
  const match = payload.message.slice(0, 2048).match(URL_IN_MESSAGE);
  if (!match) return null;
  try {
    const url = new URL(match[0], location.href);
    return url.origin === location.origin && isAppAssetPath(url.pathname) ? url.pathname : null;
  } catch {
    return null;
  }
}

export function reportAssetFailure(failure: AssetFailure): void {
  if (failure.path !== null && !isAppAssetPath(failure.path)) return;
  const previous = assetFailure();
  // A worker's validated response is more specific than the subsequent Vite rejection.
  if (previous) {
    if (
      previous.source === 'service-worker' &&
      failure.source === 'vite-preload' &&
      (failure.path === null || failure.path === previous.path)
    )
      return;
    if (previous.path === failure.path) {
      if (previous.source === failure.source) {
        if (previous.status !== 0 || failure.status === 0) return;
      } else if (previous.source === 'service-worker' || failure.source === 'vite-preload') {
        return;
      }
    }
  }
  setAssetFailure(failure);
  logger.warn('general', 'app.asset-unavailable', {
    sourceSha: typeof __APP_SOURCE_SHA__ === 'undefined' ? null : __APP_SOURCE_SHA__,
    operation: appState(),
    online: navigator.onLine,
    swControlled: Boolean(navigator.serviceWorker?.controller),
    path: failure.path,
    status: failure.status,
    reason: failure.reason,
    source: failure.source,
  });
}

/** Reset page-local evidence when the owning app is disposed. */
export function clearAssetFailure(): void {
  setAssetFailure(null);
}

/** Install before rendering can start optional imports; leave rejection semantics intact. */
export function observePreloadErrors(): () => void {
  if (!preloadListener) {
    preloadListener = (event: Event): void => {
      if (preloadOwners === 0) return;
      try {
        const payload = (event as Event & { payload?: unknown }).payload;
        reportAssetFailure({
          path: pathFromPreloadError(payload),
          status: null,
          reason: 'preload-rejected',
          source: 'vite-preload',
        });
      } catch {
        // Diagnostic recording cannot replace Vite's original rejection.
      }
    };
    window.addEventListener('vite:preloadError', preloadListener);
  }
  preloadOwners += 1;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    preloadOwners -= 1;
    if (preloadOwners === 0 && preloadListener) {
      window.removeEventListener('vite:preloadError', preloadListener);
      preloadListener = null;
    }
  };
}

/** Attach the observer to the Solid render root before creating feature children. */
export function ownPreloadErrors(): void {
  onCleanup(observePreloadErrors());
}
