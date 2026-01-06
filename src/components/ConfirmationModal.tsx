import { For, Show } from 'solid-js';
import { confirmationStore } from '../stores/confirmation-store';
import type { ValidationWarning } from '../types/validation';

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

export function ConfirmationModal() {
  const state = () => confirmationStore.state;

  return (
    <Show when={state().isVisible}>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div class="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
          <h2 class="text-xl font-semibold mb-4 text-gray-900 dark:text-gray-100">
            Conversion Warning
          </h2>

          <div class="space-y-3 mb-6">
            <For each={state().warnings}>
              {(warning) => (
                <div
                  class="border-l-4 pl-4 py-2"
                  classList={{
                    'border-red-500': warning.severity === 'error',
                    'border-yellow-500': warning.severity === 'warning',
                    'border-blue-500': warning.severity === 'info',
                  }}
                >
                  <div class="flex items-start gap-2">
                    <span class="text-lg">{getSeverityIcon(warning.severity)}</span>
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
                          💡 {warning.suggestedAction}
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
              type="button"
              onClick={() => confirmationStore.cancel()}
              class="px-4 py-2 rounded-lg bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors text-gray-900 dark:text-gray-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => confirmationStore.confirm()}
              class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
            >
              Proceed Anyway
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
