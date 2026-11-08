// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { ValidationWarning } from '@t/validation-types';
import { logger } from '@utils/logger';
import { createSignal } from 'solid-js';

interface ConfirmationState {
  isVisible: boolean;
  warnings: ValidationWarning[];
  title?: string | undefined;
  confirmLabel?: string | undefined;
  cancelLabel?: string | undefined;
  onConfirm?: (() => void) | undefined;
  onCancel?: (() => void) | undefined;
}

const [confirmationState, setConfirmationState] = createSignal<ConfirmationState>({
  isVisible: false,
  warnings: [],
});

export const getConfirmationState = () => confirmationState();

/** Guard flag to prevent confirmDialog/cancelDialog callbacks from firing twice */
let callbackInvoked = false;

export const showConfirmation = (
  warnings: ValidationWarning[],
  onConfirm: () => void,
  onCancel: () => void,
  options?: {
    title?: string;
    confirmLabel?: string;
    cancelLabel?: string;
  }
): void => {
  // Replacing a pending choice must settle the old owner's cancellation first.
  dismissConfirmation();
  callbackInvoked = false;
  const confirmWarnings = warnings.filter((w) => w.requiresConfirmation);
  if (confirmWarnings.length === 0) {
    // No warnings requiring confirmation — invoke onConfirm directly (L8 fix).
    onConfirm();
    return;
  }
  setConfirmationState({
    isVisible: true,
    warnings: confirmWarnings,
    title: options?.title,
    confirmLabel: options?.confirmLabel,
    cancelLabel: options?.cancelLabel,
    onConfirm,
    onCancel,
  });
};

export const confirmDialog = (): void => {
  if (callbackInvoked || !confirmationState().isVisible) return;
  callbackInvoked = true;
  const state = confirmationState();
  setConfirmationState({ ...state, isVisible: false });
  state.onConfirm?.();
};

export const cancelDialog = (): void => {
  if (callbackInvoked || !confirmationState().isVisible) return;
  callbackInvoked = true;
  const state = confirmationState();
  setConfirmationState({ ...state, isVisible: false });
  state.onCancel?.();
};

/** Settle any visible confirmation through its cancellation callback (cleanup). */
export const dismissConfirmation = (): void => {
  const state = confirmationState();
  if (!state.isVisible || callbackInvoked) {
    return;
  }
  callbackInvoked = true;
  setConfirmationState({ isVisible: false, warnings: [] });
  try {
    state.onCancel?.();
  } catch (err) {
    logger.warn('general', 'dismissConfirmation: onCancel threw', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
