import type { Component } from 'solid-js';
import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { formatDuration } from '../utils/format-duration';

interface ProgressBarProps {
  progress: number;
  status: string;
  statusMessage?: string;
  showSpinner?: boolean;
  showElapsedTime?: boolean;
  startTime?: number;
  estimatedSecondsRemaining?: number | null;
  layout?: 'horizontal' | 'vertical'; // horizontal: label & percentage on sides, vertical: label & percentage stacked above bar
}

/**
 * Reusable progress bar component
 * Provides consistent progress indication with optional spinner, elapsed time, and ETA
 */
const ProgressBar: Component<ProgressBarProps> = (props) => {
  const [elapsedSeconds, setElapsedSeconds] = createSignal(0);

  createEffect(() => {
    if (!props.showElapsedTime || !props.startTime) {
      return;
    }

    const updateElapsed = () => {
      const now = Date.now();
      setElapsedSeconds(Math.floor((now - (props.startTime || now)) / 1000));
    };

    // Initial update
    updateElapsed();

    // Update every second
    const interval = setInterval(updateElapsed, 1000);

    onCleanup(() => {
      clearInterval(interval);
    });
  });

  const isHorizontal = () => props.layout === 'horizontal';

  return (
    <div class="flex flex-col gap-2">
      {/* Status and progress percentage header */}
      <div
        class={`flex items-center ${isHorizontal() ? 'justify-between' : 'justify-center'} text-sm font-medium text-gray-700 dark:text-gray-300`}
      >
        <Show when={props.showSpinner}>
          <svg class="animate-spin h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" aria-hidden="true">
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
        </Show>
        <span class={isHorizontal() ? '' : 'mr-2'}>{props.status}</span>
        <span class={`text-gray-600 dark:text-gray-400 ${isHorizontal() ? '' : 'ml-2'}`}>
          {props.progress}%
        </span>
      </div>

      {/* Progress bar */}
      <div
        class="w-full bg-gray-200 dark:bg-gray-800 rounded-full h-2.5"
        role="progressbar"
        aria-valuenow={props.progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={props.status}
      >
        <div
          class="bg-blue-600 dark:bg-blue-500 h-2.5 rounded-full transition-all duration-300"
          style={{ width: `${Math.max(0, Math.min(100, props.progress))}%` }}
        />
      </div>

      {/* Elapsed time and ETA */}
      <Show when={props.showElapsedTime && props.startTime}>
        <div class="text-xs text-gray-600 dark:text-gray-400 text-center font-mono">
          <span>Elapsed: {formatDuration(elapsedSeconds())}</span>
          <Show
            when={props.estimatedSecondsRemaining != null && props.estimatedSecondsRemaining > 0}
          >
            <span> | ETA: {formatDuration(props.estimatedSecondsRemaining!)}</span>
          </Show>
        </div>
      </Show>

      {/* Status message */}
      <Show when={props.statusMessage}>
        <p
          class="text-xs text-gray-600 dark:text-gray-400 text-center italic"
          role="status"
          aria-live="polite"
        >
          {props.statusMessage}
        </p>
      </Show>
    </div>
  );
};

export default ProgressBar;
