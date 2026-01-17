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
const [devMatrixTestCancelRequested, setDevMatrixTestCancelRequested] = createSignal(false);

export { devMatrixTestCancelRequested };

const setDevMatrixTestCancelRequestedValue = (value: boolean): void => {
  setDevMatrixTestCancelRequested(value);
};

export function requestDevMatrixTestCancel(): void {
  setDevMatrixTestCancelRequestedValue(true);
}

export function resetDevMatrixTestCancel(): void {
  setDevMatrixTestCancelRequestedValue(false);
}
