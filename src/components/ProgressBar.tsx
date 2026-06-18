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
  { label: 'Preparing', colorClass: 'bg-amber-500', phase: 'demuxing' },
  { label: 'Decoding', colorClass: 'bg-purple-500', phase: 'decoding' },
  { label: 'Encoding', colorClass: 'bg-blue-500', phase: 'encoding' },
  { label: 'Finalizing', colorClass: 'bg-green-500', phase: 'assembling' },
] as const;

import type { ConversionPhase } from '@t/v2-conversion-types';

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
  /** Current frame number for frame-level progress */
  currentFrame?: number;
  /** Total frame number for frame-level progress */
  totalFrames?: number;
  /** Memory usage string (e.g. "128 MB / 512 MB (25%)") */
  memoryUsage?: string | null;
  /** Active phase for multi-segment bar */
  phase?: ConversionPhase;
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
    'currentFrame',
    'totalFrames',
    'memoryUsage',
    'phase',
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

  const activePhaseIndex = createMemo(() => {
    const p = local.phase;
    if (p === 'assembling') return 3;
    if (p === 'encoding') return 2;
    if (p === 'decoding') return 1;
    return 0;
  });

  const showFrameCounter = createMemo(
    () => local.currentFrame != null && local.totalFrames != null && local.totalFrames > 0
  );

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

  return (
    <div
      class="flex flex-col gap-3"
      role="status"
      aria-live="polite"
      aria-busy={progressValue() > 0 && progressValue() < 100}
    >
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

      {/* Multi-phase segmented bar */}
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
          {PHASE_SEGMENTS.map((seg, idx) => {
            const isPast = idx < activePhaseIndex();
            const isActive = idx === activePhaseIndex();
            const segmentWidth = 25; // each phase is 25% of the bar

            let widthPercent: number;
            if (isPast) {
              // Completed phases: fully filled
              widthPercent = segmentWidth;
            } else if (isActive) {
              // Active phase: map overall progress to this segment's portion
              // progressValue() maps to 0-100 overall, each segment covers 25%
              const segmentStart = idx * 25;
              const segmentEnd = (idx + 1) * 25;
              const clampedProgress = Math.max(segmentStart, Math.min(segmentEnd, progressValue()));
              widthPercent =
                ((clampedProgress - segmentStart) / (segmentEnd - segmentStart)) * segmentWidth;
            } else {
              // Future phases: empty
              widthPercent = 0;
            }

            return (
              <div class="flex h-full flex-1 overflow-hidden">
                <div
                  class={`h-full transition-all duration-300 ${
                    widthPercent > 0 ? seg.colorClass : 'bg-transparent'
                  } ${idx === 0 ? 'rounded-l-full' : ''} ${idx === PHASE_SEGMENTS.length - 1 ? 'rounded-r-full' : ''}`}
                  style={{ width: `${widthPercent}%` }}
                />
              </div>
            );
          })}
        </div>

        {/* Phase labels beneath bar */}
        <div class="flex justify-between text-[10px] text-gray-500 dark:text-gray-500 font-medium">
          {PHASE_SEGMENTS.map((seg) => (
            <span>{seg.label}</span>
          ))}
        </div>
      </div>

      {/* Frame counter + sub-phase detail row */}
      <div class="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400">
        <span class="italic">
          {showFrameCounter()
            ? `Frame ${local.currentFrame} / ${local.totalFrames}`
            : (local.subPhaseLabel ?? local.statusMessage)}
        </span>
        <div class="flex items-center gap-2">
          {showFrameCounter() && subPhaseValue() > 0 && (
            <span class="font-mono tabular-nums text-gray-500 dark:text-gray-500">
              {subPhaseValue()}%
            </span>
          )}
          {local.memoryUsage && (
            <span class="font-mono tabular-nums text-gray-400 dark:text-gray-600 text-[10px]">
              🧠 {local.memoryUsage}
            </span>
          )}
        </div>
      </div>

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
