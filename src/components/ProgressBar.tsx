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
    colorClass: 'bg-status-success',
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
const PHASE_STATUS_KEYS = {
  demuxing: 'progress.preparing',
  decoding: 'progress.decoding',
  encoding: 'progress.encoding',
  assembling: 'progress.finalizing',
} as const;

interface ProgressBarProps {
  progress: number | null;
  busy?: boolean | undefined;
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
    'busy',
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
    if (local.progress === null) return null;
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
    const widths = getProgressSegmentWidths(progressValue() ?? 0);
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
        ? 'text-status-success'
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

  const showDiagnostics = createMemo(
    () => local.phase !== undefined || showFrameCounter() || Boolean(local.memoryUsage)
  );

  // Compact layout used in the active dropzone.
  if (isCompact()) {
    return (
      <div class="flex flex-col gap-2" aria-busy={local.busy ?? true}>
        <div class="grid grid-cols-[minmax(0,1fr)_minmax(4rem,1fr)_4ch] items-center gap-2 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(5rem,1fr)_4ch]">
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
          <span class="min-w-0 font-medium text-text-primary">{local.status}</span>
          <div
            class="h-2 rounded-full bg-bg-elevated overflow-hidden"
            role="progressbar"
            aria-valuenow={progressValue() ?? undefined}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={local.status}
            data-progress={progressValue() ?? undefined}
          >
            <Show
              when={progressValue() !== null}
              fallback={
                <div class="h-full w-full rounded-full bg-brand/40 animate-pulse motion-reduce:animate-none" />
              }
            >
              <div
                class="h-full rounded-full bg-brand transition-[width] duration-150 ease-out motion-reduce:transition-none"
                style={{ width: `${progressValue()}%` }}
              />
            </Show>
          </div>
          <span class="font-mono text-sm tabular-nums text-text-secondary text-end">
            {progressValue() === null ? '' : `${progressValue()}%`}
          </span>
        </div>
        <p class="min-h-5 text-sm text-text-secondary" data-testid="progress-status-message">
          {local.statusMessage && local.statusMessage !== local.status
            ? local.phase
              ? t(PHASE_STATUS_KEYS[local.phase])
              : local.statusMessage
            : ''}
        </p>
        <div class="flex min-h-5 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm text-text-secondary font-mono tabular-nums">
          <Show when={local.showElapsedTime && local.startTime}>
            <span ref={elapsedDisplayRef} data-testid="elapsed-time">
              {t('progress.initialElapsed')}
            </span>
          </Show>
          <Show
            when={
              local.estimatedSecondsRemaining != null &&
              local.estimatedSecondsRemaining > 0 &&
              progressValue() !== null &&
              progressValue()! < 100
            }
          >
            <span>
              {t('progress.eta', {
                time: formatDurationSeconds(local.estimatedSecondsRemaining!, locale()),
              })}
            </span>
          </Show>
        </div>
        <Show when={showDiagnostics()}>
          <details class="text-sm text-text-secondary" data-testid="progress-diagnostics">
            <summary class="w-fit min-h-target-minimum cursor-pointer content-center rounded-button px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
              {t('progress.details')}
            </summary>
            <div class="space-y-2 border-t border-border-standard pt-2">
              <Show when={local.phase !== undefined}>
                <div class="flex flex-wrap gap-x-3 gap-y-1">{phaseMarkers()}</div>
              </Show>
              <Show
                when={local.phase && local.statusMessage && local.statusMessage !== local.status}
              >
                <div>{local.statusMessage}</div>
              </Show>
              <Show when={showFrameCounter()}>
                <div>
                  {frameCounterLabel()}
                  {subPhaseValue() > 0 ? ` · ${subPhaseValue()}%` : ''}
                </div>
              </Show>
              <Show when={local.memoryUsage && local.memoryUsage !== '0 MB / 0 MB (0%)'}>
                <div>🧠 {local.memoryUsage}</div>
              </Show>
            </div>
          </details>
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
    <div class="flex flex-col gap-1.5" aria-busy={local.busy ?? true}>
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
          {progressValue() === null ? '' : `${progressValue()}%`}
        </span>
      </div>

      {/* Multi-phase segmented bar */}
      <div
        class="flex h-2.5 w-full overflow-hidden rounded-full bg-white/[0.05]"
        role="progressbar"
        aria-valuenow={progressValue() ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={local.status}
        data-progress={progressValue() ?? undefined}
      >
        <Show
          when={progressValue() !== null}
          fallback={
            <div class="h-full w-full bg-brand/40 animate-pulse motion-reduce:animate-none" />
          }
        >
          {segmentDivs()}
        </Show>
      </div>

      {/* Phase labels with icons */}
      <Show when={local.phase !== undefined}>
        <div class="flex justify-between text-[10px] text-text-tertiary font-medium px-px">
          {PHASE_CONFIG.map((seg, idx) => {
            const isPast = idx < activePhaseIndex();
            const isActive = idx === activePhaseIndex();
            return (
              <span
                class={`inline-flex items-center gap-0.5 ${
                  isPast ? 'text-status-success' : isActive ? 'text-brand' : ''
                }`}
              >
                <span>{isPast ? '✓' : seg.icon}</span>
                <span>{t(seg.labelKey)}</span>
              </span>
            );
          })}
        </div>
      </Show>

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
