// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/// <reference lib="webworker" />

import { logger } from '@utils/logger';
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

    const stateListeners = new Map<ServiceWorker, () => void>();
    // Handle new worker installation/updates
    const handleUpdate = (): void => {
      const newWorker = registration.installing;
      if (!newWorker) return;

      const handleState = (): void => {
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
    };
    registration.addEventListener('updatefound', handleUpdate);
    const handleMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== navigator.serviceWorker.controller || !event.source) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      const message = data as { type?: unknown; path?: unknown; status?: unknown };
      if (
        message.type !== 'dropconvert:asset-unavailable' ||
        typeof message.path !== 'string' ||
        !/^\/assets\/[\w.-]+[.-][\w-]{8}\.(?:js|css|wasm)$/.test(message.path) ||
        typeof message.status !== 'number' ||
        !Number.isInteger(message.status) ||
        message.status < 0 ||
        message.status > 599
      )
        return;
      onAssetUnavailable?.();
    };
    navigator.serviceWorker.addEventListener('message', handleMessage);

    // Check for updates on page focus
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        registration.update().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    const cleanup = (): void => {
      document.removeEventListener('visibilitychange', handleVisibility);
      registration.removeEventListener('updatefound', handleUpdate);
      navigator.serviceWorker.removeEventListener('message', handleMessage);
      for (const [worker, listener] of stateListeners)
        worker.removeEventListener('statechange', listener);
      stateListeners.clear();
      window.removeEventListener('pagehide', cleanup);
    };

    // Ensure cleanup runs on page unload to avoid leaked listeners
    window.addEventListener('pagehide', cleanup);

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
