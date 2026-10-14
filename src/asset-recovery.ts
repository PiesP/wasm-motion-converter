// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { appState } from '@stores/conversion-store';
import { logger } from '@utils/logger';
import { createSignal } from 'solid-js';

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

const ASSET_PATH = /^\/assets\/[\w.-]+[.-][\w-]{8}\.(?:js|css|wasm)$/;
const ASSET_IN_MESSAGE = /\/assets\/[\w.-]+[.-][\w-]{8}\.(?:js|css|wasm)/;
const [assetFailure, setAssetFailure] = createSignal<AssetFailure | null>(null);

export { assetFailure };

/** Keep only an app asset pathname; an import error does not identify an HTTP status. */
export function pathFromPreloadError(payload: unknown): string | null {
  if (!(payload instanceof Error)) return null;
  const match = payload.message.slice(0, 2048).match(ASSET_IN_MESSAGE);
  return match && ASSET_PATH.test(match[0]) ? match[0] : null;
}

export function reportAssetFailure(failure: AssetFailure): void {
  if (failure.path !== null && !ASSET_PATH.test(failure.path)) return;
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
  const onPreloadError = (event: Event): void => {
    const payload = (event as Event & { payload?: unknown }).payload;
    reportAssetFailure({
      path: pathFromPreloadError(payload),
      status: null,
      reason: 'preload-rejected',
      source: 'vite-preload',
    });
  };
  window.addEventListener('vite:preloadError', onPreloadError);
  return () => window.removeEventListener('vite:preloadError', onPreloadError);
}
