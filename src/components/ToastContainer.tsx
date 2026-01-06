import type { Component } from 'solid-js';
import { For } from 'solid-js';

import { toasts } from '../stores/toast-store';
import Toast from './Toast';

/**
 * Maximum number of toasts to display simultaneously
 */
const MAX_VISIBLE_TOASTS = 3;

/**
 * Z-index for toast container (must be above other elements)
 */
const TOAST_Z_INDEX = 'z-50';

/**
 * Toast container component
 *
 * Displays up to 3 most recent toast notifications in the bottom-right corner
 * (or bottom-center on mobile devices). Uses ARIA live region for accessibility.
 *
 * @returns Toast container with notification stack
 */
const ToastContainer: Component = () => {
  return (
    <div
      class={`fixed bottom-4 right-4 ${TOAST_Z_INDEX} flex flex-col gap-2 pointer-events-none sm:bottom-4 sm:right-4 max-sm:left-1/2 max-sm:-translate-x-1/2`}
      aria-live="polite"
      aria-atomic="false"
    >
      <For each={toasts().slice(-MAX_VISIBLE_TOASTS)}>
        {(toast) => (
          <div class="pointer-events-auto">
            <Toast toast={toast} />
          </div>
        )}
      </For>
    </div>
  );
};

export default ToastContainer;
