import { createSignal } from 'solid-js';
import type { ValidationWarning } from '../types/validation';

export interface ConfirmationState {
  isVisible: boolean;
  warnings: ValidationWarning[];
  onConfirm?: () => void;
  onCancel?: () => void;
}

const [confirmationState, setConfirmationState] = createSignal<ConfirmationState>({
  isVisible: false,
  warnings: [],
});

export const confirmationStore = {
  get state() {
    return confirmationState();
  },

  showConfirmation(warnings: ValidationWarning[], onConfirm: () => void, onCancel: () => void) {
    setConfirmationState({
      isVisible: true,
      warnings: warnings.filter((w) => w.requiresConfirmation),
      onConfirm,
      onCancel,
    });
  },

  confirm() {
    const state = confirmationState();
    setConfirmationState({ ...state, isVisible: false });
    state.onConfirm?.();
  },

  cancel() {
    const state = confirmationState();
    setConfirmationState({ ...state, isVisible: false });
    state.onCancel?.();
  },

  hide() {
    setConfirmationState({ isVisible: false, warnings: [] });
  },
};
