// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/// <reference lib="webworker" />

import { logger } from '@utils/logger';
import { isAppAssetPath } from './asset-recovery';
import type { SWRegisterOptions, SWRegistrationState } from './sw-types';

const SW_PATH = '/service-worker.js';

// ── Register ──────────────────────────────────────────────

export async function registerServiceWorker(
  options: SWRegisterOptions = {}
): Promise<SWRegistrationState> {
  const { onUpdate, onOfflineReady, onAssetUnavailable } = options;

  if (!('serviceWorker' in navigator)) {
    return { supported: false, registered: false };
  }

  // Dev mode: unregister any existing service workers to avoid stale caches
  if (import.meta.env.MODE === 'development') {
    await unregisterAll();
    return { supported: true, registered: false };
  }

  try {
    const registration = await navigator.serviceWorker.register(SW_PATH, {
      type: 'module',
    });

    console.log('[SW] Registered, scope:', registration.scope);

    // Track whether we've already activated once
    let isFirstActivation = !registration.active;
    let disposed = false;

    const stateListeners = new Map<ServiceWorker, () => void>();
    // Handle new worker installation/updates
    const handleUpdate = (): void => {
      const newWorker = registration.installing;
      if (disposed || !newWorker || stateListeners.has(newWorker)) return;

      const handleState = (): void => {
        if (disposed) return;
        if (newWorker.state === 'activated' || newWorker.state === 'redundant') {
          newWorker.removeEventListener('statechange', handleState);
          stateListeners.delete(newWorker);
        }
        if (newWorker.state === 'activated') {
          if (isFirstActivation) {
            isFirstActivation = false;
            onOfflineReady?.();
          } else {
            onUpdate?.();
          }
        }
      };
      stateListeners.set(newWorker, handleState);
      newWorker.addEventListener('statechange', handleState);
      handleState();
    };
    registration.addEventListener('updatefound', handleUpdate);
    handleUpdate();
    const handleMessage = (event: MessageEvent<unknown>): void => {
      if (disposed) return;
      if (event.source !== navigator.serviceWorker.controller || !event.source) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      const message = data as {
        type?: unknown;
        path?: unknown;
        status?: unknown;
        reason?: unknown;
      };
      if (
        message.type !== 'dropconvert:asset-unavailable' ||
        !isAppAssetPath(message.path) ||
        typeof message.status !== 'number' ||
        !Number.isInteger(message.status) ||
        message.status < 0 ||
        message.status > 599 ||
        (message.reason !== 'invalid-response' && message.reason !== 'network-error')
      )
        return;
      onAssetUnavailable?.({
        path: message.path,
        status: message.status,
        reason: message.reason,
        source: 'service-worker',
      });
    };
    navigator.serviceWorker.addEventListener('message', handleMessage);

    // Check for updates on page focus
    const handleVisibility = () => {
      if (!disposed && document.visibilityState === 'visible') {
        registration.update().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    const cleanup = (): void => {
      if (disposed) return;
      disposed = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      registration.removeEventListener('updatefound', handleUpdate);
      navigator.serviceWorker.removeEventListener('message', handleMessage);
      for (const [worker, listener] of stateListeners)
        worker.removeEventListener('statechange', listener);
      stateListeners.clear();
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('pageshow', handlePageShow);
    };

    // BFCache restores this same owner; keep listeners and resample on return.
    const handlePageHide = (event: PageTransitionEvent): void => {
      if (!event.persisted) cleanup();
    };
    const handlePageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) handleVisibility();
    };
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handlePageShow);

    return { supported: true, registered: true, cleanup };
  } catch (error) {
    logger.warn('general', 'sw.registration-failed', { error: String(error) });
    return { supported: true, registered: false };
  }
}

// ── Unregister ────────────────────────────────────────────

async function unregisterAll(): Promise<void> {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((reg) => reg.unregister()));
  console.log('[SW] Unregistrations complete (dev mode)');
}
