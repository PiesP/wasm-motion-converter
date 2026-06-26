// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import type { ProgressPhase } from '@t/conversion-types';
import { formatDuration } from '@utils/format-utils';
import { type Component, createEffect, createMemo, onCleanup, Show, splitProps } from 'solid-js';

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
    colorClass: 'bg-[#5e6ad2]',
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
  phase?: ProgressPhase;
  compact?: boolean;
  fps?: number;
  elapsedMs?: number;
}

const ProgressBar: Component<ProgressBarProps> = (props) => {
  const { t } = useLocale();
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

  const activePhaseIndex = createMemo(() => {
    const p = local.phase;
    if (p === 'assembling') return 3;
    if (p === 'encoding') return 2;
    if (p === 'decoding') return 1;
    return 0;
  });

  const isCompact = createMemo(() => local.compact === true);

  // Memoize segment rendering
  const segmentDivs = createMemo(() => {
    const activeIdx = activePhaseIndex();
    return PHASE_CONFIG.map((seg, idx) => {
      const isPast = idx < activeIdx;
      const isActive = idx === activeIdx;

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
          } ${idx === 0 ? 'rounded-l-full' : ''} ${idx === PHASE_CONFIG.length - 1 ? 'rounded-r-full' : ''} ${isActive && widthPercent > 0 && widthPercent < 25 ? 'animate-pulse' : ''}`}
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
          ? 'text-[#5e6ad2]'
          : 'text-[#8a8f98]';
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
      return `Frame ${local.currentFrame}/${local.totalFrames} (${out} out)`;
    }
    return `Frame ${local.currentFrame}/${local.totalFrames}`;
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

  // Compact layout: single inline row
  if (isCompact()) {
    return (
      <div
        class="flex flex-col gap-1.5"
        role="status"
        aria-live="polite"
        aria-busy={progressValue() > 0 && progressValue() < 100}
      >
        {/* Inline: status + bar + percent + ETA */}
        <div class="flex items-center gap-2 text-xs">
          <Show when={local.showSpinner}>
            <svg
              class="animate-spin h-3.5 w-3.5 text-[#5e6ad2] shrink-0"
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
          <span class="truncate font-medium text-[#d0d6e0]">{local.status}</span>
          <div class="flex-1 h-1.5 rounded-full bg-white/[0.05] overflow-hidden">
            <div
              class="h-full rounded-full bg-[#5e6ad2] transition-[width] duration-150 ease-out"
              style={{ width: `${progressValue()}%` }}
            />
          </div>
          <span class="font-mono text-[10px] tabular-nums text-[#8a8f98] shrink-0">
            {progressValue()}%
          </span>
          <Show
            when={local.estimatedSecondsRemaining != null && local.estimatedSecondsRemaining > 0}
          >
            <span class="font-mono text-[10px] tabular-nums text-[#5e6ad2]/60 shrink-0">
              ETA {formatDuration(local.estimatedSecondsRemaining!)}
            </span>
          </Show>
        </div>

        {/* Phase markers: ✓ Demux · ✓ Decode · ● Encode · ○ Final */}
        <div class="flex items-center justify-between text-[10px] text-[#8a8f98] px-px">
          {phaseMarkers().map((marker, idx) => (
            <span class={idx < activePhaseIndex() ? 'text-[#d0d6e0]' : ''}>{marker}</span>
          ))}
        </div>

        {/* Detail row: frame counter + memory */}
        <div class="flex items-center justify-between text-[10px] text-[#8a8f98] min-h-[1rem]">
          <span class="truncate italic">
            {showFrameCounter()
              ? frameCounterLabel()
              : (local.subPhaseLabel ?? local.statusMessage ?? '')}
          </span>
          <div class="flex items-center gap-1.5 shrink-0">
            {showFrameCounter() && subPhaseValue() > 0 && (
              <span class="font-mono tabular-nums text-[#d0d6e0]">{subPhaseValue()}%</span>
            )}
            {local.memoryUsage && local.memoryUsage !== '0 MB / 0 MB (0%)' && (
              <span class="font-mono tabular-nums text-[#5e6ad2]/50">🧠 {local.memoryUsage}</span>
            )}
          </div>
        </div>

        {/* Elapsed time */}
        <Show when={local.showElapsedTime && local.startTime}>
          <div class="text-center text-[10px] text-[#8a8f98] font-mono tabular-nums">
            <span ref={elapsedDisplayRef}>⏱ 0:00</span>
          </div>
        </Show>
      </div>
    );
  }

  // Full layout (original, with phase icon improvements)
  return (
    <div
      class="flex flex-col gap-1.5"
      role="status"
      aria-live="polite"
      aria-busy={progressValue() > 0 && progressValue() < 100}
    >
      {/* Header row: spinner + status + percent */}
      <div class="flex items-center gap-1.5 text-xs font-medium text-[#d0d6e0]">
        <Show when={local.showSpinner}>
          <svg
            class="animate-spin h-4 w-4 text-[#5e6ad2] shrink-0"
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
        <span class="text-[#8a8f98] font-mono text-[10px] tabular-nums ml-auto shrink-0">
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
      <div class="flex justify-between text-[10px] text-[#8a8f98] font-medium px-px">
        {PHASE_CONFIG.map((seg, idx) => {
          const isPast = idx < activePhaseIndex();
          const isActive = idx === activePhaseIndex();
          return (
            <span
              class={`inline-flex items-center gap-0.5 ${
                isPast ? 'text-green-400' : isActive ? 'text-[#5e6ad2]' : ''
              }`}
            >
              <span>{isPast ? '✓' : seg.icon}</span>
              <span>{t(seg.labelKey)}</span>
            </span>
          );
        })}
      </div>

      {/* Detail row: frame counter / sub-phase + memory */}
      <div class="flex items-center justify-between text-[10px] text-[#8a8f98] min-h-[1.25rem]">
        <span class="truncate italic">
          {showFrameCounter()
            ? frameCounterLabel()
            : (local.subPhaseLabel ?? local.statusMessage ?? '')}
        </span>
        <div class="flex items-center gap-1.5 shrink-0">
          {showFrameCounter() && subPhaseValue() > 0 && (
            <span class="font-mono tabular-nums text-[#d0d6e0]">{subPhaseValue()}%</span>
          )}
          {local.memoryUsage && local.memoryUsage !== '0 MB / 0 MB (0%)' && (
            <span class="font-mono tabular-nums text-[#5e6ad2]/50">🧠 {local.memoryUsage}</span>
          )}
        </div>
      </div>

      {/* Elapsed / ETA row */}
      <Show when={local.showElapsedTime && local.startTime}>
        <div class="flex items-center justify-center gap-2 text-[10px] text-[#8a8f98] font-mono tabular-nums">
          <span ref={elapsedDisplayRef}>⏱ 0:00</span>
          <Show
            when={local.estimatedSecondsRemaining != null && local.estimatedSecondsRemaining > 0}
          >
            <span class="text-[#5e6ad2]/40">·</span>
            <span class="text-[#5e6ad2]/60">
              ETA {formatDuration(local.estimatedSecondsRemaining!)}
            </span>
          </Show>
          <Show
            when={local.estimatedSecondsRemaining == null || local.estimatedSecondsRemaining <= 0}
          >
            <span class="text-[#5e6ad2]/40">·</span>
            <span class="text-[#5e6ad2]/40 italic">calculating…</span>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default ProgressBar;
