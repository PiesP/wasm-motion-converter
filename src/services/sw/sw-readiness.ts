/**
 * Service Worker readiness checks and utilities
 *
 * Ensures conversions only start after SW is active and controlling,
 * preventing CORS issues on first visit.
 */

import { logger } from '@utils/logger';

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
export async function waitForSWReady(timeout = 10000): Promise<boolean> {
  const state = checkSWReadiness();

  // If not supported, return immediately (will work without SW)
  if (!state.isSupported) {
    logger.warn('general', 'Service Workers not supported; proceeding without caching');
    return true;
  }

  // If already ready, return immediately
  if (state.isReady) {
    logger.info('general', 'Service Worker already active and controlling');
    return true;
  }

  // Wait for SW to take control
  logger.info('general', 'Waiting for Service Worker to activate...');

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      logger.warn('general', 'Timeout waiting for Service Worker', {
        timeoutMs: timeout,
      });
      resolve(false);
    }, timeout);

    const checkInterval = setInterval(() => {
      if (checkSWReadiness().isReady) {
        clearTimeout(timeoutId);
        clearInterval(checkInterval);
        logger.info('general', 'Service Worker now active and controlling');
        resolve(true);
      }
    }, 100);

    // Also listen for controllerchange event
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        clearTimeout(timeoutId);
        clearInterval(checkInterval);
        logger.info('general', 'Service Worker took control');
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
