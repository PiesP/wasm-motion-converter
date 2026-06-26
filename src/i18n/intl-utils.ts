// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Internationalization Utilities
 *
 * Intl.* wrappers for locale-aware formatting:
 * - formatDuration: milliseconds → "1m 30s" / "1분 30초"
 * - formatRelativeTime: seconds → "in 2 minutes" / "2분 후"
 * - formatNumber: locale-aware number formatting
 * - formatBytes: bytes → "1.5 MB"
 */

import type { Locale } from './types';

/**
 * Format duration in milliseconds to locale-aware string.
 *
 * Examples:
 * - en: "1m 30s", "500ms", "2.5s"
 * - ko: "1분 30초", "500ms", "2.5초"
 *
 * @param ms - Duration in milliseconds
 * @param locale - BCP 47 locale identifier
 * @returns Formatted duration string
 */
export function formatDuration(ms: number, locale: Locale): string {
  if (ms < 1000) {
    return `${new Intl.NumberFormat(locale).format(Math.round(ms))}ms`;
  }

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (locale.startsWith('ko')) {
    if (minutes > 0) {
      return `${minutes}분 ${seconds}초`;
    }
    return `${(ms / 1000).toFixed(1)}초`;
  }

  // English (default)
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Format relative time in seconds to locale-aware string.
 *
 * Examples:
 * - en: "in 2 minutes", "in 5 seconds", "now"
 * - ko: "2분 후", "5초 후", "지금"
 *
 * @param seconds - Number of seconds (positive = future, negative = past)
 * @param locale - BCP 47 locale identifier
 * @returns Formatted relative time string
 */
export function formatRelativeTime(seconds: number, locale: Locale): string {
  const absSeconds = Math.abs(seconds);
  const sign = seconds >= 0 ? 1 : -1;

  // Determine the appropriate unit and value
  let value: number;
  let unit: Intl.RelativeTimeFormatUnit;

  if (absSeconds < 60) {
    value = absSeconds;
    unit = 'second';
  } else if (absSeconds < 3600) {
    value = Math.round(absSeconds / 60);
    unit = 'minute';
  } else if (absSeconds < 86400) {
    value = Math.round(absSeconds / 3600);
    unit = 'hour';
  } else {
    value = Math.round(absSeconds / 86400);
    unit = 'day';
  }

  const formatter = new Intl.RelativeTimeFormat(locale, {
    numeric: 'auto',
    style: 'long',
  });

  return formatter.format(sign * value, unit);
}

/**
 * Format a number with locale-aware grouping and decimals.
 *
 * Examples:
 * - en: "1,234.56" (1,234)
 * - ko: "1,234.56" (1,234)
 *
 * @param num - Number to format
 * @param locale - BCP 47 locale identifier
 * @param options - Additional Intl.NumberFormatOptions
 * @returns Formatted number string
 */
export function formatNumber(
  num: number,
  locale: Locale,
  options?: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat(locale, options).format(num);
}

/**
 * Format file size in bytes to locale-aware string.
 *
 * Note: Korean uses the same SI prefixes (KB, MB, GB) as English,
 * so the unit labels remain the same — only the number formatting changes.
 *
 * Examples:
 * - en: "1.5 MB", "1024 bytes"
 * - ko: "1.5 MB", "1024 바이트"
 *
 * @param bytes - Number of bytes
 * @param locale - BCP 47 locale identifier
 * @returns Formatted file size string
 */
export function formatBytes(bytes: number, locale: Locale): string {
  if (bytes === 0) {
    const suffix = locale.startsWith('ko') ? ' 바이트' : ' B';
    return `${new Intl.NumberFormat(locale).format(0)}${suffix}`;
  }

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'] as const;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  const value = bytes / k ** i;

  const formattedValue = new Intl.NumberFormat(locale, {
    maximumFractionDigits: i === 0 ? 0 : 2,
  }).format(value);

  const unitSuffix = locale.startsWith('ko') && sizes[i] === 'B' ? '바이트' : '';
  return `${formattedValue} ${sizes[i]}${unitSuffix}`.trim();
}

/**
 * Format percentage with locale-aware formatting.
 *
 * @param value - Value as percentage (e.g., 50 for 50%)
 * @param locale - BCP 47 locale identifier
 * @param digits - Number of decimal digits
 * @returns Formatted percentage string
 */
export function formatPercent(value: number, locale: Locale, digits = 0): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: digits,
  }).format(value / 100);
}

/**
 * Format a date with locale-aware formatting.
 *
 * @param date - Date to format
 * @param locale - BCP 47 locale identifier
 * @param options - Additional Intl.DateTimeFormatOptions
 * @returns Formatted date string
 */
export function formatDate(
  date: Date,
  locale: Locale,
  options?: Intl.DateTimeFormatOptions
): string {
  return new Intl.DateTimeFormat(locale, options).format(date);
}

/**
 * Format a time with locale-aware formatting.
 *
 * @param date - Date whose time to format
 * @param locale - BCP 47 locale identifier
 * @param options - Additional Intl.DateTimeFormatOptions
 * @returns Formatted time string
 */
export function formatTime(
  date: Date,
  locale: Locale,
  options?: Intl.DateTimeFormatOptions
): string {
  return new Intl.DateTimeFormat(locale, options).format(date);
}
