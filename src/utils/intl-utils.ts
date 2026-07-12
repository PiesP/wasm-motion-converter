// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Intl Utilities — locale-aware formatting for durations, numbers, and percentages.
 *
 * Provides thin wrappers around the ECMAScript Internationalization API (Intl)
 * with project-specific formatting conventions.
 */

// ─── Duration ───────────────────────────────────────────────────────────────

const DURATION_UNITS: Record<string, { ms: Intl.RelativeTimeFormatUnit; short: string }[]> = {
  en: [
    { ms: 'minute', short: 'm' },
    { ms: 'second', short: 's' },
  ],
  ko: [
    { ms: 'minute', short: '분' },
    { ms: 'second', short: '초' },
  ],
};

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * @param ms - Duration in milliseconds
 * @param locale - BCP 47 language tag (e.g., 'en', 'ko')
 * @returns Formatted duration string (e.g., "1m 30s", "1분 30초", "500ms")
 */
export function formatDuration(ms: number, locale: string): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const remainingMs = ms % 1000;
  const tenths = Math.round(remainingMs / 100);

  const units = DURATION_UNITS[locale] ?? DURATION_UNITS.en!;

  if (minutes > 0) {
    return `${minutes}${units[0]!.short} ${seconds}${units[1]!.short}`;
  }

  const secondsDisplay = tenths > 0 ? `${seconds}.${tenths}` : `${seconds}.0`;
  return `${secondsDisplay}${units[1]!.short}`;
}

// ─── Number ─────────────────────────────────────────────────────────────────

/**
 * Format a number with locale-aware grouping separators.
 *
 * @param value - Number to format
 * @param locale - BCP 47 language tag
 * @param options - Optional Intl.NumberFormatOptions overrides
 * @returns Formatted number string (e.g., "1,000", "1,000,000")
 */
export function formatNumber(
  value: number,
  locale: string,
  options?: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

// ─── Percentage ─────────────────────────────────────────────────────────────

/**
 * Format a number as a percentage string.
 *
 * @param value - Percentage value (0–100)
 * @param locale - BCP 47 language tag
 * @param decimals - Number of decimal places (default: 0)
 * @returns Formatted percentage string (e.g., "50%", "33.3%")
 */
export function formatPercent(value: number, locale: string, decimals?: number): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: decimals ?? 0,
    maximumFractionDigits: decimals ?? 0,
  }).format(value / 100);
}
