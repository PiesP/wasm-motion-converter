/**
 * Dev Matrix Test Store
 *
 * Global state for the dev-only conversion matrix runner.
 *
 * Why this exists:
 * - The matrix test runs long, multi-scenario conversions.
 * - We want to lock the UI (reuse the existing converting state) and
 *   allow cancellation via the existing "Stop Conversion" button.
 */

import { createSignal } from 'solid-js';

export const [devMatrixTestIsRunning, setDevMatrixTestIsRunning] = createSignal(false);
export const [devMatrixTestCancelRequested, setDevMatrixTestCancelRequested] = createSignal(false);

export function requestDevMatrixTestCancel(): void {
  setDevMatrixTestCancelRequested(true);
}

export function resetDevMatrixTestCancel(): void {
  setDevMatrixTestCancelRequested(false);
}
