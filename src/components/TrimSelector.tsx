// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import type { Component } from 'solid-js';
import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js';

const TRIM_END_FULL_DURATION = 0;

interface TrimSelectorProps {
  duration: number;
  trimStart: number;
  trimEnd: number;
  /** Target FPS for frame count estimate (default: 15) */
  estimatedFps?: number;
  disabled?: boolean;
  onChange: (start: number, end: number) => void;
}

const MIN_DURATION = 0.5;
const STEP = 0.1;

/**
 * Format seconds as "M:SS" — e.g., 65.7 → "1:05"
 * Supports hours: "H:MM:SS" for durations >= 3600s
 */
const formatTime = (seconds: number): string => {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
};

/**
 * Format seconds as "M:SS.s" for text input — e.g., 5.3 → "0:05.3"
 */
const formatTimePrecise = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toFixed(1).padStart(4, '0')}`;
};

/**
 * Parse time input string to seconds.
 * Supports: "90" (plain seconds), "1:30" (mm:ss),
 * "1:30.5" (mm:ss.s), "0:01:30" (hh:mm:ss)
 * Returns null if unparseable.
 */
const parseTimeInput = (input: string): number | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // "hh:mm:ss.s" or "mm:ss.s"
  const colonCount = (trimmed.match(/:/g) || []).length;
  if (colonCount >= 1) {
    const parts = trimmed.split(':');
    if (colonCount === 1 && parts.length === 2) {
      // "mm:ss.s"
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

  // Plain seconds: "90" or "1.5"
  const num = parseFloat(trimmed);
  return Number.isNaN(num) ? null : num;
};

/**
 * Round a value to the nearest step (0.1s).
 */
const clampToStep = (value: number): number => {
  return Math.round(value / STEP) * STEP;
};

const TrimSelector: Component<TrimSelectorProps> = (props) => {
  const fps = (): number => props.estimatedFps ?? 15;

  const effectiveEnd = createMemo(() => {
    if (props.trimEnd === TRIM_END_FULL_DURATION || props.trimEnd > props.duration) {
      return props.duration;
    }
    return props.trimEnd;
  });

  const trimDuration = createMemo(() => {
    return effectiveEnd() - props.trimStart;
  });

  const startPct = createMemo(() => {
    if (props.duration <= 0) return 0;
    return (props.trimStart / props.duration) * 100;
  });

  const endPct = createMemo(() => {
    if (props.duration <= 0) return 100;
    return (effectiveEnd() / props.duration) * 100;
  });

  /** Hide end label when handles are too close (< 8% apart) */
  const showEndLabel = createMemo(() => {
    return startPct() <= endPct() - 8;
  });

  const mid = createMemo(() => props.duration / 2);

  const isDefault = createMemo(
    () => props.trimStart === 0 && props.trimEnd === TRIM_END_FULL_DURATION
  );

  const frameCount = createMemo(() => {
    return Math.round(trimDuration() * fps());
  });

  // ── Drag state ──

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
    let seconds = clientXToSeconds(e.clientX);
    seconds = clampToStep(seconds);

    if (handle === 'start') {
      const maxStart = Math.max(0, effectiveEnd() - 0.1);
      seconds = Math.max(0, Math.min(seconds, maxStart));
      if (seconds !== props.trimStart) {
        props.onChange(seconds, props.trimEnd);
      }
    } else {
      const minEnd = Math.min(props.duration, props.trimStart + 0.1);
      seconds = Math.max(minEnd, Math.min(seconds, props.duration));
      if (seconds !== effectiveEnd()) {
        props.onChange(props.trimStart, seconds);
      }
    }
  };

  const onPointerUp = () => {
    setDragging(null);
  };

  // Attach global pointer listeners when dragging
  createEffect(() => {
    const isDragging = dragging();
    if (isDragging) {
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

  // ── Track click (snap nearest handle) ──

  const handleTrackClick = (e: MouseEvent) => {
    if (props.disabled) return;
    // Ignore if the click came from a handle
    const target = e.target as HTMLElement;
    if (target.closest('[data-handle]')) return;

    const seconds = clampToStep(clientXToSeconds(e.clientX));

    if (
      seconds <= props.trimStart ||
      (seconds < effectiveEnd() && seconds - props.trimStart < effectiveEnd() - seconds)
    ) {
      // Snap to start handle
      const clamped = Math.min(seconds, Math.max(0, effectiveEnd() - 0.1));
      if (clamped !== props.trimStart) {
        props.onChange(clamped, props.trimEnd);
      }
    } else {
      // Snap to end handle
      const clamped = Math.max(seconds, Math.min(props.duration, props.trimStart + 0.1));
      if (clamped !== effectiveEnd()) {
        props.onChange(props.trimStart, clamped);
      }
    }
  };

  // ── Keyboard handlers for handles ──

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
    } else {
      return;
    }
    newStart = clampToStep(newStart);
    if (newStart !== props.trimStart) {
      props.onChange(newStart, props.trimEnd);
    }
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
    } else {
      return;
    }
    newEnd = clampToStep(newEnd);
    if (newEnd !== effectiveEnd()) {
      props.onChange(props.trimStart, newEnd);
    }
  };

  // ── Handlers ──

  const handleReset = () => {
    if (!props.disabled) {
      props.onChange(0, 0);
    }
  };

  const handlePreset = (start: number, end: number) => {
    if (!props.disabled) {
      props.onChange(start, end);
    }
  };

  // ── Presets ──

  const presets = createMemo(() => {
    const list: Array<{ label: string; start: number; end: number; hidden: boolean }> = [];

    // "Full" — always visible
    list.push({ label: 'Full', start: 0, end: TRIM_END_FULL_DURATION, hidden: false });

    if (props.duration > 10) {
      list.push({
        label: 'First 10s',
        start: 0,
        end: Math.min(10, props.duration),
        hidden: false,
      });
      list.push({
        label: 'Last 10s',
        start: Math.max(0, props.duration - 10),
        end: TRIM_END_FULL_DURATION,
        hidden: false,
      });
      list.push({
        label: 'Middle 10s',
        start: Math.max(0, mid() - 5),
        end: Math.min(props.duration, mid() + 5),
        hidden: false,
      });
    } else {
      list.push({ label: 'First 10s', start: 0, end: TRIM_END_FULL_DURATION, hidden: true });
      list.push({ label: 'Last 10s', start: 0, end: TRIM_END_FULL_DURATION, hidden: true });
      list.push({ label: 'Middle 10s', start: 0, end: TRIM_END_FULL_DURATION, hidden: true });
    }

    if (props.duration >= 2) {
      list.push({ label: 'First Half', start: 0, end: props.duration / 2, hidden: false });
    } else {
      list.push({ label: 'First Half', start: 0, end: TRIM_END_FULL_DURATION, hidden: true });
    }

    return list;
  });

  const isPresetActive = (start: number, end: number): boolean => {
    return props.trimStart === start && props.trimEnd === end;
  };

  const presetBtnClass = (active: boolean, label?: string): string => {
    const isFull = label === 'Full';
    return [
      'text-xs px-2 py-0.5 rounded border transition-colors',
      active
        ? `bg-blue-100 dark:bg-blue-900 border-blue-400${isFull ? ' font-medium' : ''}`
        : 'border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700',
      props.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
    ].join(' ');
  };

  // ── Text input state ──

  const [startFocused, setStartFocused] = createSignal(false);
  const [endFocused, setEndFocused] = createSignal(false);
  const [startText, setStartText] = createSignal(formatTimePrecise(props.trimStart));
  const [endText, setEndText] = createSignal(formatTimePrecise(effectiveEnd()));

  // Sync from props when not editing
  createEffect(() => {
    if (!startFocused()) {
      setStartText(formatTimePrecise(props.trimStart));
    }
  });

  createEffect(() => {
    if (!endFocused()) {
      setEndText(formatTimePrecise(effectiveEnd()));
    }
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
      props.onChange(props.trimStart, clampToStep(clamped));
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

  // ── Dragged handle style ──

  const handleClass = (which: 'start' | 'end'): string => {
    const base = [
      'absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-6 h-6',
      'rounded-full bg-white dark:bg-gray-200 border-2',
      'border-blue-500 dark:border-blue-400 ring-1 ring-gray-300 dark:ring-gray-600',
      'cursor-col-resize hover:scale-110 transition-transform transition-shadow duration-150',
      'focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-1 focus-visible:outline-none',
      props.disabled ? 'cursor-not-allowed opacity-50' : '',
    ];
    if (dragging() === which) {
      base.push('scale-125 shadow-lg ring-2 ring-blue-400');
    }
    return base.filter(Boolean).join(' ');
  };

  // ── Text input class ──

  const textClass = [
    'text-xs border border-gray-300 dark:border-gray-700 rounded px-1 py-0.5',
    'bg-white dark:bg-gray-800 text-right font-mono w-[5.5rem]',
    props.disabled ? 'opacity-50 cursor-not-allowed' : '',
  ].join(' ');

  // ── Early return for too-short video ──

  if (props.duration < MIN_DURATION) {
    return <p class="text-xs text-gray-500 dark:text-gray-400">Video too short for trimming</p>;
  }

  // ── Render ──

  return (
    <div class="space-y-3" data-testid="trim-selector">
      {/* 1. Header row: title + Reset button */}
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium text-gray-700 dark:text-gray-300">Trim Range</span>
        {!isDefault() && (
          <button
            type="button"
            onClick={handleReset}
            disabled={props.disabled}
            data-testid="trim-reset-button"
            class={`text-xs px-2 py-1 rounded border transition-colors ${
              props.disabled
                ? 'opacity-50 cursor-not-allowed border-gray-300 dark:border-gray-700'
                : 'border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer'
            }`}
          >
            Reset
          </button>
        )}
      </div>

      {/* 2. Range Bar (custom pointer-event drag) */}
      <div
        ref={trackRef}
        class="relative h-8 rounded-lg bg-gray-200 dark:bg-gray-700 select-none touch-none cursor-pointer mb-5"
        classList={{
          'opacity-50 pointer-events-none': !!props.disabled,
        }}
        onClick={handleTrackClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleTrackClick(e as unknown as MouseEvent);
          }
        }}
        tabIndex={props.disabled ? -1 : 0}
        role="slider"
        aria-label="Trim range"
        aria-valuemin={0}
        aria-valuemax={props.duration}
        aria-valuenow={effectiveEnd() - props.trimStart}
        aria-disabled={!!props.disabled}
      >
        {/* Selected range fill */}
        <div
          class="absolute top-0 h-full rounded-lg bg-blue-500/15 dark:bg-blue-400/15 border-x-2 border-blue-500 dark:border-blue-400 transition-[left,width] duration-100"
          classList={{
            'bg-blue-500/25 dark:bg-blue-400/25': dragging() !== null,
          }}
          style={{
            left: `${startPct()}%`,
            width: `${endPct() - startPct()}%`,
          }}
        />

        {/* Left handle */}
        <div
          data-handle="start"
          class={handleClass('start')}
          style={{ left: `${startPct()}%` }}
          onPointerDown={(e) => startDrag(e, 'start')}
          role="slider"
          tabIndex={props.disabled ? -1 : 0}
          aria-label="Trim start"
          aria-valuemin={0}
          aria-valuemax={props.duration}
          aria-valuenow={props.trimStart}
          aria-disabled={!!props.disabled}
          onKeyDown={handleStartKeyDown}
        />

        {/* Right handle */}
        <div
          data-handle="end"
          class={handleClass('end')}
          style={{ left: `${endPct()}%` }}
          onPointerDown={(e) => startDrag(e, 'end')}
          role="slider"
          tabIndex={props.disabled ? -1 : 0}
          aria-label="Trim end"
          aria-valuemin={0}
          aria-valuemax={props.duration}
          aria-valuenow={effectiveEnd()}
          aria-disabled={!!props.disabled}
          onKeyDown={handleEndKeyDown}
        />

        {/* Handle time labels */}
        <div
          class="absolute top-full mt-1 -translate-x-1/2 text-xs text-blue-700/80 dark:text-blue-300/80 font-medium pointer-events-none select-none transition-[left] duration-75"
          style={{ left: `${startPct()}%` }}
        >
          {formatTime(props.trimStart)}
        </div>
        <div
          class="absolute top-full mt-1 -translate-x-1/2 text-xs text-blue-700/80 dark:text-blue-300/80 font-medium pointer-events-none select-none transition-[left] duration-75"
          classList={{ hidden: !showEndLabel() }}
          style={{ left: `${endPct()}%` }}
        >
          {formatTime(effectiveEnd())}
        </div>
      </div>

      {/* 3. Track labels */}
      <div class="flex justify-between text-[10px] text-gray-400 dark:text-gray-500 px-0.5 pt-1 border-t border-gray-200 dark:border-gray-700 mt-5">
        <span>{formatTime(0)}</span>
        <span>{formatTime(props.duration)}</span>
      </div>

      {/* 4. Preset buttons row */}
      <div class="flex gap-1.5 flex-wrap">
        {presets().map(
          (preset) =>
            !preset.hidden && (
              <button
                type="button"
                onClick={() => handlePreset(preset.start, preset.end)}
                disabled={props.disabled}
                class={presetBtnClass(isPresetActive(preset.start, preset.end), preset.label)}
              >
                {preset.label}
              </button>
            )
        )}
      </div>

      {/* 5. Precision text inputs (single row) */}
      <div class="flex items-center gap-2 justify-center">
        <span class="text-xs text-gray-600 dark:text-gray-400">Start</span>
        <input
          type="text"
          value={startText()}
          disabled={props.disabled}
          onInput={(e) => setStartText((e.target as HTMLInputElement).value)}
          onFocus={() => setStartFocused(true)}
          onBlur={commitStartText}
          onKeyDown={handleStartTextKeyDown}
          class={textClass}
        />
        <span class="text-gray-400 dark:text-gray-500 mx-1">&times;</span>
        <span class="text-xs text-gray-600 dark:text-gray-400">End</span>
        <input
          type="text"
          value={endText()}
          disabled={props.disabled}
          onInput={(e) => setEndText((e.target as HTMLInputElement).value)}
          onFocus={() => setEndFocused(true)}
          onBlur={commitEndText}
          onKeyDown={handleEndTextKeyDown}
          class={textClass}
        />
      </div>

      {/* 6. Summary row */}
      <div class="text-xs text-gray-500 dark:text-gray-400 text-center pt-1 border-t border-gray-100 dark:border-gray-800">
        {trimDuration().toFixed(1)}s · ~{frameCount()} frames · {fps()} fps
      </div>
    </div>
  );
};

export default TrimSelector;
