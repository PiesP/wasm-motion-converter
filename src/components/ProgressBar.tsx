import { formatDuration } from '@utils/format-duration';
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  splitProps,
} from 'solid-js';

const ELAPSED_TIME_UPDATE_INTERVAL = 1000;

interface ProgressBarProps {
  progress: number;
  status: string;
  statusMessage?: string;
  showSpinner?: boolean;
  showElapsedTime?: boolean;
  startTime?: number;
  estimatedSecondsRemaining?: number | null;
  layout?: 'horizontal' | 'vertical';
}

const ProgressBar: Component<ProgressBarProps> = (props) => {
  const [local] = splitProps(props, [
    'progress',
    'status',
    'statusMessage',
    'showSpinner',
    'showElapsedTime',
    'startTime',
    'estimatedSecondsRemaining',
    'layout',
  ]);
  const [elapsedSeconds, setElapsedSeconds] = createSignal(0);

  const progressValue = createMemo(() => {
    const rawValue = Number(local.progress);
    if (!Number.isFinite(rawValue)) {
      return 0;
    }
    return Math.min(100, Math.max(0, Math.round(rawValue)));
  });

  const isHorizontal = createMemo(() => local.layout === 'horizontal');

  createEffect(() => {
    if (!local.showElapsedTime || !local.startTime) {
      return;
    }

    const updateElapsed = () => {
      const now = Date.now();
      setElapsedSeconds(Math.floor((now - (local.startTime || now)) / 1000));
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, ELAPSED_TIME_UPDATE_INTERVAL);

    onCleanup(() => {
      clearInterval(interval);
    });
  });

  return (
    <div class="flex flex-col gap-2">
      <div
        class={`flex items-center ${
          isHorizontal() ? 'justify-between' : 'justify-center'
        } text-sm font-medium text-gray-700 dark:text-gray-300`}
      >
        <Show when={local.showSpinner}>
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
        <span class={isHorizontal() ? '' : 'mr-2'}>{local.status}</span>
        <span class={`text-gray-600 dark:text-gray-400 ${isHorizontal() ? '' : 'ml-2'}`}>
          {progressValue()}%
        </span>
      </div>

      <div
        class="w-full bg-gray-200 dark:bg-gray-800 rounded-full h-2.5"
        role="progressbar"
        aria-valuenow={progressValue()}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={local.status}
      >
        <div
          class="bg-blue-600 dark:bg-blue-500 h-2.5 rounded-full transition-all duration-300"
          style={{ width: `${progressValue()}%` }}
        />
      </div>

      <Show when={local.showElapsedTime && local.startTime}>
        <div class="text-xs text-gray-600 dark:text-gray-400 text-center font-mono">
          <span>Elapsed: {formatDuration(elapsedSeconds())}</span>
          <Show
            when={local.estimatedSecondsRemaining != null && local.estimatedSecondsRemaining > 0}
          >
            <span> | ETA: {formatDuration(local.estimatedSecondsRemaining!)}</span>
          </Show>
        </div>
      </Show>

      <Show when={local.statusMessage}>
        <p
          class="text-xs text-gray-600 dark:text-gray-400 text-center italic"
          role="status"
          aria-live="polite"
        >
          {local.statusMessage}
        </p>
      </Show>
    </div>
  );
};

export default ProgressBar;
