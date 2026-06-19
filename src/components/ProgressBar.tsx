// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { ConversionPhase } from '@t/v2-conversion-types';
import { formatDuration } from '@utils/format-utils';
import { type Component, createEffect, createMemo, onCleanup, Show, splitProps } from 'solid-js';

const PHASE_SEGMENTS = [
  { label: 'Demux', colorClass: 'bg-amber-500 dark:bg-amber-400', phase: 'demuxing' },
  { label: 'Decode', colorClass: 'bg-purple-500 dark:bg-purple-400', phase: 'decoding' },
  { label: 'Encode', colorClass: 'bg-blue-500 dark:bg-blue-400', phase: 'encoding' },
  { label: 'Final', colorClass: 'bg-green-500 dark:bg-green-400', phase: 'assembling' },
] as const;

interface ProgressBarProps {
  progress: number;
  status: string;
  statusMessage?: string;
  showSpinner?: boolean;
  showElapsedTime?: boolean;
  startTime?: number;
  estimatedSecondsRemaining?: number | null;
  layout?: 'horizontal' | 'vertical';
  subPhaseProgress?: number;
  subPhaseLabel?: string;
  currentFrame?: number;
  totalFrames?: number;
  outputFrames?: number;
  memoryUsage?: string | null;
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
    'outputFrames',
    'memoryUsage',
    'phase',
  ]);
  let elapsedDisplayRef: HTMLSpanElement | undefined;

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

  const frameCounterLabel = createMemo(() => {
    if (!showFrameCounter()) return '';
    const out = local.outputFrames;
    if (out != null && out !== local.totalFrames) {
      return `Frame ${local.currentFrame} / ${local.totalFrames} (${out} output)`;
    }
    return `Frame ${local.currentFrame} / ${local.totalFrames}`;
  });

  createEffect(() => {
    if (!local.showElapsedTime || !local.startTime) return;

    const updateElapsed = () => {
      if (!elapsedDisplayRef) return;
      const now = performance.now();
      const secs = Math.floor(Math.max(0, now - local.startTime!) / 1000);
      elapsedDisplayRef.textContent = formatDuration(secs);
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);

    onCleanup(() => {
      clearInterval(interval);
    });
  });

  return (
    <div
      class="flex flex-col gap-1.5"
      role="status"
      aria-live="polite"
      aria-busy={progressValue() > 0 && progressValue() < 100}
    >
      {/* Header row: spinner + status + percent */}
      <div class={`flex items-center gap-1.5 text-xs font-medium text-gray-700 dark:text-gray-300`}>
        <Show when={local.showSpinner}>
          <svg
            class="animate-spin h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0"
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
        <span class="truncate">{local.status}</span>
        <span class="text-gray-500 dark:text-gray-400 font-mono text-[10px] tabular-nums ml-auto shrink-0">
          {progressValue()}%
        </span>
      </div>

      {/* Multi-phase segmented bar */}
      <div
        class="flex h-2.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800"
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

          let widthPercent: number;
          if (isPast) {
            widthPercent = 25;
          } else if (isActive) {
            const segmentStart = idx * 25;
            const segmentEnd = (idx + 1) * 25;
            const clampedProgress = Math.max(segmentStart, Math.min(segmentEnd, progressValue()));
            widthPercent = ((clampedProgress - segmentStart) / (segmentEnd - segmentStart)) * 25;
          } else {
            widthPercent = 0;
          }

          return (
            <div
              class={`h-full transition-[width] duration-150 ease-out ${
                widthPercent > 0 ? seg.colorClass : 'bg-transparent'
              } ${idx === 0 ? 'rounded-l-full' : ''} ${idx === PHASE_SEGMENTS.length - 1 ? 'rounded-r-full' : ''}`}
              style={{ width: `${widthPercent}%` }}
            />
          );
        })}
      </div>

      {/* Phase labels */}
      <div class="flex justify-between text-[10px] text-gray-500 dark:text-gray-500 font-medium px-px">
        {PHASE_SEGMENTS.map((seg, idx) => (
          <span class={idx < activePhaseIndex() ? 'text-gray-700 dark:text-gray-300' : ''}>
            {seg.label}
          </span>
        ))}
      </div>

      {/* Detail row: frame counter / sub-phase + memory */}
      <div class="flex items-center justify-between text-[10px] text-gray-500 dark:text-gray-400 min-h-[1.25rem]">
        <span class="truncate italic">
          {showFrameCounter()
            ? frameCounterLabel()
            : (local.subPhaseLabel ?? local.statusMessage ?? '')}
        </span>
        <div class="flex items-center gap-1.5 shrink-0">
          {showFrameCounter() && subPhaseValue() > 0 && (
            <span class="font-mono tabular-nums">{subPhaseValue()}%</span>
          )}
          {local.memoryUsage && local.memoryUsage !== '0 MB / 0 MB (0%)' && (
            <span class="font-mono tabular-nums text-gray-400 dark:text-gray-600">
              🧠 {local.memoryUsage}
            </span>
          )}
        </div>
      </div>

      {/* Elapsed / ETA row */}
      <Show when={local.showElapsedTime && local.startTime}>
        <div class="flex items-center justify-center gap-2 text-[10px] text-gray-500 dark:text-gray-400 font-mono tabular-nums">
          <span ref={elapsedDisplayRef}>⏱ 0:00</span>
          <Show
            when={local.estimatedSecondsRemaining != null && local.estimatedSecondsRemaining > 0}
          >
            <span class="text-gray-400 dark:text-gray-600">·</span>
            <span>ETA {formatDuration(local.estimatedSecondsRemaining!)}</span>
          </Show>
          <Show
            when={local.estimatedSecondsRemaining == null || local.estimatedSecondsRemaining <= 0}
          >
            <span class="text-gray-400 dark:text-gray-600">·</span>
            <span class="text-gray-400 dark:text-gray-500 italic">calculating…</span>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default ProgressBar;
