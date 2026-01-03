import { type Component, For } from 'solid-js';
import type { PerformanceWarning as PerformanceWarningType } from '../types/conversion-types';

interface PerformanceWarningProps {
  warnings: PerformanceWarningType[];
  onProceed: () => void;
  onCancel: () => void;
}

const PerformanceWarning: Component<PerformanceWarningProps> = (props) => {
  return (
    <div class="bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded-lg p-6 mb-6">
      <div class="flex items-start">
        <div class="flex-shrink-0">
          <svg
            class="h-6 w-6 text-yellow-600 dark:text-yellow-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <div class="ml-3 flex-1">
          <h3 class="text-lg font-medium text-yellow-800 dark:text-yellow-300">
            Performance Warning
          </h3>
          <div class="mt-2 text-sm text-yellow-700 dark:text-yellow-400">
            <p class="mb-3">
              Your video has characteristics that may result in slow conversion or large output
              files:
            </p>
            <ul class="list-disc list-inside space-y-2">
              <For each={props.warnings}>
                {(warning) => (
                  <li>
                    <strong>{warning.message}</strong>
                    <br />
                    <span class="text-yellow-600 dark:text-yellow-500">
                      {warning.recommendation}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </div>
          <div class="mt-4 flex gap-3">
            <button
              type="button"
              class="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-yellow-600 hover:bg-yellow-700 dark:bg-yellow-700 dark:hover:bg-yellow-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-yellow-500 dark:focus:ring-offset-gray-900"
              onClick={props.onProceed}
            >
              Proceed Anyway
            </button>
            <button
              type="button"
              class="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-700 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 dark:focus:ring-offset-gray-900"
              onClick={props.onCancel}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PerformanceWarning;
