/**
 * Confirmation Store
 *
 * Manages confirmation dialog state for validation warnings.
 * Used to display warnings that require explicit user confirmation before proceeding
 * with conversion (e.g., file size warnings, format compatibility issues).
 */

// External dependencies
import { createSignal } from "solid-js";

// Type imports
import type { ValidationWarning } from "@t/validation-types";

/**
 * Confirmation dialog state
 *
 * Represents the state of the confirmation modal including visibility,
 * warnings to display, and callback functions for user actions.
 */
interface ConfirmationState {
  /** Whether the confirmation dialog is visible */
  isVisible: boolean;
  /** Warnings requiring user confirmation */
  warnings: ValidationWarning[];
  /** Callback when user confirms */
  onConfirm?: () => void;
  /** Callback when user cancels */
  onCancel?: () => void;
}

/**
 * Current confirmation dialog state
 *
 * Tracks visibility, warnings, and callback functions for the confirmation modal.
 */
const [confirmationState, setConfirmationState] =
  createSignal<ConfirmationState>({
    isVisible: false,
    warnings: [],
  });

/**
 * Get current confirmation state
 *
 * @returns Current confirmation dialog state
 */
export const getConfirmationState = () => {
  return confirmationState();
};

/**
 * Show confirmation dialog with warnings
 *
 * Filters warnings to only show those requiring confirmation and displays
 * the confirmation modal with provided callbacks.
 *
 * @param warnings - All validation warnings
 * @param onConfirm - Callback when user confirms
 * @param onCancel - Callback when user cancels
 *
 * @example
 * showConfirmation(
 *   validationWarnings,
 *   () => startConversion(),
 *   () => console.log('User cancelled')
 * );
 */
export const showConfirmation = (
  warnings: ValidationWarning[],
  onConfirm: () => void,
  onCancel: () => void
): void => {
  setConfirmationState({
    isVisible: true,
    warnings: warnings.filter((w) => w.requiresConfirmation),
    onConfirm,
    onCancel,
  });
};

/**
 * Confirm and execute callback
 *
 * Hides the dialog and executes the onConfirm callback if provided.
 */
export const confirmDialog = (): void => {
  const state = confirmationState();
  setConfirmationState({ ...state, isVisible: false });
  state.onConfirm?.();
};

/**
 * Cancel and execute callback
 *
 * Hides the dialog and executes the onCancel callback if provided.
 */
export const cancelDialog = (): void => {
  const state = confirmationState();
  setConfirmationState({ ...state, isVisible: false });
  state.onCancel?.();
};
