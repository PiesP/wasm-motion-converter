/**
 * Service Worker Registration Helper
 *
 * Handles SW registration, updates, and lifecycle management from main thread.
 * Provides user-facing update notifications and error handling.
 */

/**
 * Service Worker registration state
 */
interface SWRegistrationState {
  registration: ServiceWorkerRegistration | null;
  isSupported: boolean;
  isRegistered: boolean;
  updateAvailable: boolean;
}

/**
 * Global registration state
 */
const state: SWRegistrationState = {
  registration: null,
  isSupported: 'serviceWorker' in navigator,
  isRegistered: false,
  updateAvailable: false,
};

/**
 * Registers Service Worker with error handling and update detection
 *
 * @returns Promise resolving to registration or null if unsupported
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!state.isSupported) {
    console.warn('[SW Register] Service Workers not supported in this browser');
    return null;
  }

  try {
    // Register Service Worker
    const registration = await navigator.serviceWorker.register('/service-worker.js', {
      scope: '/',
      // Use module if the SW is built as ESM (Vite will handle this)
      type: 'classic',
    });

    state.registration = registration;
    state.isRegistered = true;

    console.log('[SW Register] Service Worker registered successfully:', registration.scope);

    // Check for updates periodically (every hour)
    setupUpdateCheck(registration);

    // Handle update notifications
    setupUpdateNotifications(registration);

    // Log active SW status
    if (registration.active) {
      console.log('[SW Register] Service Worker active and controlling page');
    }

    return registration;
  } catch (error) {
    console.error('[SW Register] Registration failed:', error);
    return null;
  }
}

/**
 * Sets up periodic update checks for Service Worker
 *
 * @param registration - ServiceWorkerRegistration instance
 */
function setupUpdateCheck(registration: ServiceWorkerRegistration): void {
  // Check for updates every hour
  const UPDATE_INTERVAL = 60 * 60 * 1000; // 1 hour

  setInterval(() => {
    registration.update().catch(error => {
      console.warn('[SW Register] Update check failed:', error);
    });
  }, UPDATE_INTERVAL);
}

/**
 * Sets up update notification handlers
 *
 * @param registration - ServiceWorkerRegistration instance
 */
function setupUpdateNotifications(registration: ServiceWorkerRegistration): void {
  // Detect when new SW is waiting to activate
  registration.addEventListener('updatefound', () => {
    const newWorker = registration.installing;

    if (!newWorker) {
      return;
    }

    newWorker.addEventListener('statechange', () => {
      if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
        // New SW is installed but waiting for old SW to finish
        state.updateAvailable = true;
        console.log('[SW Register] Update available - reload to activate');

        // Notify user (optional - can be expanded to UI notification)
        notifyUpdateAvailable();
      }
    });
  });

  // Listen for controller change (new SW activated)
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    console.log('[SW Register] New Service Worker activated');

    // Optionally reload page to use new SW
    // window.location.reload();
  });
}

/**
 * Notifies user that an update is available
 * Can be expanded to show UI notification/banner
 */
function notifyUpdateAvailable(): void {
  // Phase 1: Console only
  // Can be expanded in Phase 5 to show user notification banner
  console.log('[SW Register] 🔄 App update available - reload to get the latest version');

  // Future: Dispatch custom event for UI to show update banner
  // window.dispatchEvent(new CustomEvent('sw-update-available'));
}

/**
 * Forces Service Worker update by skipping waiting
 * Useful for implementing "Update Now" button
 */
export function skipWaiting(): void {
  if (!state.registration?.waiting) {
    console.warn('[SW Register] No waiting Service Worker to activate');
    return;
  }

  state.registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  console.log('[SW Register] Sent SKIP_WAITING message to Service Worker');
}

/**
 * Clears all Service Worker caches
 * Useful for debugging or forcing fresh fetch
 */
export async function clearAllCaches(): Promise<void> {
  if (!state.registration) {
    console.warn('[SW Register] No Service Worker registered');
    return;
  }

  // Send message to SW to clear caches
  state.registration.active?.postMessage({ type: 'CLEAR_CACHE' });

  // Also clear from main thread for immediate effect
  const cacheNames = await caches.keys();
  await Promise.all(cacheNames.map(name => caches.delete(name)));

  console.log('[SW Register] All caches cleared');
}

/**
 * Unregisters Service Worker
 * Useful for rollback or debugging
 */
export async function unregisterServiceWorker(): Promise<boolean> {
  if (!state.registration) {
    console.warn('[SW Register] No Service Worker to unregister');
    return false;
  }

  try {
    const success = await state.registration.unregister();

    if (success) {
      state.registration = null;
      state.isRegistered = false;
      console.log('[SW Register] Service Worker unregistered successfully');
    }

    return success;
  } catch (error) {
    console.error('[SW Register] Unregistration failed:', error);
    return false;
  }
}

/**
 * Gets current Service Worker registration state
 *
 * @returns Current registration state
 */
export function getRegistrationState(): Readonly<SWRegistrationState> {
  return { ...state };
}

/**
 * Checks if Service Worker is controlling the current page
 *
 * @returns True if SW is active and controlling
 */
export function isControlling(): boolean {
  return !!navigator.serviceWorker.controller;
}
