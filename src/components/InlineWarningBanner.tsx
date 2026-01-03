import { type Component, For } from 'solid-js';
import type { PerformanceWarning } from '../types/conversion-types';

interface InlineWarningBannerProps {
  warnings: PerformanceWarning[];
  actionLabel?: string;
  onAction?: () => void;
}

const InlineWarningBanner: Component<InlineWarningBannerProps> = (props) => {
  return (
    <div
      class="bg-yellow-50 dark:bg-yellow-950 border-l-4 border-yellow-400 dark:border-yellow-500 rounded-lg p-4"
      role="alert"
      aria-live="polite"
    >
      <div class="flex items-start">
        <div class="flex-shrink-0">
          <svg
            class="h-5 w-5 text-yellow-400 dark:text-yellow-500"
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
          <h3 class="text-sm font-medium text-yellow-800 dark:text-yellow-300">
            Performance Warning
          </h3>
          <div class="mt-2 text-sm text-yellow-700 dark:text-yellow-400">
            <p class="mb-2">Your video may result in slow conversion or large output files:</p>
            <ul class="list-disc list-inside space-y-1">
              <For each={props.warnings}>
                {(warning) => (
                  <li>
                    <strong>{warning.message}</strong> - {warning.recommendation}
                  </li>
                )}
              </For>
            </ul>
            {props.onAction && props.actionLabel ? (
              <div class="mt-3">
                <button
                  type="button"
                  class="inline-flex items-center px-3 py-2 border border-transparent text-xs font-medium rounded-md text-yellow-900 bg-yellow-200 hover:bg-yellow-300 dark:text-yellow-100 dark:bg-yellow-800 dark:hover:bg-yellow-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-yellow-500 dark:focus:ring-offset-gray-900"
                  onClick={props.onAction}
                >
                  {props.actionLabel}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};

export default InlineWarningBanner;
