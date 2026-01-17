import { type Component, Show, splitProps } from 'solid-js';

import ProgressBar from './ProgressBar';

const APP_TITLE = 'Motion Converter';
const LOADING_HINT = 'First load may take up to 2 minutes depending on your connection';

interface LoadingOverlayProps {
  visible: boolean;
  status: string;
  progress: number;
  statusMessage?: string;
}

const LoadingOverlay: Component<LoadingOverlayProps> = (props) => {
  const [local] = splitProps(props, ['visible', 'status', 'progress', 'statusMessage']);

  return (
    <Show when={local.visible}>
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
              {APP_TITLE}
            </h2>

            <ProgressBar
              progress={local.progress}
              status={local.status}
              statusMessage={local.statusMessage}
              showSpinner={true}
              layout="horizontal"
            />

            <p class="mt-4 text-xs text-gray-500 dark:text-gray-400 text-center">{LOADING_HINT}</p>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default LoadingOverlay;
