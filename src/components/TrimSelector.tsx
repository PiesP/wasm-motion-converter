// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import type { TFunction } from '@t/i18n-types';
import { formatNumber, formatPercent } from '@utils/intl-utils';
import type { Component } from 'solid-js';
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';

const TRIM_END_FULL_DURATION = 0;
const MIN_DURATION = 0.5;
const STEP = 0.1;
const LARGE_STEP = 1;
const TIMELINE_DIVISIONS = Array.from({ length: 8 }, (_, index) => index);

const isFullDuration = (trimEnd: number): boolean => trimEnd === TRIM_END_FULL_DURATION;

interface TrimSelectorProps {
  duration: number;
  trimStart: number;
  trimEnd: number;
  estimatedFps?: number | undefined;
  disabled?: boolean | undefined;
  isPreviewing?: boolean | undefined;
  onChange: (start: number, end: number) => void;
  onPreviewSelection?: (() => void) | undefined;
  onSeek?: ((seconds: number) => void) | undefined;
}

interface TrimPreset {
  id: string;
  label: string;
  start: number;
  end: number;
}

const formatTimePrecise = (seconds: number): string => {
  const safeSeconds = Math.max(0, seconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;
  const secondsText = remainingSeconds.toFixed(1).padStart(4, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${secondsText}`;
  }
  return `${minutes}:${secondsText}`;
};

const parseTimeInput = (input: string): number | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const colonCount = (trimmed.match(/:/g) || []).length;
  if (colonCount >= 1) {
    const parts = trimmed.split(':');
    if (colonCount === 1 && parts.length === 2) {
      const minutes = Number.parseFloat(parts[0]!);
      const seconds = Number.parseFloat(parts[1]!);
      if (Number.isNaN(minutes) || Number.isNaN(seconds)) return null;
      return minutes * 60 + seconds;
    }
    if (colonCount === 2 && parts.length === 3) {
      const hours = Number.parseFloat(parts[0]!);
      const minutes = Number.parseFloat(parts[1]!);
      const seconds = Number.parseFloat(parts[2]!);
      if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds)) return null;
      return hours * 3600 + minutes * 60 + seconds;
    }
    return null;
  }
  const value = Number.parseFloat(trimmed);
  return Number.isNaN(value) ? null : value;
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
  const maxStart = createMemo(() => Math.max(0, effectiveEnd() - STEP));
  const minEnd = createMemo(() => Math.min(props.duration, props.trimStart + STEP));

  const [dragging, setDragging] = createSignal<'start' | 'end' | null>(null);
  const [startFocused, setStartFocused] = createSignal(false);
  const [endFocused, setEndFocused] = createSignal(false);
  const [startText, setStartText] = createSignal(formatTimePrecise(props.trimStart));
  const [endText, setEndText] = createSignal(formatTimePrecise(effectiveEnd()));
  const [startError, setStartError] = createSignal<string | null>(null);
  const [endError, setEndError] = createSignal<string | null>(null);
  const [seekPosition, setSeekPosition] = createSignal(props.trimStart);
  const seekPct = createMemo(() =>
    props.duration <= 0 ? 0 : (seekPosition() / props.duration) * 100
  );
  let trackRef: HTMLFieldSetElement | undefined;

  createEffect(() => {
    if (!startFocused() && !startError()) setStartText(formatTimePrecise(props.trimStart));
  });
  createEffect(() => {
    if (!endFocused() && !endError()) setEndText(formatTimePrecise(effectiveEnd()));
  });

  const normalizeEnd = (seconds: number): number =>
    seconds >= props.duration - STEP / 2 ? TRIM_END_FULL_DURATION : clampToStep(seconds);

  const seekPreview = (seconds: number): void => {
    const value = clampToStep(Math.max(0, Math.min(seconds, props.duration)));
    setSeekPosition(value);
    props.onSeek?.(value);
  };

  const updateStart = (seconds: number): number => {
    const value = clampToStep(Math.max(0, Math.min(seconds, maxStart())));
    if (value !== props.trimStart) props.onChange(value, props.trimEnd);
    seekPreview(value);
    return value;
  };

  const updateEnd = (seconds: number): number => {
    const value = clampToStep(Math.max(minEnd(), Math.min(seconds, props.duration)));
    const normalized = normalizeEnd(value);
    if (value !== effectiveEnd()) props.onChange(props.trimStart, normalized);
    seekPreview(value);
    return value;
  };

  const clientXToSeconds = (clientX: number): number => {
    if (!trackRef) return 0;
    const rect = trackRef.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return clampToStep(ratio * props.duration);
  };

  const startDrag = (event: PointerEvent, handle: 'start' | 'end') => {
    if (props.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setDragging(handle);
  };

  const onPointerMove = (event: PointerEvent) => {
    const handle = dragging();
    if (!handle || !trackRef) return;
    const seconds = clientXToSeconds(event.clientX);
    if (handle === 'start') updateStart(seconds);
    else updateEnd(seconds);
  };

  const stopDragging = () => setDragging(null);

  createEffect(() => {
    if (!dragging()) return;
    document.body.style.cursor = 'ew-resize';
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', stopDragging);
    document.addEventListener('pointercancel', stopDragging);
    onCleanup(() => {
      document.body.style.cursor = '';
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', stopDragging);
      document.removeEventListener('pointercancel', stopDragging);
    });
  });

  onCleanup(() => {
    document.body.style.cursor = '';
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', stopDragging);
    document.removeEventListener('pointercancel', stopDragging);
  });

  const handleStartKeyDown = (event: KeyboardEvent) => {
    if (props.disabled) return;
    let nextValue = props.trimStart;
    const increment = event.shiftKey ? LARGE_STEP : STEP;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        nextValue += increment;
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        nextValue -= increment;
        break;
      case 'PageUp':
        nextValue += LARGE_STEP;
        break;
      case 'PageDown':
        nextValue -= LARGE_STEP;
        break;
      case 'Home':
        nextValue = 0;
        break;
      case 'End':
        nextValue = maxStart();
        break;
      default:
        return;
    }
    event.preventDefault();
    updateStart(nextValue);
  };

  const handleEndKeyDown = (event: KeyboardEvent) => {
    if (props.disabled) return;
    let nextValue = effectiveEnd();
    const increment = event.shiftKey ? LARGE_STEP : STEP;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        nextValue += increment;
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        nextValue -= increment;
        break;
      case 'PageUp':
        nextValue += LARGE_STEP;
        break;
      case 'PageDown':
        nextValue -= LARGE_STEP;
        break;
      case 'Home':
        nextValue = minEnd();
        break;
      case 'End':
        nextValue = props.duration;
        break;
      default:
        return;
    }
    event.preventDefault();
    updateEnd(nextValue);
  };

  const handleReset = () => {
    if (props.disabled) return;
    props.onChange(0, TRIM_END_FULL_DURATION);
    seekPreview(0);
    setStartError(null);
    setEndError(null);
  };

  const primaryPresets = createMemo<TrimPreset[]>(() => {
    const duration = props.duration;
    const presets: TrimPreset[] = [
      { id: 'full', label: t('trim.full'), start: 0, end: TRIM_END_FULL_DURATION },
    ];
    if (duration > 5) {
      presets.push({ id: 'first-5', label: t('trim.first5s'), start: 0, end: 5 });
      presets.push({
        id: 'last-5',
        label: t('trim.last5s'),
        start: clampToStep(Math.max(0, duration - 5)),
        end: TRIM_END_FULL_DURATION,
      });
    }
    return presets;
  });

  const additionalPresets = createMemo<TrimPreset[]>(() => {
    const duration = props.duration;
    const presets: TrimPreset[] = [];
    if (duration > 15) {
      presets.push({ id: 'first-15', label: t('trim.first15s'), start: 0, end: 15 });
      presets.push({
        id: 'last-15',
        label: t('trim.last15s'),
        start: clampToStep(Math.max(0, duration - 15)),
        end: TRIM_END_FULL_DURATION,
      });
    }
    if (duration > 30) {
      presets.push({ id: 'first-30', label: t('trim.first30s'), start: 0, end: 30 });
      presets.push({
        id: 'last-30',
        label: t('trim.last30s'),
        start: clampToStep(Math.max(0, duration - 30)),
        end: TRIM_END_FULL_DURATION,
      });
    }
    if (duration >= 2) {
      const half = clampToStep(duration / 2);
      presets.push({ id: 'first-half', label: t('trim.firstHalf'), start: 0, end: half });
      presets.push({
        id: 'second-half',
        label: t('trim.secondHalf'),
        start: half,
        end: TRIM_END_FULL_DURATION,
      });
    }
    return presets;
  });

  const isPresetActive = (preset: TrimPreset): boolean =>
    Math.abs(props.trimStart - preset.start) < STEP / 2 &&
    (preset.end === TRIM_END_FULL_DURATION
      ? isFullDuration(props.trimEnd)
      : Math.abs(effectiveEnd() - preset.end) < STEP / 2);

  const activeAdditionalPreset = createMemo(
    () => additionalPresets().find((preset) => isPresetActive(preset))?.id ?? ''
  );

  const applyPreset = (preset: TrimPreset) => {
    if (props.disabled) return;
    props.onChange(clampToStep(preset.start), preset.end === 0 ? 0 : clampToStep(preset.end));
    seekPreview(preset.start);
    setStartError(null);
    setEndError(null);
  };

  const commitStartText = () => {
    const parsed = parseTimeInput(startText());
    if (parsed === null || parsed < 0 || parsed >= effectiveEnd()) {
      setStartError(t('trim.invalidStart', { end: formatTimePrecise(effectiveEnd()) }));
      setStartFocused(false);
      return;
    }
    setStartError(null);
    const value = updateStart(parsed);
    setStartText(formatTimePrecise(value));
    setStartFocused(false);
  };

  const commitEndText = () => {
    const parsed = parseTimeInput(endText());
    if (parsed === null || parsed <= props.trimStart || parsed > props.duration) {
      setEndError(
        t('trim.invalidEnd', {
          start: formatTimePrecise(props.trimStart),
          duration: formatTimePrecise(props.duration),
        })
      );
      setEndFocused(false);
      return;
    }
    setEndError(null);
    const value = updateEnd(parsed);
    setEndText(formatTimePrecise(value));
    setEndFocused(false);
  };

  const handleStartTextKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitStartText();
    } else if (event.key === 'Escape') {
      setStartText(formatTimePrecise(props.trimStart));
      setStartError(null);
      (event.currentTarget as HTMLInputElement).blur();
    }
  };

  const handleEndTextKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitEndText();
    } else if (event.key === 'Escape') {
      setEndText(formatTimePrecise(effectiveEnd()));
      setEndError(null);
      (event.currentTarget as HTMLInputElement).blur();
    }
  };

  const controlClass =
    'min-h-11 sm:min-h-9 rounded-md border border-border-control bg-bg-elevated px-3 text-xs font-medium text-text-secondary transition-colors hover:border-brand hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none';
  const inputClass =
    'mt-1 min-h-11 w-full rounded-md border border-border-control bg-bg-elevated px-3 text-right font-mono text-sm tabular-nums text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 disabled:cursor-not-allowed disabled:opacity-50';
  const handleClass = (which: 'start' | 'end'): string =>
    [
      'absolute top-1/2 z-20 h-14 w-11 -translate-x-1/2 -translate-y-1/2 touch-none cursor-ew-resize rounded-md',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg-panel',
      'disabled:cursor-not-allowed disabled:opacity-50',
      dragging() === which ? 'scale-105' : '',
    ]
      .filter(Boolean)
      .join(' ');

  if (props.duration < MIN_DURATION) {
    return <p class="text-sm text-text-tertiary">{t('trim.tooShort')}</p>;
  }

  return (
    <section class="space-y-4" data-testid="trim-selector" aria-labelledby="trim-heading">
      <div class="flex min-h-11 items-center justify-between gap-3 sm:min-h-9">
        <h3 id="trim-heading" class="text-sm font-semibold text-text-primary">
          {t('trim.range')}
        </h3>
        <Show when={!isDefault()}>
          <button
            type="button"
            onClick={handleReset}
            disabled={props.disabled}
            data-testid="trim-reset-button"
            class={controlClass}
          >
            {t('trim.reset')}
          </button>
        </Show>
      </div>

      <div class="px-8" dir="ltr">
        <div class="mb-1.5 flex justify-between text-[11px] tabular-nums text-text-tertiary">
          <span>{formatTimePrecise(0)}</span>
          <span>{formatTimePrecise(props.duration)}</span>
        </div>
        <fieldset
          ref={trackRef}
          class={`relative m-0 h-14 min-w-0 select-none overflow-visible rounded-lg border border-border-control bg-bg-elevated p-0 ${props.disabled ? 'pointer-events-none opacity-50' : ''}`}
          aria-describedby="trim-summary"
          data-testid="trim-timeline"
          disabled={props.disabled}
        >
          <legend class="sr-only">{t('trim.range')}</legend>
          <div
            class="pointer-events-none absolute inset-0 grid grid-cols-8 overflow-hidden rounded-lg"
            aria-hidden="true"
          >
            <For each={TIMELINE_DIVISIONS}>
              {() => <span class="border-r border-border-standard last:border-r-0" />}
            </For>
          </div>
          <div
            class="pointer-events-none absolute inset-y-0 left-0 rounded-l-lg bg-black/20"
            style={{ width: `${startPct()}%` }}
            aria-hidden="true"
          />
          <div
            class="pointer-events-none absolute inset-y-0 rounded-lg border-y-2 border-brand bg-brand/15 transition-[left,width] duration-100 motion-reduce:transition-none"
            style={{ left: `${startPct()}%`, width: `${endPct() - startPct()}%` }}
            aria-hidden="true"
          />
          <div
            class="pointer-events-none absolute inset-y-0 right-0 rounded-r-lg bg-black/20"
            style={{ width: `${100 - endPct()}%` }}
            aria-hidden="true"
          />
          <div
            class="pointer-events-none absolute inset-y-0 z-10 w-0.5 -translate-x-1/2 bg-text-primary/70 shadow-sm"
            style={{ left: `${seekPct()}%` }}
            aria-hidden="true"
          />
          <input
            type="range"
            min={0}
            max={props.duration}
            step={STEP}
            value={seekPosition()}
            disabled={props.disabled}
            aria-label={t('trim.timeline')}
            class="absolute inset-0 z-10 h-full w-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
            onInput={(event) => seekPreview(Number(event.currentTarget.value))}
          />

          <button
            type="button"
            data-handle="start"
            data-testid="trim-start-handle"
            class={handleClass('start')}
            style={{ left: `${startPct()}%` }}
            onPointerDown={(event) => startDrag(event, 'start')}
            role="slider"
            aria-label={t('trim.start')}
            aria-valuemin={0}
            aria-valuemax={maxStart()}
            aria-valuenow={props.trimStart}
            aria-valuetext={formatTimePrecise(props.trimStart)}
            disabled={props.disabled}
            onKeyDown={handleStartKeyDown}
          >
            <span
              class="pointer-events-none absolute inset-y-1 left-1/2 w-3 -translate-x-1/2 rounded-md border-2 border-brand bg-bg-elevated shadow-md"
              aria-hidden="true"
            >
              <span class="absolute inset-y-2 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-brand" />
            </span>
          </button>
          <button
            type="button"
            data-handle="end"
            data-testid="trim-end-handle"
            class={handleClass('end')}
            style={{ left: `${endPct()}%` }}
            onPointerDown={(event) => startDrag(event, 'end')}
            role="slider"
            aria-label={t('trim.end')}
            aria-valuemin={minEnd()}
            aria-valuemax={props.duration}
            aria-valuenow={effectiveEnd()}
            aria-valuetext={formatTimePrecise(effectiveEnd())}
            disabled={props.disabled}
            onKeyDown={handleEndKeyDown}
          >
            <span
              class="pointer-events-none absolute inset-y-1 left-1/2 w-3 -translate-x-1/2 rounded-md border-2 border-brand bg-bg-elevated shadow-md"
              aria-hidden="true"
            >
              <span class="absolute inset-y-2 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-brand" />
            </span>
          </button>

          <Show when={dragging()}>
            {(handle) => (
              <div
                class="pointer-events-none absolute -top-8 z-30 -translate-x-1/2 whitespace-nowrap rounded-md bg-text-primary px-2 py-1 font-mono text-xs font-semibold tabular-nums text-bg-base shadow-lg"
                style={{ left: `${handle() === 'start' ? startPct() : endPct()}%` }}
              >
                {formatTimePrecise(handle() === 'start' ? props.trimStart : effectiveEnd())}
              </div>
            )}
          </Show>
        </fieldset>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <label for="trim-start-input" class="text-xs font-medium text-text-secondary">
          {t('trim.startLabel')}
          <input
            id="trim-start-input"
            name="trim-start"
            type="text"
            inputmode="decimal"
            dir="ltr"
            value={startText()}
            disabled={props.disabled}
            autocomplete="off"
            aria-invalid={startError() ? 'true' : undefined}
            aria-describedby={startError() ? 'trim-start-error' : undefined}
            onInput={(event) => {
              setStartText(event.currentTarget.value);
              setStartError(null);
            }}
            onFocus={() => setStartFocused(true)}
            onBlur={commitStartText}
            onKeyDown={handleStartTextKeyDown}
            class={inputClass}
          />
        </label>
        <label for="trim-end-input" class="text-xs font-medium text-text-secondary">
          {t('trim.endLabel')}
          <input
            id="trim-end-input"
            name="trim-end"
            type="text"
            inputmode="decimal"
            dir="ltr"
            value={endText()}
            disabled={props.disabled}
            autocomplete="off"
            aria-invalid={endError() ? 'true' : undefined}
            aria-describedby={endError() ? 'trim-end-error' : undefined}
            onInput={(event) => {
              setEndText(event.currentTarget.value);
              setEndError(null);
            }}
            onFocus={() => setEndFocused(true)}
            onBlur={commitEndText}
            onKeyDown={handleEndTextKeyDown}
            class={inputClass}
          />
        </label>
      </div>
      <Show when={startError()}>
        {(message) => (
          <p id="trim-start-error" class="-mt-2 text-xs text-red-600" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={endError()}>
        {(message) => (
          <p id="trim-end-error" class="-mt-2 text-xs text-red-600" role="alert">
            {message()}
          </p>
        )}
      </Show>

      <p id="trim-summary" class="text-xs text-text-tertiary" data-testid="trim-summary">
        {formatTrimSummary(trimDuration(), props.duration, frameCount(), locale(), t)}
      </p>

      <div class="space-y-2">
        <span class="block text-xs font-medium text-text-secondary">{t('trim.quickSelect')}</span>
        <div class="flex flex-wrap gap-2">
          <For each={primaryPresets()}>
            {(preset) => (
              <button
                type="button"
                onClick={() => applyPreset(preset)}
                disabled={props.disabled}
                aria-pressed={isPresetActive(preset)}
                data-testid={`trim-preset-${preset.id}`}
                class={`${controlClass} ${isPresetActive(preset) ? 'border-brand bg-brand/15 text-text-primary' : ''}`}
              >
                {preset.label}
              </button>
            )}
          </For>
          <Show when={additionalPresets().length > 0}>
            <select
              value={activeAdditionalPreset()}
              disabled={props.disabled}
              aria-label={t('trim.morePresets')}
              data-testid="trim-more-presets"
              class={`${controlClass} cursor-pointer appearance-auto pe-8`}
              onChange={(event) => {
                const preset = additionalPresets().find(
                  (item) => item.id === event.currentTarget.value
                );
                if (preset) applyPreset(preset);
              }}
            >
              <option value="">{t('trim.morePresets')}</option>
              <For each={additionalPresets()}>
                {(preset) => <option value={preset.id}>{preset.label}</option>}
              </For>
            </select>
          </Show>
        </div>
      </div>

      <Show when={props.onPreviewSelection}>
        <button
          type="button"
          onClick={() => props.onPreviewSelection?.()}
          disabled={props.disabled}
          aria-pressed={!!props.isPreviewing}
          data-testid="trim-preview-button"
          class={`${controlClass} inline-flex w-full items-center justify-center gap-2 text-text-primary sm:w-auto`}
        >
          <Show
            when={props.isPreviewing}
            fallback={
              <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M5.5 3.8a1 1 0 0 1 1.5-.86l8.5 5.2a1 1 0 0 1 0 1.72L7 15.06a1 1 0 0 1-1.5-.86V3.8Z" />
              </svg>
            }
          >
            <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <rect x="5" y="4" width="4" height="12" rx="1" />
              <rect x="11" y="4" width="4" height="12" rx="1" />
            </svg>
          </Show>
          {props.isPreviewing ? t('trim.stopPreview') : t('trim.previewSelection')}
        </button>
      </Show>
    </section>
  );
};

export default TrimSelector;
