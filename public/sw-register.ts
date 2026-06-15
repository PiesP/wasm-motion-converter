interface SWRegistrationState {
  registration: ServiceWorkerRegistration | null;
  isSupported: boolean;
  isRegistered: boolean;
  updateAvailable: boolean;
}

const state: SWRegistrationState = {
  registration: null,
  isSupported: 'serviceWorker' in navigator,
  isRegistered: false,
  updateAvailable: false,
};

let updateCheckInterval: ReturnType<typeof setInterval> | null = null;
let updateCheckVisibilityHandler: (() => void) | null = null;
let notificationsSetup = false;

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!state.isSupported) {
    console.warn('[SW Register] Service Workers not supported in this browser');
    return null;
  }

  if (state.isRegistered) {
    return state.registration;
  }

  try {
    const registration = await navigator.serviceWorker.register('/service-worker.js', {
      scope: '/',
      type: 'classic',
    });

    state.registration = registration;
    state.isRegistered = true;

    console.log('[SW Register] Service Worker registered successfully:', registration.scope);

    setupUpdateCheck(registration);

    setupUpdateNotifications(registration);

    if (registration.active) {
      console.log('[SW Register] Service Worker active and controlling page');
    }

    return registration;
  } catch (error) {
    console.error('[SW Register] Registration failed:', error);
    return null;
  }
}

type SWRegisterGlobal = typeof globalThis & {
  registerServiceWorker?: typeof registerServiceWorker;
};

(globalThis as SWRegisterGlobal).registerServiceWorker = registerServiceWorker;
(
  globalThis as SWRegisterGlobal & {
    cleanupServiceWorkerUpdateCheck?: typeof cleanupServiceWorkerUpdateCheck;
  }
).cleanupServiceWorkerUpdateCheck = cleanupServiceWorkerUpdateCheck;

function setupUpdateCheck(registration: ServiceWorkerRegistration): void {
  if (updateCheckInterval !== null) return;

  const UPDATE_INTERVAL = 60 * 60 * 1000; // 1 hour

  const checkForUpdate = () => {
    // Only poll when the tab is visible — the browser already checks on navigation
    if (document.hidden) return;
    registration.update().catch((error) => {
      console.warn('[SW Register] Update check failed:', error);
    });
  };

  // Run an immediate check on first setup, then hourly
  checkForUpdate();
  updateCheckInterval = setInterval(checkForUpdate, UPDATE_INTERVAL);

  // Also check immediately when the tab becomes visible again
  updateCheckVisibilityHandler = checkForUpdate;
  document.addEventListener('visibilitychange', updateCheckVisibilityHandler);
}

/** Clean up the update check interval. Call on page unload to prevent leaks. */
export function cleanupServiceWorkerUpdateCheck(): void {
  if (updateCheckInterval !== null) {
    clearInterval(updateCheckInterval);
    updateCheckInterval = null;
  }
  if (updateCheckVisibilityHandler !== null) {
    document.removeEventListener('visibilitychange', updateCheckVisibilityHandler);
    updateCheckVisibilityHandler = null;
  }
}

function onControllerChange(): void {
  console.log('[SW Register] New Service Worker activated');
}

function setupUpdateNotifications(registration: ServiceWorkerRegistration): void {
  if (notificationsSetup) return;
  notificationsSetup = true;
  registration.addEventListener('updatefound', () => {
    const newWorker = registration.installing;

    if (!newWorker) {
      return;
    }

    newWorker.addEventListener('statechange', () => {
      if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
        state.updateAvailable = true;
        console.log('[SW Register] Update available - reload to activate');

        notifyUpdateAvailable();
      }
    });
  });

  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
}

function notifyUpdateAvailable(): void {
  window.dispatchEvent(new CustomEvent('sw-update-available'));
}
