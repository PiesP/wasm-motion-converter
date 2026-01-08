import { Show, splitProps } from 'solid-js';

import type { Component } from 'solid-js';

/**
 * Memory usage threshold percentage for critical warning
 */
const MEMORY_CRITICAL_THRESHOLD = 80;

/**
 * Memory warning component props
 */
interface MemoryWarningProps {
  /** Whether the warning is shown during active conversion */
  isDuringConversion: boolean;
  /** Callback to reduce conversion settings */
  onReduceSettings?: () => void;
  /** Callback to cancel ongoing conversion */
  onCancel?: () => void;
  /** Callback to dismiss the warning */
  onDismiss?: () => void;
}

/**
 * Memory warning alert component
 *
 * Displays a critical warning when browser memory usage exceeds threshold.
 * Shows different messages and actions depending on whether conversion is active.
 * Includes accessibility attributes for screen readers and proper alert semantics.
 *
 * @example
 * ```tsx
 * <MemoryWarning
 *   isDuringConversion={false}
 *   onReduceSettings={() => setQuality('low')}
 *   onDismiss={() => setShowWarning(false)}
 * />
 * ```
 */
const MemoryWarning: Component<MemoryWarningProps> = (props) => {
  const [local] = splitProps(props, [
    'isDuringConversion',
    'onReduceSettings',
    'onCancel',
    'onDismiss',
  ]);
  const warningTitle = (): string =>
    local.isDuringConversion ? 'High Memory Usage Detected' : 'High Memory Warning';

  const warningMessage = (): string =>
    local.isDuringConversion
      ? `Browser memory usage is critically high (>${MEMORY_CRITICAL_THRESHOLD}% of JS heap). This could cause the conversion to fail or the browser to crash.`
      : `Your browser memory usage is already high (>${MEMORY_CRITICAL_THRESHOLD}% of JS heap). Starting conversion now may cause failures or crashes.`;

  return (
    <div
      class="bg-red-50 dark:bg-red-950 border-l-4 border-red-400 dark:border-red-500 rounded-lg p-4"
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
    >
      <div class="flex items-start">
        <div class="flex-shrink-0">
          <svg
            class="h-5 w-5 text-red-400 dark:text-red-500"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fill-rule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
              clip-rule="evenodd"
            />
          </svg>
        </div>
        <div class="ml-3 flex-1">
          <h3 class="text-sm font-medium text-red-800 dark:text-red-200">{warningTitle()}</h3>
          <div class="mt-2 text-sm text-red-700 dark:text-red-300">
            <p>{warningMessage()}</p>
            <Show when={!local.isDuringConversion}>
              <p class="mt-2">
                <strong>Recommendation:</strong> Close other browser tabs before starting
                conversion, or use lower quality settings.
              </p>
            </Show>
          </div>

          <div class="mt-4 flex flex-wrap gap-3">
            <Show
              when={local.isDuringConversion}
              fallback={
                <>
                  <Show when={local.onDismiss}>
                    <button
                      type="button"
                      onClick={local.onDismiss}
                      class="inline-flex items-center px-3 py-2 border border-red-300 dark:border-red-700 text-sm leading-4 font-medium rounded-md text-red-700 dark:text-red-300 bg-white dark:bg-red-950 hover:bg-red-50 dark:hover:bg-red-900 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                      aria-label="Close memory warning and try again"
                    >
                      Close Tabs & Try Again
                    </button>
                  </Show>
                  <Show when={local.onReduceSettings}>
                    <button
                      type="button"
                      onClick={local.onReduceSettings}
                      class="inline-flex items-center px-3 py-2 border border-transparent text-sm leading-4 font-medium rounded-md text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                      aria-label="Reduce quality settings and start conversion"
                    >
                      Use Low Quality & Convert
                    </button>
                  </Show>
                </>
              }
            >
              <Show when={local.onCancel}>
                <button
                  type="button"
                  onClick={local.onCancel}
                  class="inline-flex items-center px-3 py-2 border border-transparent text-sm leading-4 font-medium rounded-md text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                  aria-label="Cancel ongoing conversion"
                >
                  Cancel Conversion
                </button>
              </Show>
              <Show when={local.onDismiss}>
                <button
                  type="button"
                  onClick={local.onDismiss}
                  class="inline-flex items-center px-3 py-2 border border-red-300 dark:border-red-700 text-sm leading-4 font-medium rounded-md text-red-700 dark:text-red-300 bg-white dark:bg-red-950 hover:bg-red-50 dark:hover:bg-red-900 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                  aria-label="Dismiss warning and continue conversion"
                >
                  Continue Anyway
                </button>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MemoryWarning;
