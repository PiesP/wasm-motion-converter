import { type Component, For } from 'solid-js';
import { toasts } from '../stores/toast-store';
import Toast from './Toast';

const ToastContainer: Component = () => {
  return (
    <div
      class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none sm:bottom-4 sm:right-4 max-sm:left-1/2 max-sm:-translate-x-1/2"
      aria-live="polite"
      aria-atomic="false"
    >
      <For each={toasts().slice(-3)}>
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
