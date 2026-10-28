// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

export const TRIM_END_FULL_DURATION = 0;
export const TRIM_STEP = 0.1;

export function isFullDuration(trimEnd: number): boolean {
  return trimEnd === TRIM_END_FULL_DURATION;
}

export function getTrimmedDurationSeconds(
  durationSeconds: number,
  trimStartSeconds: number,
  trimEndSeconds: number
): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;

  const endSeconds =
    !Number.isFinite(trimEndSeconds) || trimEndSeconds <= TRIM_END_FULL_DURATION
      ? durationSeconds
      : Math.min(durationSeconds, trimEndSeconds);
  const startSeconds = Math.min(
    durationSeconds,
    Math.max(0, Number.isFinite(trimStartSeconds) ? trimStartSeconds : 0)
  );

  return Math.max(0, endSeconds - startSeconds);
}

export function formatTimePrecise(seconds: number): string {
  const safeSeconds = Math.max(0, seconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;
  const secondsText = remainingSeconds.toFixed(1).padStart(4, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${secondsText}`;
  }
  return `${minutes}:${secondsText}`;
}

export function parseTimeInput(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(':');
  // Consume every decimal component. Prefix parsing can silently select a
  // different trim point for malformed suffixes or decimal commas.
  if (parts.length > 3 || parts.some((part) => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(part)))
    return null;
  const value = parts.reduce((seconds, part) => seconds * 60 + Number(part), 0);
  return Number.isFinite(value) ? value : null;
}

export function clampToStep(value: number): number {
  return Number((Math.round(value / TRIM_STEP) * TRIM_STEP).toFixed(2));
}
