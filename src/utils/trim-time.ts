// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

export const TRIM_END_FULL_DURATION = 0;
export const TRIM_STEP = 0.1;

export function isFullDuration(trimEnd: number): boolean {
  return trimEnd === TRIM_END_FULL_DURATION;
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
}

export function clampToStep(value: number): number {
  return Number((Math.round(value / TRIM_STEP) * TRIM_STEP).toFixed(2));
}
