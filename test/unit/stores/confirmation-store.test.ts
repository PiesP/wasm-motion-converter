// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelDialog,
  confirmDialog,
  dismissConfirmation,
  getConfirmationState,
  showConfirmation,
} from '@stores/confirmation-store';

const warning = (requiresConfirmation: boolean) => ({
  severity: 'warning' as const,
  message: requiresConfirmation ? 'confirm' : 'info',
  details: 'details',
  requiresConfirmation,
});

beforeEach(() => {
  dismissConfirmation();
});

describe('confirmation store', () => {
  it('invokes confirmation immediately when no warning requires it', () => {
    const onConfirm = vi.fn();
    showConfirmation([warning(false)], onConfirm, vi.fn());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(getConfirmationState().isVisible).toBe(false);
  });

  it('stores only blocking warnings and exposes dialog options', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    showConfirmation([warning(false), warning(true)], onConfirm, onCancel, {
      title: 'Warning',
      confirmLabel: 'Continue',
      cancelLabel: 'Stop',
    });

    expect(getConfirmationState()).toMatchObject({
      isVisible: true,
      warnings: [warning(true)],
      title: 'Warning',
      confirmLabel: 'Continue',
      cancelLabel: 'Stop',
    });
  });

  it('invokes confirm and cancel callbacks at most once', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    showConfirmation([warning(true)], onConfirm, onCancel);
    confirmDialog();
    confirmDialog();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(getConfirmationState().isVisible).toBe(false);

    showConfirmation([warning(true)], onConfirm, onCancel);
    cancelDialog();
    cancelDialog();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('dismisses visible dialogs and still resets state when cleanup throws', () => {
    const onCancel = vi.fn(() => {
      throw new Error('cleanup failed');
    });
    showConfirmation([warning(true)], vi.fn(), onCancel);
    dismissConfirmation();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(getConfirmationState()).toEqual({ isVisible: false, warnings: [] });
  });

  it('does nothing when dismissing an already hidden dialog', () => {
    expect(() => dismissConfirmation()).not.toThrow();
    expect(getConfirmationState().isVisible).toBe(false);
  });
});
