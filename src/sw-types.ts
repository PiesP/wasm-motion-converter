// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Service Worker registration types.
 * Kept in a separate file to avoid polluting the main sw-register.ts
 * with types that are only needed at compile time.
 */

export interface SWRegisterOptions {
  /** Called when a new service worker activates for the first time (offline ready). */
  onOfflineReady?: () => void;
  /** Called when a new service worker activates after an update. */
  onUpdate?: () => void;
}

export interface SWRegistrationState {
  /** Whether the browser supports service workers. */
  supported: boolean;
  /** Whether the service worker is currently registered (false in dev mode). */
  registered: boolean;
}
