// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import { formatDuration } from '@utils/format-utils';
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  splitProps,
} from 'solid-js';

/** Thin horizontal phase indicator bar above the main progress bar. */
const PHASE_SEGMENTS = [
  { label: 'Decoding', colorClass: 'bg-purple-500' },
  { label: 'Encoding', colorClass: 'bg-blue-500' },
] as const;

interface ProgressBarProps {
  /** Overall progress 0-100 */
  progress: number;
  /** Status text displayed above the bar */
  status: string;
  /** Secondary detail line shown between bar and elapsed row */
  statusMessage?: string;
  /** Show a spinning indicator next to the status label */
  showSpinner?: boolean;
  /** Add an auto-updating elapsed-timestamp row below the bar */
  showElapsedTime?: boolean;
  /** Epoch-ms timestamp when the current phase started */
  startTime?: number;
  /** ETA in seconds, as computed by ETACalculator */
  estimatedSecondsRemaining?: number | null;
  /** 'horizontal' keeps the existing inline label layout; 'vertical' stacks everything */
  layout?: 'horizontal' | 'vertical';
  /**
   * Fine-grained sub-phase (0-100) rendered as inset ticks on the bar,
   * representing e.g. "frame extraction" inside the overall "decoding" phase.
   */
  subPhaseProgress?: number;
  /** Label for the sub-phase tick, shown in the detail row */
  subPhaseLabel?: string;
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
    'subPhaseProgress',
    'subPhaseLabel',
  ]);
  const [elapsedSeconds, setElapsedSeconds] = createSignal(0);

  const progressValue = createMemo(() => {
    const rawValue = Number(local.progress);
    if (!Number.isFinite(rawValue)) return 0;
    return Math.min(100, Math.max(0, Math.round(rawValue)));
  });

  const subPhaseValue = createMemo(() => {
    const raw = Number(local.subPhaseProgress ?? 0);
    if (!Number.isFinite(raw)) return 0;
    return Math.min(100, Math.max(0, Math.round(raw)));
  });

  const isHorizontal = createMemo(() => local.layout === 'horizontal');

  createEffect(() => {
    if (!local.showElapsedTime || !local.startTime) return;

    const updateElapsed = () => {
      const now = performance.now();
      setElapsedSeconds(Math.floor(Math.max(0, now - local.startTime!) / 1000));
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);

    onCleanup(() => {
      clearInterval(interval);
    });
  });

  /** Translate overall 0-100 to the active sub-phase's visual segment (0-50 → decode, 50-100 → encode). */
  const activePhaseIndex = createMemo(() => (progressValue() > 50 ? 1 : 0));

  return (
    <div class="flex flex-col gap-3">
      {/* Header row: spinner + status + main percent */}
      <div
        class={`flex items-center ${
          isHorizontal() ? 'justify-between' : 'justify-center'
        } text-sm font-medium text-gray-700 dark:text-gray-300`}
      >
        <Show when={local.showSpinner}>
          <svg
            class="animate-spin h-5 w-5 mr-2 text-blue-600 dark:text-blue-400"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
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
        <span
          class={`text-gray-600 dark:text-gray-400 font-mono text-xs tabular-nums ${isHorizontal() ? '' : 'ml-2'}`}
        >
          {progressValue()}%
        </span>
      </div>

      {/* Two-phase segmented bar */}
      <div class="flex flex-col gap-1">
        <div
          class="flex h-3 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800"
          role="progressbar"
          aria-valuenow={progressValue()}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={local.status}
          data-progress={progressValue()}
        >
          {/* Decode segment: fills 0-50% of overall → maps to 0-100% width of this half */}
          <div class="flex h-full flex-1 overflow-hidden">
            <div
              class={`h-full rounded-l-full transition-all duration-300 ${PHASE_SEGMENTS[0].colorClass}`}
              style={{ width: `${Math.min(100, progressValue() * 2)}%` }}
            />
          </div>
          {/* Encode segment: fills 50-100% of overall → maps to 0-100% width of this half */}
          <div class={`flex h-full flex-1 overflow-hidden ${activePhaseIndex() === 1 ? '' : ''}`}>
            <div
              class={`h-full rounded-r-full transition-all duration-300 ${
                activePhaseIndex() === 1 ? PHASE_SEGMENTS[1].colorClass : 'bg-transparent'
              }`}
              style={{ width: `${Math.max(0, Math.min(100, (progressValue() - 50) * 2))}%` }}
            />
          </div>
        </div>

        {/* Phase labels beneath bar */}
        <div class="flex justify-between text-[10px] text-gray-500 dark:text-gray-500 font-medium">
          <span>Decoding</span>
          <span>Encoding</span>
        </div>
      </div>

      {/* Sub-phase detail row (e.g. "Extracting frames: 45/75") */}
      <Show when={local.subPhaseLabel || local.statusMessage}>
        <div class="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400">
          <span class="italic">{local.subPhaseLabel ?? local.statusMessage}</span>
          <Show when={local.subPhaseProgress != null && local.subPhaseProgress > 0}>
            <span class="font-mono tabular-nums text-gray-500 dark:text-gray-500">
              {subPhaseValue()}%
            </span>
          </Show>
        </div>
      </Show>

      {/* Elapsed / ETA row */}
      <Show when={local.showElapsedTime && local.startTime}>
        <div class="flex items-center justify-center gap-3 text-xs text-gray-600 dark:text-gray-400 font-mono tabular-nums">
          <span>Elapsed: {formatDuration(elapsedSeconds())}</span>
          <Show
            when={local.estimatedSecondsRemaining != null && local.estimatedSecondsRemaining > 0}
          >
            <span class="text-gray-500 dark:text-gray-600">|</span>
            <span>ETA: {formatDuration(local.estimatedSecondsRemaining!)}</span>
          </Show>
          <Show
            when={local.estimatedSecondsRemaining == null || local.estimatedSecondsRemaining <= 0}
          >
            <span class="text-gray-500 dark:text-gray-600">|</span>
            <span class="text-gray-500 dark:text-gray-500 italic">Calculating...</span>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default ProgressBar;
