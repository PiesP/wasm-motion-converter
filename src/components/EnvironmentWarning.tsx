import type { Component } from 'solid-js';

const EnvironmentWarning: Component = () => {
  return (
    <div class="bg-yellow-50 dark:bg-yellow-950 border-l-4 border-yellow-400 dark:border-yellow-500 p-4 mb-6">
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
        <div class="ml-3">
          <h3 class="text-sm font-medium text-yellow-800 dark:text-yellow-300">
            Environment Not Supported
          </h3>
          <div class="mt-2 text-sm text-yellow-700 dark:text-yellow-400">
            <p>
              SharedArrayBuffer is not available. This application requires cross-origin isolation
              to work properly.
            </p>
            <p class="mt-2">
              <strong>If you're running this locally:</strong> Make sure you're using the Vite dev
              server with the correct headers configured.
            </p>
            <p class="mt-2">
              <strong>If you're accessing a deployed site:</strong> Contact the administrator to
              configure COOP/COEP headers.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default EnvironmentWarning;
