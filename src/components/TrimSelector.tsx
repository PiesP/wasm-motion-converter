// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import type { TFunction } from '@t/i18n-types';
import { formatNumber, formatPercent } from '@utils/intl-utils';
import type { Component } from 'solid-js';
import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js';

const TRIM_END_FULL_DURATION = 0;

const isFullDuration = (trimEnd: number): boolean => trimEnd === TRIM_END_FULL_DURATION;

interface TrimSelectorProps {
  duration: number;
  trimStart: number;
  trimEnd: number;
  estimatedFps?: number;
  disabled?: boolean;
  onChange: (start: number, end: number) => void;
}

const MIN_DURATION = 0.5;
const STEP = 0.1;

const formatTime = (seconds: number): string => {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${mins}:${String(secs).padStart(2, '0')}`;
};

const formatTimePrecise = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toFixed(1).padStart(4, '0')}`;
};

const parseTimeInput = (input: string): number | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const colonCount = (trimmed.match(/:/g) || []).length;
  if (colonCount >= 1) {
    const parts = trimmed.split(':');
    if (colonCount === 1 && parts.length === 2) {
      const m = parseFloat(parts[0]!);
      const s = parseFloat(parts[1]!);
      if (Number.isNaN(m) || Number.isNaN(s)) return null;
      return m * 60 + s;
    }
    if (colonCount === 2 && parts.length === 3) {
      const h = parseFloat(parts[0]!);
      const m = parseFloat(parts[1]!);
      const s = parseFloat(parts[2]!);
      if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s)) return null;
      return h * 3600 + m * 60 + s;
    }
    return null;
  }
  const num = parseFloat(trimmed);
  return Number.isNaN(num) ? null : num;
};

const clampToStep = (value: number): number => Number((Math.round(value / STEP) * STEP).toFixed(2));

export function formatTrimSummary(
  durationSeconds: number,
  totalDurationSeconds: number,
  frameCount: number,
  locale: string,
  t: TFunction
): string {
  const duration = formatNumber(durationSeconds, locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const percent = formatPercent(
    totalDurationSeconds > 0 ? (durationSeconds / totalDurationSeconds) * 100 : 0,
    locale
  );
  const frames = formatNumber(frameCount, locale);
  return t('trim.summary', { duration, percent, frames });
}

const TrimSelector: Component<TrimSelectorProps> = (props) => {
  const { t, locale } = useLocale();
  const fps = (): number => props.estimatedFps ?? 15;

  const effectiveEnd = createMemo(() => {
    if (isFullDuration(props.trimEnd) || props.trimEnd > props.duration) return props.duration;
    return props.trimEnd;
  });

  const trimDuration = createMemo(() => effectiveEnd() - props.trimStart);

  const startPct = createMemo(() =>
    props.duration <= 0 ? 0 : (props.trimStart / props.duration) * 100
  );
  const endPct = createMemo(() =>
    props.duration <= 0 ? 100 : (effectiveEnd() / props.duration) * 100
  );

  const isDefault = createMemo(() => props.trimStart === 0 && isFullDuration(props.trimEnd));
  const frameCount = createMemo(() => Math.round(trimDuration() * fps()));

  const [dragging, setDragging] = createSignal<'start' | 'end' | null>(null);
  let trackRef: HTMLDivElement | undefined;

  const startDrag = (e: PointerEvent, handle: 'start' | 'end') => {
    if (props.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(handle);
  };

  const clientXToSeconds = (clientX: number): number => {
    if (!trackRef) return 0;
    const rect = trackRef.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * props.duration;
  };

  const onPointerMove = (e: PointerEvent) => {
    const handle = dragging();
    if (!handle || !trackRef) return;
    let seconds = clampToStep(clientXToSeconds(e.clientX));
    if (handle === 'start') {
      const maxStart = Math.max(0, effectiveEnd() - 0.1);
      seconds = Math.max(0, Math.min(seconds, maxStart));
      if (seconds !== props.trimStart) props.onChange(seconds, props.trimEnd);
    } else {
      const minEnd = Math.min(props.duration, props.trimStart + 0.1);
      seconds = Math.max(minEnd, Math.min(seconds, props.duration));
      if (seconds !== effectiveEnd()) props.onChange(props.trimStart, seconds);
    }
  };

  const onPointerUp = () => setDragging(null);

  createEffect(() => {
    if (dragging()) {
      document.body.style.cursor = 'col-resize';
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      onCleanup(() => {
        document.body.style.cursor = '';
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
      });
    }
  });

  // Ensure document listeners are cleaned up if component unmounts mid-drag
  onCleanup(() => {
    document.body.style.cursor = '';
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
  });

  const handleTrackClick = (e: MouseEvent) => {
    if (props.disabled) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-handle]')) return;
    const seconds = clampToStep(clientXToSeconds(e.clientX));
    if (
      seconds <= props.trimStart ||
      (seconds < effectiveEnd() && seconds - props.trimStart < effectiveEnd() - seconds)
    ) {
      const clamped = Math.min(seconds, Math.max(0, effectiveEnd() - 0.1));
      if (clamped !== props.trimStart) props.onChange(clamped, props.trimEnd);
    } else {
      const clamped = Math.max(seconds, Math.min(props.duration, props.trimStart + 0.1));
      if (clamped !== effectiveEnd()) props.onChange(props.trimStart, clamped);
    }
  };

  const handleStartKeyDown = (e: KeyboardEvent) => {
    if (props.disabled) return;
    let newStart = props.trimStart;
    const shift = e.shiftKey ? 1 : 0.1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      newStart = Math.min(props.trimStart + shift, Math.max(0, effectiveEnd() - 0.1));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      newStart = Math.max(0, props.trimStart - shift);
    } else return;
    newStart = clampToStep(newStart);
    if (newStart !== props.trimStart) props.onChange(newStart, props.trimEnd);
  };

  const handleEndKeyDown = (e: KeyboardEvent) => {
    if (props.disabled) return;
    let newEnd = effectiveEnd();
    const shift = e.shiftKey ? 1 : 0.1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      newEnd = Math.min(props.duration, effectiveEnd() + shift);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      newEnd = Math.max(props.trimStart + 0.1, effectiveEnd() - shift);
    } else return;
    newEnd = clampToStep(newEnd);
    if (newEnd !== effectiveEnd()) props.onChange(props.trimStart, newEnd);
  };

  const handleReset = () => {
    if (!props.disabled) props.onChange(0, 0);
  };
  const handlePreset = (start: number, end: number) => {
    if (!props.disabled) props.onChange(start, end);
  };

  const presets = createMemo(() => {
    const d = props.duration;
    const list: Array<{ label: string; start: number; end: number }> = [
      { label: t('trim.full'), start: 0, end: TRIM_END_FULL_DURATION },
    ];
    if (d > 5) {
      list.push({ label: t('trim.first5s'), start: 0, end: Math.min(5, d) });
      list.push({
        label: t('trim.last5s'),
        start: Math.max(0, d - 5),
        end: TRIM_END_FULL_DURATION,
      });
    }
    if (d > 15) {
      list.push({ label: t('trim.first15s'), start: 0, end: Math.min(15, d) });
      list.push({
        label: t('trim.last15s'),
        start: Math.max(0, d - 15),
        end: TRIM_END_FULL_DURATION,
      });
    }
    if (d > 30) {
      list.push({ label: t('trim.first30s'), start: 0, end: Math.min(30, d) });
      list.push({
        label: t('trim.last30s'),
        start: Math.max(0, d - 30),
        end: TRIM_END_FULL_DURATION,
      });
    }
    if (d >= 2) {
      list.push({ label: t('trim.firstHalf'), start: 0, end: d / 2 });
      list.push({ label: t('trim.secondHalf'), start: d / 2, end: TRIM_END_FULL_DURATION });
    }
    return list;
  });

  const isPresetActive = (start: number, end: number): boolean =>
    props.trimStart === start && props.trimEnd === end;

  const presetBtnClass = (active: boolean): string =>
    `text-[10px] px-2 py-0.5 rounded border transition-colors font-medium cursor-pointer ${
      active
        ? 'bg-brand text-white border-brand shadow-sm'
        : 'border-border-standard hover:bg-white/[0.05] text-text-secondary'
    } ${props.disabled ? 'opacity-50 cursor-not-allowed' : ''}`;

  const [startFocused, setStartFocused] = createSignal(false);
  const [endFocused, setEndFocused] = createSignal(false);
  const [startText, setStartText] = createSignal(formatTimePrecise(props.trimStart));
  const [endText, setEndText] = createSignal(formatTimePrecise(effectiveEnd()));

  createEffect(() => {
    if (!startFocused()) setStartText(formatTimePrecise(props.trimStart));
  });
  createEffect(() => {
    if (!endFocused()) setEndText(formatTimePrecise(effectiveEnd()));
  });

  const commitStartText = () => {
    const parsed = parseTimeInput(startText());
    if (parsed !== null) {
      const clamped = Math.max(0, Math.min(parsed, effectiveEnd() - 0.1));
      props.onChange(clampToStep(clamped), props.trimEnd);
    }
    setStartText(formatTimePrecise(props.trimStart));
    setStartFocused(false);
  };

  const commitEndText = () => {
    const parsed = parseTimeInput(endText());
    if (parsed !== null) {
      const clamped = Math.max(props.trimStart + 0.1, Math.min(parsed, props.duration));
      // If clamped is at full duration, use sentinel 0 (L11 fix).
      if (clamped >= props.duration - STEP / 2) {
        props.onChange(props.trimStart, 0);
      } else {
        props.onChange(props.trimStart, clampToStep(clamped));
      }
    }
    setEndText(formatTimePrecise(effectiveEnd()));
    setEndFocused(false);
  };

  const handleStartTextKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitStartText();
    }
  };
  const handleEndTextKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEndText();
    }
  };

  const handleClass = (which: 'start' | 'end'): string => {
    const isDragging = dragging() === which;
    return [
      'absolute top-1/2 -translate-y-1/2 -translate-x-1/2 min-w-[44px] min-h-[44px]',
      'rounded-full bg-white/90 border-2',
      'border-brand shadow-md',
      'cursor-col-resize hover:scale-[1.1] hover:shadow-lg hover:border-brand',
      'transition-all duration-150 ease-out',
      'focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:ring-offset-2 focus-visible:outline-none',
      'after:absolute after:-bottom-2 after:left-1/2 after:-translate-x-1/2',
      'after:w-1 after:h-2 after:bg-brand/40 after:rounded-b-sm after:pointer-events-none',
      isDragging ? 'scale-115 shadow-xl ring-2 ring-brand/50 bg-brand/10 border-brand' : '',
      props.disabled ? 'cursor-not-allowed opacity-50' : '',
    ]
      .filter(Boolean)
      .join(' ');
  };

  const textClass =
    'text-[10px] border border-border-standard rounded px-1 py-0.5 bg-bg-elevated text-right font-mono w-[4.5rem] field-sizing-content';

  if (props.duration < MIN_DURATION) {
    return <p class="text-xs text-text-tertiary">{t('trim.tooShort')}</p>;
  }

  return (
    <div class="space-y-2" data-testid="trim-selector">
      {/* Header */}
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium text-text-secondary">{t('trim.range')}</span>
        {!isDefault() && (
          <button
            type="button"
            onClick={handleReset}
            disabled={props.disabled}
            data-testid="trim-reset-button"
            class={`text-[10px] px-2 py-0.5 rounded border transition-colors cursor-pointer ${
              props.disabled
                ? 'opacity-50 cursor-not-allowed border-border-standard'
                : 'border-border-standard hover:bg-white/[0.05]'
            }`}
          >
            {t('trim.reset')}
          </button>
        )}
      </div>

      {/* Range Bar */}
      {/* biome-ignore lint/a11y/useSemanticElements: The focusable range track is an ARIA group containing two slider controls; a fieldset would change native disabled and layout behavior. */}
      <div
        ref={trackRef}
        class={`relative h-8 rounded-lg bg-bg-elevated select-none touch-none cursor-pointer ${props.disabled ? 'opacity-50 pointer-events-none' : ''}`}
        onClick={handleTrackClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (props.trimStart !== 0 || props.trimEnd !== 0) props.onChange(0, 0);
          }
        }}
        tabIndex={props.disabled ? -1 : 0}
        role="group"
        aria-label={`${t('trim.range')}: ${formatTime(props.trimStart)} – ${formatTime(effectiveEnd())} of ${formatTime(props.duration)}`}
        aria-disabled={!!props.disabled}
      >
        <div
          class={`absolute top-0 h-full rounded-lg bg-brand/15 border-x-2 border-brand transition-[left,width] duration-100 ${dragging() !== null ? 'bg-brand/25' : ''}`}
          style={{ left: `${startPct()}%`, width: `${endPct() - startPct()}%` }}
        />
        <div
          data-handle="start"
          class={handleClass('start')}
          style={{ left: `${startPct()}%` }}
          onPointerDown={(e) => startDrag(e, 'start')}
          role="slider"
          tabIndex={props.disabled ? -1 : 0}
          aria-label={t('trim.start')}
          aria-valuemin={0}
          aria-valuemax={props.duration}
          aria-valuenow={props.trimStart}
          aria-valuetext={formatTime(props.trimStart)}
          aria-disabled={!!props.disabled}
          onKeyDown={handleStartKeyDown}
        >
          <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div class="flex flex-col gap-0.5">
              <div class="w-0.5 h-0.5 rounded-full bg-brand/60" />
              <div class="w-0.5 h-0.5 rounded-full bg-brand/60" />
              <div class="w-0.5 h-0.5 rounded-full bg-brand/60" />
            </div>
          </div>
        </div>
        <div
          data-handle="end"
          class={handleClass('end')}
          style={{ left: `${endPct()}%` }}
          onPointerDown={(e) => startDrag(e, 'end')}
          role="slider"
          tabIndex={props.disabled ? -1 : 0}
          aria-label={t('trim.end')}
          aria-valuemin={0}
          aria-valuemax={props.duration}
          aria-valuenow={effectiveEnd()}
          aria-valuetext={formatTime(effectiveEnd())}
          aria-disabled={!!props.disabled}
          onKeyDown={handleEndKeyDown}
        >
          <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div class="flex flex-col gap-0.5">
              <div class="w-0.5 h-0.5 rounded-full bg-brand/60" />
              <div class="w-0.5 h-0.5 rounded-full bg-brand/60" />
              <div class="w-0.5 h-0.5 rounded-full bg-brand/60" />
            </div>
          </div>
        </div>
        {dragging() && (
          <div
            class="absolute -top-7 -translate-x-1/2 px-1.5 py-0.5 rounded bg-bg-elevated text-text-primary text-[10px] font-medium pointer-events-none whitespace-nowrap shadow-lg z-10"
            style={{ left: `${dragging() === 'start' ? startPct() : endPct()}%` }}
          >
            {formatTime(dragging() === 'start' ? props.trimStart : effectiveEnd())}
          </div>
        )}
      </div>

      {/* Track boundary labels */}
      <div class="flex justify-between text-[10px] text-text-tertiary px-0.5">
        <span>{formatTime(0)}</span>
        <span>{formatTime(props.duration)}</span>
      </div>

      {/* Presets */}
      <div class="flex gap-1 flex-wrap">
        {presets().map((preset) => (
          <button
            type="button"
            onClick={() => handlePreset(preset.start, preset.end)}
            disabled={props.disabled}
            aria-current={isPresetActive(preset.start, preset.end) ? 'true' : undefined}
            class={presetBtnClass(isPresetActive(preset.start, preset.end))}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* Text inputs + summary */}
      <div class="flex items-center gap-1.5 justify-between flex-wrap">
        <div class="flex items-center gap-1.5">
          <label for="trim-start-input" class="text-[10px] text-text-tertiary">
            {t('trim.startLabel')}
          </label>
          <input
            id="trim-start-input"
            name="trim-start"
            type="text"
            value={startText()}
            disabled={props.disabled}
            autocomplete="off"
            onInput={(e) => setStartText((e.target as HTMLInputElement).value)}
            onFocus={() => setStartFocused(true)}
            onBlur={commitStartText}
            onKeyDown={handleStartTextKeyDown}
            class={textClass}
          />
          <span class="text-[10px] text-text-tertiary" aria-hidden="true">
            –
          </span>
          <label for="trim-end-input" class="text-[10px] text-text-tertiary">
            {t('trim.endLabel')}
          </label>
          <input
            id="trim-end-input"
            name="trim-end"
            type="text"
            value={endText()}
            disabled={props.disabled}
            autocomplete="off"
            onInput={(e) => setEndText((e.target as HTMLInputElement).value)}
            onFocus={() => setEndFocused(true)}
            onBlur={commitEndText}
            onKeyDown={handleEndTextKeyDown}
            class={textClass}
          />
        </div>
        <span class="text-[10px] text-text-tertiary whitespace-nowrap" data-testid="trim-summary">
          {formatTrimSummary(trimDuration(), props.duration, frameCount(), locale(), t)}
        </span>
      </div>
    </div>
  );
};

export default TrimSelector;
