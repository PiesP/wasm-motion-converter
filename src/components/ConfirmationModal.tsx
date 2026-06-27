// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import { cancelDialog, confirmDialog, getConfirmationState } from '@stores/confirmation-store';
import type { ValidationWarning } from '@t/validation-types';
import type { Component, JSX } from 'solid-js';
import { createEffect, For, onCleanup, onMount, Show } from 'solid-js';

const SEVERITY_COLORS: Record<ValidationWarning['severity'], string> = {
  error: 'text-red-400',
  warning: 'text-yellow-400',
  info: 'text-blue-400',
};

const SEVERITY_ICONS: Record<ValidationWarning['severity'], string> = {
  error: '⛔',
  warning: '⚠️',
  info: 'ℹ️',
};

const ConfirmationModal: Component = () => {
  const { t } = useLocale();
  const state = getConfirmationState;
  let modalRef: HTMLDivElement | undefined;
  let cancelButtonRef: HTMLButtonElement | undefined;
  let previouslyFocusedElement: HTMLElement | null = null;

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && state().isVisible) {
      cancelDialog();
    }
  };

  const handleFocusTrap = (event: KeyboardEvent) => {
    if (!modalRef || event.key !== 'Tab' || !state().isVisible) {
      return;
    }

    const focusableElements = modalRef.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );

    if (focusableElements.length === 0) {
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault();
      lastElement?.focus();
      return;
    }

    if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault();
      firstElement?.focus();
    }
  };

  const handleBackdropClick: JSX.EventHandlerUnion<HTMLDivElement, MouseEvent> = (event) => {
    if (event.target === event.currentTarget) {
      cancelDialog();
    }
  };

  const scheduleRestoreFocus = (element: HTMLElement | null) => {
    if (!element) {
      return;
    }

    queueMicrotask(() => {
      element.focus();
    });
  };

  const scheduleCancelFocus = () => {
    queueMicrotask(() => {
      cancelButtonRef?.focus();
    });
  };

  onMount(() => {
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keydown', handleFocusTrap);
  });

  createEffect(() => {
    if (state().isVisible) {
      previouslyFocusedElement = (document.activeElement as HTMLElement | null) ?? null;
      document.body.inert = true;
      scheduleCancelFocus();
      return;
    }

    try {
      document.body.inert = false;
      scheduleRestoreFocus(previouslyFocusedElement);
    } finally {
      previouslyFocusedElement = null;
    }
  });

  onCleanup(() => {
    document.body.inert = false;
  });

  onCleanup(() => {
    document.removeEventListener('keydown', handleKeyDown);
    document.removeEventListener('keydown', handleFocusTrap);
  });

  return (
    <Show when={state().isVisible}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        aria-describedby="modal-description"
        onClick={handleBackdropClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            cancelDialog();
          }
        }}
        tabIndex={-1}
      >
        <div
          ref={modalRef}
          class="bg-[#0f1011] border border-white/[0.08] rounded-lg shadow-xl max-w-md w-full mx-4 p-6"
          tabIndex={-1}
        >
          <h2 id="modal-title" class="text-xl font-semibold mb-4 text-[#f7f8f8]">
            {state().title ?? 'Conversion Warning'}
          </h2>

          <div id="modal-description" class="space-y-3 mb-6" role="list">
            <For each={state().warnings}>
              {(warning) => (
                <div
                  class="border-l-4 pl-4 py-2"
                  classList={{
                    'border-red-500': warning.severity === 'error',
                    'border-yellow-500': warning.severity === 'warning',
                    'border-blue-500': warning.severity === 'info',
                  }}
                  role="listitem"
                >
                  <div class="flex items-start gap-2">
                    <span class="text-lg" aria-hidden="true">
                      {SEVERITY_ICONS[warning.severity]}
                    </span>
                    <div class="flex-1">
                      <p class={`font-medium ${SEVERITY_COLORS[warning.severity]}`}>
                        {warning.message}
                      </p>
                      <Show when={warning.details}>
                        <p class="text-sm text-[#d0d6e0] mt-1">{warning.details}</p>
                      </Show>
                      <Show when={warning.suggestedAction}>
                        <p class="text-sm text-[#d0d6e0] mt-2 font-medium">
                          <span aria-hidden="true">💡</span> {warning.suggestedAction}
                        </p>
                      </Show>
                    </div>
                  </div>
                </div>
              )}
            </For>
          </div>

          <div class="flex gap-3 justify-end">
            <button
              ref={cancelButtonRef}
              type="button"
              onClick={cancelDialog}
              class="px-4 py-2 min-h-[44px] rounded-md bg-white/[0.02] border border-white/[0.08] hover:bg-white/[0.05] transition-colors text-[#d0d6e0]"
              aria-label={t('modal.cancel')}
              data-testid="modal-cancel-button"
            >
              {state().cancelLabel ?? 'Cancel'}
            </button>
            <button
              type="button"
              onClick={confirmDialog}
              class="px-4 py-2 min-h-[44px] rounded-md bg-white/[0.02] border border-white/[0.08] hover:bg-white/[0.05] transition-colors text-[#d0d6e0]"
              aria-label={t('modal.confirm')}
              data-testid="modal-confirm-button"
            >
              {state().confirmLabel ?? 'Proceed Anyway'}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default ConfirmationModal;
