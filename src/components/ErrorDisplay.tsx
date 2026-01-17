import Panel from '@components/ui/Panel';
import type { ConversionErrorType } from '@t/conversion-types';
import { type Component, createMemo, onMount, Show, splitProps } from 'solid-js';

const ERROR_MESSAGES: Record<ConversionErrorType, string> = {
  format: 'This video format is not supported. Please try a different file.',
  codec: 'This video codec cannot be processed. Please try a different file.',
  timeout: 'Conversion took too long. Try a shorter video or lower quality settings.',
  memory: 'Ran out of memory. Close other browser tabs or use lower quality settings.',
  general: '',
};

const ERROR_ICONS: Partial<Record<ConversionErrorType, string>> = {
  timeout: '⏱️',
  memory: '💾',
  format: '📁',
  codec: '📁',
};

interface ErrorDisplayProps {
  message: string;
  suggestion?: string;
  errorType?: ConversionErrorType;
  onRetry: () => void;
  onSelectNewFile: () => void;
  onDismiss?: () => void;
}

const ErrorDisplay: Component<ErrorDisplayProps> = (props) => {
  const [local] = splitProps(props, [
    'message',
    'suggestion',
    'errorType',
    'onRetry',
    'onSelectNewFile',
    'onDismiss',
  ]);
  let retryButtonRef: HTMLButtonElement | undefined;

  onMount(() => {
    queueMicrotask(() => {
      retryButtonRef?.focus();
    });
  });

  const canRetry = createMemo(() => local.errorType !== 'format' && local.errorType !== 'codec');

  const userFriendlyMessage = createMemo(() => {
    if (!local.errorType || local.errorType === 'general') {
      return local.message;
    }

    return ERROR_MESSAGES[local.errorType] ?? local.message;
  });

  const errorIcon = createMemo(() => ERROR_ICONS[local.errorType ?? 'general'] ?? '');

  const handleDismiss = () => local.onDismiss?.();
  const handleRetry = () => local.onRetry();
  const handleSelectNewFile = () => local.onSelectNewFile();

  return (
    <Panel
      class="relative border-l-4 border-red-400 dark:border-red-500 p-4 bg-red-50 dark:bg-red-950"
      role="alert"
      ariaLive="assertive"
    >
      <Show when={local.onDismiss}>
        <button
          type="button"
          onClick={handleDismiss}
          class="absolute top-4 right-4 p-2 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors rounded-md hover:bg-red-100 dark:hover:bg-red-900"
          aria-label="Dismiss error message"
        >
          <svg
            class="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </Show>
      <div class="flex">
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
          <h3 class="text-sm font-medium text-red-800 dark:text-red-300">
            Conversion Failed {errorIcon() && <span class="ml-1">{errorIcon()}</span>}
          </h3>
          <p class="mt-2 text-sm text-red-700 dark:text-red-400">{userFriendlyMessage()}</p>
          <Show when={local.suggestion}>
            <div class="mt-2 p-3 bg-red-100 dark:bg-red-900 rounded text-sm text-red-700 dark:text-red-300">
              <strong>Suggestion:</strong> {local.suggestion}
            </div>
          </Show>
          <div class="mt-4 flex gap-3">
            <Show
              when={canRetry()}
              fallback={
                <button
                  type="button"
                  class="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 dark:focus:ring-offset-gray-900"
                  onClick={handleSelectNewFile}
                  aria-label="Select a different video file to convert"
                >
                  Select Different File
                </button>
              }
            >
              <button
                ref={retryButtonRef}
                type="button"
                data-error-retry-button
                class="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 dark:focus:ring-offset-gray-900"
                onClick={handleRetry}
                aria-label="Retry conversion with the same file"
              >
                Retry with Same File
              </button>
              <button
                type="button"
                class="inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 dark:focus:ring-offset-gray-900"
                onClick={handleSelectNewFile}
                aria-label="Select a different video file to convert"
              >
                Select Different File
              </button>
            </Show>
          </div>
        </div>
      </div>
    </Panel>
  );
};

export default ErrorDisplay;
