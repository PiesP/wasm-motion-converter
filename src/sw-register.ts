// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/// <reference lib="webworker" />

import type { SWRegisterOptions, SWRegistrationState } from './sw-types';

const SW_PATH = '/service-worker.js';

// ── Register ──────────────────────────────────────────────

export async function registerServiceWorker(
  options: SWRegisterOptions = {}
): Promise<SWRegistrationState> {
  const { onUpdate, onOfflineReady } = options;

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

    // Handle new worker installation/updates
    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      if (!newWorker) return;

      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'activated') {
          if (isFirstActivation) {
            isFirstActivation = false;
            onOfflineReady?.();
          } else {
            onUpdate?.();
          }
        }
      });
    });

    // Check for updates on page focus
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        registration.update().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    const cleanup = (): void => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };

    // Ensure cleanup runs on page unload to avoid leaked listeners
    window.addEventListener('pagehide', cleanup);

    return { supported: true, registered: true, cleanup };
  } catch (error) {
    console.error('[SW] Registration failed:', error);
    return { supported: true, registered: false };
  }
}

// ── Unregister ────────────────────────────────────────────

async function unregisterAll(): Promise<void> {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((reg) => reg.unregister()));
  console.log('[SW] Unregistrations complete (dev mode)');
}
