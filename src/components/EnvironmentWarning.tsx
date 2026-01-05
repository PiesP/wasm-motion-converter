import { createSignal, onMount, type Component } from 'solid-js';

const STORAGE_KEY = 'envWarningExpanded';

const EnvironmentWarning: Component = () => {
  const [isExpanded, setIsExpanded] = createSignal(true);

  // Load state from localStorage on mount
  onMount(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) {
      setIsExpanded(saved === 'true');
    }
  });

  const toggleExpanded = () => {
    const newState = !isExpanded();
    setIsExpanded(newState);
    localStorage.setItem(STORAGE_KEY, String(newState));
  };

  const testEnvironment = () => {
    const hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
    const isCrossOriginIsolated = crossOriginIsolated;

    console.group('🧪 Environment Test Results');
    console.log('SharedArrayBuffer:', hasSharedArrayBuffer ? '✅ Available' : '❌ Unavailable');
    console.log('crossOriginIsolated:', isCrossOriginIsolated ? '✅ true' : '❌ false');
    console.groupEnd();

    alert(
      `Environment Test Results:\n\n` +
        `SharedArrayBuffer: ${hasSharedArrayBuffer ? 'Available' : 'Unavailable'}\n` +
        `crossOriginIsolated: ${isCrossOriginIsolated ? 'true' : 'false'}\n\n` +
        `See console for more details.`
    );
  };

  return (
    <div class="bg-yellow-50 dark:bg-yellow-950 border-l-4 border-yellow-400 dark:border-yellow-500 p-4">
      <div class="flex">
        <div class="flex-shrink-0">
          <svg
            class="h-5 w-5 text-yellow-400 dark:text-yellow-500"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fill-rule="evenodd"
              d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
              clip-rule="evenodd"
            />
          </svg>
        </div>
        <div class="ml-3 flex-1">
          <div class="flex items-start justify-between">
            <h3 class="text-sm font-medium text-yellow-800 dark:text-yellow-300">
              Environment Not Supported
            </h3>
            <button
              type="button"
              onClick={toggleExpanded}
              class="ml-3 text-sm text-yellow-700 dark:text-yellow-400 hover:text-yellow-900 dark:hover:text-yellow-200 underline focus:outline-none focus:ring-2 focus:ring-yellow-500 rounded"
              aria-expanded={isExpanded()}
              aria-label={isExpanded() ? 'Hide details' : 'Show details'}
            >
              {isExpanded() ? 'Hide details' : 'Show details'}
            </button>
          </div>

          {isExpanded() && (
            <>
              <div class="mt-2 text-sm text-yellow-700 dark:text-yellow-400">
                <p>
                  SharedArrayBuffer is not available. This application requires cross-origin
                  isolation to work properly.
                </p>
                <p class="mt-2">
                  <strong>If you're running this locally:</strong> Make sure you're using the Vite
                  dev server with the correct headers configured.
                </p>
                <p class="mt-2">
                  <strong>If you're accessing a deployed site:</strong> Contact the administrator to
                  configure COOP/COEP headers. If FFmpeg fails to start, browser extensions or
                  strict security settings may be blocking module/blob workers—try an InPrivate
                  window or disable blockers temporarily.
                </p>
              </div>
              <div class="mt-3">
                <button
                  type="button"
                  onClick={testEnvironment}
                  class="inline-flex items-center px-3 py-1.5 border border-yellow-600 dark:border-yellow-500 text-sm font-medium rounded text-yellow-700 dark:text-yellow-300 bg-yellow-100 dark:bg-yellow-900 hover:bg-yellow-200 dark:hover:bg-yellow-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-yellow-500"
                >
                  🧪 Test Environment
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default EnvironmentWarning;
