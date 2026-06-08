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

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!state.isSupported) {
    console.warn('[SW Register] Service Workers not supported in this browser');
    return null;
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
  const UPDATE_INTERVAL = 60 * 60 * 1000; // 1 hour

  updateCheckInterval = setInterval(() => {
    registration.update().catch((error) => {
      console.warn('[SW Register] Update check failed:', error);
    });
  }, UPDATE_INTERVAL);
}

/** Clean up the update check interval. Call on page unload to prevent leaks. */
export function cleanupServiceWorkerUpdateCheck(): void {
  if (updateCheckInterval !== null) {
    clearInterval(updateCheckInterval);
    updateCheckInterval = null;
  }
  navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
}

function onControllerChange(): void {
  console.log('[SW Register] New Service Worker activated');
}

function setupUpdateNotifications(registration: ServiceWorkerRegistration): void {
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
