import { type Component, createEffect, createSignal, onCleanup, Show } from 'solid-js';
import { formatDuration } from '../utils/format-duration';

interface ConversionProgressProps {
  progress: number;
  status: string;
  statusMessage?: string;
  showElapsedTime?: boolean;
  startTime?: number;
}

const ConversionProgress: Component<ConversionProgressProps> = (props) => {
  const [elapsedSeconds, setElapsedSeconds] = createSignal(0);

  createEffect(() => {
    if (!props.showElapsedTime || !props.startTime) {
      setElapsedSeconds(0);
      return;
    }
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - props.startTime) / 1000);
      setElapsedSeconds(elapsed);
    }, 1000);

    onCleanup(() => {
      clearInterval(interval);
    });
  });

  return (
    <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6">
      <div class="mb-4">
        <div class="flex justify-between items-center mb-2">
          <span class="text-sm font-medium text-gray-700 dark:text-gray-300">{props.status}</span>
          <span class="text-sm font-medium text-gray-700 dark:text-gray-300">
            {props.progress}%
          </span>
        </div>
        <div class="w-full bg-gray-200 dark:bg-gray-800 rounded-full h-2.5">
          <div
            class="bg-blue-600 dark:bg-blue-500 h-2.5 rounded-full transition-all duration-300"
            style={{ width: `${props.progress}%` }}
          />
        </div>
      </div>
      <div class="flex flex-col items-center justify-center text-gray-500 dark:text-gray-400">
        <div class="flex items-center">
          <svg class="animate-spin h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24">
            <circle
              class="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              stroke-width="4"
            />
            <path
              class="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <div class="flex items-center gap-2">
            <span class="text-sm">Processing...</span>
            {props.showElapsedTime && (
              <span class="text-sm font-mono text-gray-600 dark:text-gray-400">
                ({formatDuration(elapsedSeconds())})
              </span>
            )}
          </div>
        </div>
        <Show when={props.statusMessage}>
          <p class="text-sm text-gray-600 dark:text-gray-400 mt-2 italic">{props.statusMessage}</p>
        </Show>
      </div>
    </div>
  );
};

export default ConversionProgress;
