import type { Component } from 'solid-js';

interface ErrorDisplayProps {
  message: string;
  suggestion?: string;
  onRetry: () => void;
  onSelectNewFile: () => void;
}

const ErrorDisplay: Component<ErrorDisplayProps> = (props) => {
  return (
    <div
      class="bg-red-50 dark:bg-red-950 border-l-4 border-red-400 dark:border-red-500 p-4"
      role="alert"
      aria-live="assertive"
    >
      <div class="flex">
        <div class="flex-shrink-0">
          <svg
            class="h-5 w-5 text-red-400 dark:text-red-500"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fill-rule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
              clip-rule="evenodd"
            />
          </svg>
        </div>
        <div class="ml-3 flex-1">
          <h3 class="text-sm font-medium text-red-800 dark:text-red-300">Conversion Failed</h3>
          <p class="mt-2 text-sm text-red-700 dark:text-red-400">{props.message}</p>
          {props.suggestion && (
            <div class="mt-2 p-3 bg-red-100 dark:bg-red-900 rounded text-sm text-red-700 dark:text-red-300">
              <strong>Suggestion:</strong> {props.suggestion}
            </div>
          )}
          <div class="mt-4 flex gap-3">
            <button
              type="button"
              class="inline-flex items-center px-3 py-2 border border-transparent text-sm font-medium rounded-md text-red-700 dark:text-red-300 bg-red-100 dark:bg-red-900 hover:bg-red-200 dark:hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 dark:focus:ring-offset-gray-900"
              onClick={props.onRetry}
            >
              Retry with Same File
            </button>
            <button
              type="button"
              class="inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 dark:focus:ring-offset-gray-900"
              onClick={props.onSelectNewFile}
            >
              Select Different File
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ErrorDisplay;
