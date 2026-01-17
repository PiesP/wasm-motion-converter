/**
 * Service Worker readiness checks and utilities
 *
 * Attempts to wait for SW to be active and controlling when available.
 * Falls back gracefully when SW is not registered or supported.
 */

import { logger } from '@utils/logger';

const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const CHECK_INTERVAL_MS = 100;
const STATUS_WAITING_FOR_SW = 'Waiting for Service Worker to activate...';
const STATUS_READY = 'Service Worker now active and controlling';
const STATUS_ALREADY_READY = 'Service Worker already active and controlling';
const STATUS_UNSUPPORTED = 'Service Workers not supported; proceeding without caching';
const STATUS_NOT_REGISTERED = 'Service Worker not registered; skipping readiness wait';
const STATUS_REGISTRATION_FAILED =
  'Failed to read Service Worker registration; skipping readiness wait';
const STATUS_TIMEOUT = 'Timeout waiting for Service Worker';

export interface SWReadinessState {
  isSupported: boolean;
  isActive: boolean;
  isControlling: boolean;
  isReady: boolean;
}

/**
 * Checks if Service Worker is ready to handle conversions
 */
export function checkSWReadiness(): SWReadinessState {
  const isSupported = 'serviceWorker' in navigator;
  const isControlling = !!navigator.serviceWorker.controller;
  const isActive = navigator.serviceWorker.controller?.state === 'activated';

  return {
    isSupported,
    isActive,
    isControlling,
    isReady: isSupported && isControlling && isActive,
  };
}

/**
 * Waits for Service Worker to be ready (controlling the page)
 * Returns immediately if already ready, or after SW activates.
 *
 * @param timeout - Maximum wait time in ms (default: 10s)
 * @returns Promise that resolves when SW is ready or timeout
 */
export async function waitForSWReady(timeout = DEFAULT_WAIT_TIMEOUT_MS): Promise<boolean> {
  const state = checkSWReadiness();

  logger.debug('general', 'Service Worker readiness snapshot', state);

  // If not supported, return immediately (will work without SW)
  if (!state.isSupported) {
    logger.warn('general', STATUS_UNSUPPORTED);
    return true;
  }

  // If already ready, return immediately
  if (state.isReady) {
    logger.info('general', STATUS_ALREADY_READY);
    return true;
  }

  // If no registration exists, skip waiting (common in dev or when SW is disabled)
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) {
      logger.warn('general', STATUS_NOT_REGISTERED);
      return false;
    }
  } catch {
    logger.warn('general', STATUS_REGISTRATION_FAILED);
    return false;
  }

  // Wait for SW to take control
  logger.info('general', STATUS_WAITING_FOR_SW);

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      logger.warn('general', 'Service Worker readiness snapshot at timeout', checkSWReadiness());
      logger.warn('general', STATUS_TIMEOUT, {
        timeoutMs: timeout,
      });

      resolve(false);
    }, timeout);

    const checkInterval = setInterval(() => {
      if (checkSWReadiness().isReady) {
        clearTimeout(timeoutId);
        clearInterval(checkInterval);
        logger.info('general', STATUS_READY);
        resolve(true);
      }
    }, CHECK_INTERVAL_MS);

    // Also listen for controllerchange event
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        clearTimeout(timeoutId);
        clearInterval(checkInterval);
        logger.info('general', STATUS_READY);
        resolve(true);
      },
      { once: true }
    );
  });
}

/**
 * Shows whether this is likely a first visit
 * (SW not yet controlling)
 */
export function isLikelyFirstVisit(): boolean {
  return 'serviceWorker' in navigator && !navigator.serviceWorker.controller;
}
