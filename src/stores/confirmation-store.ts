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
  setConfirmationState({
    isVisible: true,
    warnings: warnings.filter((w) => w.requiresConfirmation),
    title: options?.title,
    confirmLabel: options?.confirmLabel,
    cancelLabel: options?.cancelLabel,
    onConfirm,
    onCancel,
  });
};

export const confirmDialog = (): void => {
  const state = confirmationState();
  setConfirmationState({ ...state, isVisible: false });
  state.onConfirm?.();
};

export const cancelDialog = (): void => {
  const state = confirmationState();
  setConfirmationState({ ...state, isVisible: false });
  state.onCancel?.();
};

/** Dismiss any visible confirmation dialog without triggering callbacks (cleanup). */
export const dismissConfirmation = (): void => {
  const state = confirmationState();
  if (!state.isVisible) {
    return;
  }
  try {
    state.onCancel?.();
  } catch (err) {
    // If onCancel throws, still reset the state to avoid a deadlock
    // where the confirmation modal cannot be dismissed.
    logger.warn('general', 'dismissConfirmation: onCancel threw', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  setConfirmationState({ isVisible: false, warnings: [] });
};
