// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import {
  cancelDialog,
  confirmDialog,
  dismissConfirmation,
  getConfirmationState,
} from '@stores/confirmation-store';
import type { ValidationWarning } from '@t/validation-types';
import type { Component } from 'solid-js';
import { createEffect, For, onCleanup, Show } from 'solid-js';

const SEVERITY_COLORS: Record<ValidationWarning['severity'], string> = {
  error: 'text-status-danger',
  warning: 'text-status-warning',
  info: 'text-status-info',
};

const SEVERITY_ICONS: Record<ValidationWarning['severity'], string> = {
  error: '⛔',
  warning: '⚠️',
  info: 'ℹ️',
};

const ConfirmationModal: Component = () => {
  const { t } = useLocale();
  const state = getConfirmationState;
  let modalRef: HTMLDialogElement | undefined;
  let cancelButtonRef: HTMLButtonElement | undefined;
  let previouslyFocusedElement: HTMLElement | null = null;
  let scrollY = 0;
  let bodyStyle: Pick<CSSStyleDeclaration, 'overflow' | 'position' | 'top' | 'width'> | null = null;
  let focusEpoch = 0;
  let backdropPressStarted = false;

  const supportsLightDismiss = () => Reflect.has(HTMLDialogElement.prototype, 'closedBy');

  const isBackdropPoint = (event: MouseEvent, dialog: HTMLDialogElement) => {
    if (event.target !== dialog) return false;
    const { top, right, bottom, left } = dialog.getBoundingClientRect();
    return (
      event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom
    );
  };

  const handleBackdropPointerDown = (event: PointerEvent) => {
    backdropPressStarted =
      event.button === 0 && isBackdropPoint(event, event.currentTarget as HTMLDialogElement);
  };

  const handleBackdropClick = (event: MouseEvent) => {
    const shouldDismiss =
      backdropPressStarted && isBackdropPoint(event, event.currentTarget as HTMLDialogElement);
    backdropPressStarted = false;
    if (shouldDismiss) cancelDialog();
  };

  const removeBackdropAdapter = () => {
    modalRef?.removeEventListener('pointerdown', handleBackdropPointerDown);
    modalRef?.removeEventListener('pointercancel', resetBackdropPress);
    modalRef?.removeEventListener('click', handleBackdropClick);
    backdropPressStarted = false;
  };

  const resetBackdropPress = () => {
    backdropPressStarted = false;
  };

  const scheduleRestoreFocus = (element: HTMLElement | null) => {
    if (!element) {
      return;
    }

    const epoch = focusEpoch;
    queueMicrotask(() => {
      if (focusEpoch === epoch && !state().isVisible && element.isConnected) {
        element.focus({ preventScroll: true });
      }
    });
  };

  const unlockScroll = () => {
    if (!bodyStyle) return;
    Object.assign(document.body.style, bodyStyle);
    bodyStyle = null;
    window.scrollTo(0, scrollY);
  };

  createEffect(() => {
    if (state().isVisible) {
      if (!bodyStyle) {
        focusEpoch += 1;
        previouslyFocusedElement = (document.activeElement as HTMLElement | null) ?? null;
        scrollY = window.scrollY;
        bodyStyle = {
          overflow: document.body.style.overflow,
          position: document.body.style.position,
          top: document.body.style.top,
          width: document.body.style.width,
        };
        document.body.style.overflow = 'hidden';
        document.body.style.position = 'fixed';
        document.body.style.top = `-${scrollY}px`;
        document.body.style.width = '100%';
      }
      if (modalRef && !modalRef.open) {
        if (supportsLightDismiss()) modalRef.closedBy = 'any';
        else {
          modalRef.addEventListener('pointerdown', handleBackdropPointerDown);
          modalRef.addEventListener('pointercancel', resetBackdropPress);
          modalRef.addEventListener('click', handleBackdropClick);
        }
        modalRef.showModal();
        cancelButtonRef?.focus();
      }
      return;
    }

    try {
      removeBackdropAdapter();
      if (modalRef?.open) modalRef.close();
      unlockScroll();
      scheduleRestoreFocus(previouslyFocusedElement);
    } finally {
      previouslyFocusedElement = null;
    }
  });

  onCleanup(() => {
    dismissConfirmation();
    removeBackdropAdapter();
    if (modalRef?.open) modalRef.close();
    unlockScroll();
    scheduleRestoreFocus(previouslyFocusedElement);
  });

  return (
    <Show when={state().isVisible}>
      <dialog
        ref={modalRef}
        class="confirmation-dialog m-auto max-h-[calc(100dvh-2rem)] max-w-md w-[calc(100%-2rem)] overflow-y-auto rounded-lg border border-border-standard bg-bg-panel p-6 text-text-primary shadow-xl"
        aria-labelledby="modal-title"
        aria-describedby="modal-description"
        onCancel={(event) => {
          event.preventDefault();
          cancelDialog();
        }}
        onClose={(event) => {
          if (event.currentTarget === modalRef && !event.currentTarget.open) cancelDialog();
        }}
      >
        <h2 id="modal-title" class="text-xl font-semibold mb-4 text-text-primary">
          {state().title ?? t('modal.title')}
        </h2>

        <ul id="modal-description" class="space-y-3 mb-6">
          <For each={state().warnings}>
            {(warning) => (
              <li
                class="border-l-4 pl-4 py-2"
                classList={{
                  'border-status-danger': warning.severity === 'error',
                  'border-status-warning': warning.severity === 'warning',
                  'border-status-info': warning.severity === 'info',
                }}
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
                      <p class="text-sm text-text-secondary mt-1">{warning.details}</p>
                    </Show>
                    <Show when={warning.suggestedAction}>
                      <p class="text-sm text-text-secondary mt-2 font-medium">
                        <span aria-hidden="true">💡</span> {warning.suggestedAction}
                      </p>
                    </Show>
                  </div>
                </div>
              </li>
            )}
          </For>
        </ul>

        <div class="flex gap-3 justify-end">
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={cancelDialog}
            class="px-4 py-2 min-h-[44px] rounded-md bg-white/[0.02] border-border-standard hover:bg-white/[0.05] transition-colors text-text-secondary cursor-pointer"
            aria-label={t('modal.cancel')}
            data-testid="modal-cancel-button"
          >
            {state().cancelLabel ?? t('modal.cancel')}
          </button>
          <button
            type="button"
            onClick={confirmDialog}
            class="px-4 py-2 min-h-[44px] rounded-md bg-white/[0.02] border-border-standard hover:bg-white/[0.05] transition-colors text-text-secondary cursor-pointer"
            aria-label={t('modal.confirm')}
            data-testid="modal-confirm-button"
          >
            {state().confirmLabel ?? t('modal.confirm')}
          </button>
        </div>
      </dialog>
    </Show>
  );
};

export default ConfirmationModal;
