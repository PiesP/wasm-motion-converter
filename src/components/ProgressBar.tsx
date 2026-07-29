// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import type { ProgressPhase } from '@t/conversion-types';
import { PROGRESS_PHASE } from '@utils/constants';
import { formatDurationSeconds } from '@utils/format-utils';
import type { Component } from 'solid-js';
import { createEffect, createMemo, onCleanup, Show, splitProps } from 'solid-js';

const PHASE_CONFIG = [
  {
    labelKey: 'progress.demux',
    icon: '📂',
    doneIcon: '✓',
    colorClass: 'bg-amber-400',
    phase: 'demuxing' as ProgressPhase,
  },
  {
    labelKey: 'progress.decode',
    icon: '🔓',
    doneIcon: '✓',
    colorClass: 'bg-purple-400',
    phase: 'decoding' as ProgressPhase,
  },
  {
    labelKey: 'progress.encode',
    icon: '⚙️',
    doneIcon: '✓',
    colorClass: 'bg-brand',
    phase: 'encoding' as ProgressPhase,
  },
  {
    labelKey: 'progress.final',
    icon: '📦',
    doneIcon: '✓',
    colorClass: 'bg-green-400',
    phase: 'assembling' as ProgressPhase,
  },
] as const;

const PROGRESS_PHASE_BOUNDARIES = [
  0,
  PROGRESS_PHASE.DEMUX_MAX,
  PROGRESS_PHASE.DECODE_MAX,
  PROGRESS_PHASE.ENCODE_MAX,
  100,
] as const;

export function getActivePhaseIndex(phase?: ProgressPhase): number {
  if (phase === 'assembling') return 3;
  if (phase === 'encoding') return 2;
  if (phase === 'decoding') return 1;
  return 0;
}

export function getProgressSegmentWidths(progress: number): readonly number[] {
  const normalizedProgress = Number.isFinite(progress)
    ? Math.min(100, Math.max(0, Math.round(progress)))
    : 0;

  return PROGRESS_PHASE_BOUNDARIES.slice(0, -1).map((start, index) => {
    const end = PROGRESS_PHASE_BOUNDARIES[index + 1]!;
    return Math.max(0, Math.min(normalizedProgress, end) - start);
  });
}

const PROGRESS_SEGMENT_CAPACITIES = getProgressSegmentWidths(100);

interface ProgressBarProps {
  progress: number;
  status: string;
  statusMessage?: string | undefined;
  showSpinner?: boolean | undefined;
  showElapsedTime?: boolean | undefined;
  startTime?: number | undefined;
  estimatedSecondsRemaining?: (number | null) | undefined;
  layout?: ('horizontal' | 'vertical') | undefined;
  subPhaseProgress?: number | undefined;
  subPhaseLabel?: string | undefined;
  currentFrame?: number | undefined;
  totalFrames?: number | undefined;
  outputFrames?: number | undefined;
  memoryUsage?: (string | null) | undefined;
  phase?: ProgressPhase | undefined;
  compact?: boolean | undefined;
  fps?: number | undefined;
  elapsedMs?: number | undefined;
}

const ProgressBar: Component<ProgressBarProps> = (props) => {
  const { t, locale } = useLocale();
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
    'compact',
    'fps',
    'elapsedMs',
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

  const activePhaseIndex = createMemo(() => getActivePhaseIndex(local.phase));

  const isCompact = createMemo(() => local.compact === true);

  // Memoize segment rendering
  const segmentDivs = createMemo(() => {
    const activeIdx = activePhaseIndex();
    const widths = getProgressSegmentWidths(progressValue());
    return PHASE_CONFIG.map((seg, idx) => {
      const isActive = idx === activeIdx;
      const widthPercent = widths[idx]!;

      return (
        <div
          class={`h-full transition-[width] duration-150 ease-out ${
            widthPercent > 0 ? seg.colorClass : 'bg-transparent'
          } ${idx === 0 ? 'rounded-l-full' : ''} ${idx === PHASE_CONFIG.length - 1 ? 'rounded-r-full' : ''} ${isActive && widthPercent > 0 && widthPercent < PROGRESS_SEGMENT_CAPACITIES[idx]! ? 'animate-pulse' : ''}`}
          style={{ width: `${widthPercent}%` }}
        />
      );
    });
  });

  // Compact phase markers: ✓ Demux · ✓ Decode · ● Encode · ○ Final
  const phaseMarkers = createMemo(() => {
    const activeIdx = activePhaseIndex();
    return PHASE_CONFIG.map((seg, idx) => {
      const isPast = idx < activeIdx;
      const isActive = idx === activeIdx;
      const marker = isPast ? '✓' : isActive ? '●' : '○';
      const markerClass = isPast
        ? 'text-green-400'
        : isActive
          ? 'text-brand'
          : 'text-text-tertiary';
      return (
        <span class={`inline-flex items-center gap-0.5 ${markerClass}`}>
          <span class="text-[10px]">{marker}</span>
          <span>{t(seg.labelKey)}</span>
        </span>
      );
    });
  });

  const showFrameCounter = createMemo(
    () => local.currentFrame != null && local.totalFrames != null && local.totalFrames > 0
  );

  const frameCounterLabel = createMemo(() => {
    if (!showFrameCounter()) return '';
    const out = local.outputFrames;
    if (out != null && out !== local.totalFrames) {
      return t('progress.frameCounterOutput', {
        current: local.currentFrame!,
        total: local.totalFrames!,
        output: out,
      });
    }
    return t('progress.frameCounter', {
      current: local.currentFrame!,
      total: local.totalFrames!,
    });
  });

  createEffect(() => {
    if (!local.showElapsedTime || !local.startTime) return;

    const updateElapsed = () => {
      if (!elapsedDisplayRef) return;
      const now = performance.now();
      const secs = Math.floor(Math.max(0, now - local.startTime!) / 1000);
      elapsedDisplayRef.textContent = formatDurationSeconds(secs, locale());
    };

    const interval = setInterval(updateElapsed, 1000);
    onCleanup(() => {
      clearInterval(interval);
    });
    updateElapsed();
  });

  // Compact layout: single inline row
  if (isCompact()) {
    return (
      <div
        class="flex flex-col gap-1.5"
        aria-busy={progressValue() > 0 && progressValue() < 100}
      >
        {/* Inline: status + bar + percent + ETA */}
        <div class="flex items-center gap-2 text-xs">
          <Show when={local.showSpinner}>
            <svg
              class="animate-spin h-3.5 w-3.5 text-brand shrink-0"
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
          <span class="truncate font-medium text-text-secondary">{local.status}</span>
          <div
            class="flex-1 h-1.5 rounded-full bg-white/[0.05] overflow-hidden"
            role="progressbar"
            aria-valuenow={progressValue()}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={local.status}
            data-progress={progressValue()}
          >
            <div
              class="h-full rounded-full bg-brand transition-[width] duration-150 ease-out"
              style={{ width: `${progressValue()}%` }}
            />
          </div>
          <span class="font-mono text-[10px] tabular-nums text-text-tertiary shrink-0">
            {progressValue()}%
          </span>
          <Show
            when={local.estimatedSecondsRemaining != null && local.estimatedSecondsRemaining > 0}
          >
            <span class="font-mono text-[10px] tabular-nums text-brand/60 shrink-0">
              {t('progress.eta', {
                time: formatDurationSeconds(local.estimatedSecondsRemaining!, locale()),
              })}
            </span>
          </Show>
        </div>

        {/* Phase markers: ✓ Demux · ✓ Decode · ● Encode · ○ Final */}
        <div class="flex items-center justify-between text-[10px] text-text-tertiary px-px">
          {phaseMarkers().map((marker, idx) => (
            <span class={idx < activePhaseIndex() ? 'text-text-secondary' : ''}>{marker}</span>
          ))}
        </div>

        {/* Detail row: frame counter + memory */}
        <div class="flex items-center justify-between text-[10px] text-text-tertiary min-h-[1rem]">
          <span class="truncate italic">
            {showFrameCounter()
              ? frameCounterLabel()
              : (local.subPhaseLabel ?? local.statusMessage ?? '')}
          </span>
          <div class="flex items-center gap-1.5 shrink-0">
            {showFrameCounter() && subPhaseValue() > 0 && (
              <span class="font-mono tabular-nums text-text-secondary">{subPhaseValue()}%</span>
            )}
            {local.memoryUsage && local.memoryUsage !== '0 MB / 0 MB (0%)' && (
              <span class="font-mono tabular-nums text-brand/70">🧠 {local.memoryUsage}</span>
            )}
          </div>
        </div>

        {/* Elapsed time */}
        <Show when={local.showElapsedTime && local.startTime}>
          <div class="text-center text-[10px] text-text-tertiary font-mono tabular-nums">
            <span ref={elapsedDisplayRef} data-testid="elapsed-time">
              {t('progress.initialElapsed')}
            </span>
          </div>
        </Show>
      </div>
    );
  }

  // Full layout (original, with phase icon improvements)
  // NOTE: aria-live is intentionally NOT set here — App.tsx maintains a
  // single global live region that announces state transitions. Duplicating
  // aria-live on ProgressBar would cause screen readers to announce
  // per-frame progress updates redundantly.
  return (
    <div class="flex flex-col gap-1.5" aria-busy={progressValue() > 0 && progressValue() < 100}>
      {/* Header row: spinner + status + percent */}
      <div class="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
        <Show when={local.showSpinner}>
          <svg
            class="animate-spin h-4 w-4 text-brand shrink-0"
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
        <span class="text-text-tertiary font-mono text-[10px] tabular-nums ml-auto shrink-0">
          {progressValue()}%
        </span>
      </div>

      {/* Multi-phase segmented bar */}
      <div
        class="flex h-2.5 w-full overflow-hidden rounded-full bg-white/[0.05]"
        role="progressbar"
        aria-valuenow={progressValue()}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={local.status}
        data-progress={progressValue()}
      >
        {segmentDivs()}
      </div>

      {/* Phase labels with icons */}
      <div class="flex justify-between text-[10px] text-text-tertiary font-medium px-px">
        {PHASE_CONFIG.map((seg, idx) => {
          const isPast = idx < activePhaseIndex();
          const isActive = idx === activePhaseIndex();
          return (
            <span
              class={`inline-flex items-center gap-0.5 ${
                isPast ? 'text-green-400' : isActive ? 'text-brand' : ''
              }`}
            >
              <span>{isPast ? '✓' : seg.icon}</span>
              <span>{t(seg.labelKey)}</span>
            </span>
          );
        })}
      </div>

      {/* Detail row: frame counter / sub-phase + memory */}
      <div class="flex items-center justify-between text-[10px] text-text-tertiary min-h-[1.25rem]">
        <span class="truncate italic">
          {showFrameCounter()
            ? frameCounterLabel()
            : (local.subPhaseLabel ?? local.statusMessage ?? '')}
        </span>
        <div class="flex items-center gap-1.5 shrink-0">
          {showFrameCounter() && subPhaseValue() > 0 && (
            <span class="font-mono tabular-nums text-text-secondary">{subPhaseValue()}%</span>
          )}
          {local.memoryUsage && local.memoryUsage !== '0 MB / 0 MB (0%)' && (
            <span class="font-mono tabular-nums text-brand/70">🧠 {local.memoryUsage}</span>
          )}
        </div>
      </div>

      {/* Elapsed / ETA row */}
      <Show when={local.showElapsedTime && local.startTime}>
        <div class="flex items-center justify-center gap-2 text-[10px] text-text-tertiary font-mono tabular-nums">
          <span ref={elapsedDisplayRef} data-testid="elapsed-time">
            {t('progress.initialElapsed')}
          </span>
          <Show
            when={local.estimatedSecondsRemaining != null && local.estimatedSecondsRemaining > 0}
          >
            <span class="text-brand/60">·</span>
            <span class="text-brand/60">
              {t('progress.eta', {
                time: formatDurationSeconds(local.estimatedSecondsRemaining!, locale()),
              })}
            </span>
          </Show>
          <Show
            when={local.estimatedSecondsRemaining == null || local.estimatedSecondsRemaining <= 0}
          >
            <span class="text-brand/60">·</span>
            <span class="text-brand/60 italic">{t('progress.calculating')}</span>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default ProgressBar;
