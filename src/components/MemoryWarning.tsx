import type { Component } from 'solid-js';

interface MemoryWarningProps {
  isDuringConversion: boolean;
  onReduceSettings?: () => void;
  onCancel?: () => void;
  onDismiss?: () => void;
}

const MemoryWarning: Component<MemoryWarningProps> = (props) => {
  return (
    <div
      class="bg-red-50 dark:bg-red-950 border-l-4 border-red-400 dark:border-red-500 rounded-lg p-4"
      role="alert"
      aria-live="assertive"
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
          <h3 class="text-sm font-medium text-red-800 dark:text-red-200">
            {props.isDuringConversion ? 'High Memory Usage Detected' : 'High Memory Warning'}
          </h3>
          <div class="mt-2 text-sm text-red-700 dark:text-red-300">
            <p>
              {props.isDuringConversion
                ? 'Browser memory usage is critically high (>80% of JS heap). This could cause the conversion to fail or the browser to crash.'
                : 'Your browser memory usage is already high (>80% of JS heap). Starting conversion now may cause failures or crashes.'}
            </p>
            {!props.isDuringConversion && (
              <p class="mt-2">
                <strong>Recommendation:</strong> Close other browser tabs before starting
                conversion, or use lower quality settings.
              </p>
            )}
          </div>

          <div class="mt-4 flex flex-wrap gap-3">
            {props.isDuringConversion ? (
              <>
                {props.onCancel && (
                  <button
                    type="button"
                    onClick={props.onCancel}
                    class="inline-flex items-center px-3 py-2 border border-transparent text-sm leading-4 font-medium rounded-md text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                  >
                    Cancel Conversion
                  </button>
                )}
                {props.onDismiss && (
                  <button
                    type="button"
                    onClick={props.onDismiss}
                    class="inline-flex items-center px-3 py-2 border border-red-300 dark:border-red-700 text-sm leading-4 font-medium rounded-md text-red-700 dark:text-red-300 bg-white dark:bg-red-950 hover:bg-red-50 dark:hover:bg-red-900 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                  >
                    Continue Anyway
                  </button>
                )}
              </>
            ) : (
              <>
                {props.onDismiss && (
                  <button
                    type="button"
                    onClick={props.onDismiss}
                    class="inline-flex items-center px-3 py-2 border border-red-300 dark:border-red-700 text-sm leading-4 font-medium rounded-md text-red-700 dark:text-red-300 bg-white dark:bg-red-950 hover:bg-red-50 dark:hover:bg-red-900 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                  >
                    Close Tabs & Try Again
                  </button>
                )}
                {props.onReduceSettings && (
                  <button
                    type="button"
                    onClick={props.onReduceSettings}
                    class="inline-flex items-center px-3 py-2 border border-transparent text-sm leading-4 font-medium rounded-md text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                  >
                    Use Low Quality & Convert
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MemoryWarning;
