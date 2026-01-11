import type { Component } from 'solid-js';
import { createEffect, For, onCleanup, onMount, Show } from 'solid-js';
import { cancelDialog, confirmDialog, getConfirmationState } from '@stores/confirmation-store';
import type { ValidationWarning } from '@t/validation-types';

/**
 * Get Tailwind color classes based on warning severity
 *
 * @param severity - Warning severity level
 * @returns Tailwind CSS color classes
 */
function getSeverityColor(severity: ValidationWarning['severity']): string {
  switch (severity) {
    case 'error':
      return 'text-red-600 dark:text-red-400';
    case 'warning':
      return 'text-yellow-600 dark:text-yellow-400';
    case 'info':
      return 'text-blue-600 dark:text-blue-400';
  }
}

/**
 * Get emoji icon based on warning severity
 *
 * @param severity - Warning severity level
 * @returns Emoji icon string
 */
function getSeverityIcon(severity: ValidationWarning['severity']): string {
  switch (severity) {
    case 'error':
      return '⛔';
    case 'warning':
      return '⚠️';
    case 'info':
      return 'ℹ️';
  }
}

/**
 * Confirmation modal for displaying validation warnings
 * and requiring user confirmation before proceeding
 *
 * @example
 * ```tsx
 * <ConfirmationModal />
 * ```
 */
const ConfirmationModal: Component = () => {
  const state = getConfirmationState;
  let modalRef: HTMLDivElement | undefined;
  let cancelButtonRef: HTMLButtonElement | undefined;
  let previouslyFocusedElement: HTMLElement | null = null;

  // Handle ESC key to close modal
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && state().isVisible) {
      cancelDialog();
    }
  };

  // Focus trap for modal accessibility
  const handleFocusTrap = (event: KeyboardEvent) => {
    if (event.key === 'Tab' && state().isVisible && modalRef) {
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
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement?.focus();
      }
    }
  };

  onMount(() => {
    // Add event listeners for keyboard navigation
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keydown', handleFocusTrap);
  });

  createEffect(() => {
    const isVisible = state().isVisible;
    if (isVisible) {
      previouslyFocusedElement = (document.activeElement as HTMLElement | null) ?? null;
      queueMicrotask(() => {
        cancelButtonRef?.focus();
      });
      return;
    }

    if (previouslyFocusedElement) {
      queueMicrotask(() => {
        previouslyFocusedElement?.focus();
      });
      previouslyFocusedElement = null;
    }
  });

  onCleanup(() => {
    // Remove event listeners on cleanup
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
        onClick={(e) => {
          // Close modal when clicking backdrop
          if (e.target === e.currentTarget) {
            cancelDialog();
          }
        }}
      >
        <div
          ref={modalRef}
          class="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full mx-4 p-6"
          tabIndex={-1}
        >
          <h2 id="modal-title" class="text-xl font-semibold mb-4 text-gray-900 dark:text-gray-100">
            Conversion Warning
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
                      {getSeverityIcon(warning.severity)}
                    </span>
                    <div class="flex-1">
                      <p class={`font-medium ${getSeverityColor(warning.severity)}`}>
                        {warning.message}
                      </p>
                      <Show when={warning.details}>
                        <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">
                          {warning.details}
                        </p>
                      </Show>
                      <Show when={warning.suggestedAction}>
                        <p class="text-sm text-gray-700 dark:text-gray-300 mt-2 font-medium">
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
              onClick={() => cancelDialog()}
              class="px-4 py-2 rounded-lg bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors text-gray-900 dark:text-gray-100"
              aria-label="Cancel conversion and close modal"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => confirmDialog()}
              class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
              aria-label="Proceed with conversion despite warnings"
            >
              Proceed Anyway
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default ConfirmationModal;
