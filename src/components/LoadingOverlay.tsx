import { Show, type Component } from 'solid-js';

import ProgressBar from './ProgressBar';

/**
 * Loading overlay component props
 */
interface LoadingOverlayProps {
  /** Whether the overlay is visible */
  visible: boolean;
  /** Current loading status message */
  status: string;
  /** Progress percentage (0-100) */
  progress: number;
  /** Optional detailed status message */
  statusMessage?: string;
}

/**
 * Full-screen loading overlay for app initialization
 *
 * Displays during preloading of external dependencies.
 * Blocks user interaction until loading completes.
 */
const LoadingOverlay: Component<LoadingOverlayProps> = (props) => {
  return (
    <Show when={props.visible}>
      <div
        class="fixed inset-0 bg-gray-50 dark:bg-gray-950 flex items-center justify-center z-50"
        role="dialog"
        aria-modal="true"
        aria-label="Loading application"
        aria-busy="true"
      >
        <div class="w-full max-w-md px-6">
          <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6 shadow-lg">
            <h2 class="text-lg font-semibold text-gray-900 dark:text-white mb-4 text-center">
              Motion Converter
            </h2>

            <ProgressBar
              progress={props.progress}
              status={props.status}
              statusMessage={props.statusMessage}
              showSpinner={true}
              layout="horizontal"
            />

            <p class="mt-4 text-xs text-gray-500 dark:text-gray-400 text-center">
              First load may take up to 2 minutes depending on your connection
            </p>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default LoadingOverlay;
