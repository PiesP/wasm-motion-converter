// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Internationalization Utilities (i18n module re-export)
 *
 * Re-exports utilities from @utils/intl-utils and adds i18n-specific helpers
 * that depend on locale-aware formatting (formatRelativeTime, formatDate, formatTime).
 */

import type { Locale } from '@t/i18n-types';
import { formatFileSize } from '@utils/intl-utils';

export type { Locale } from '@t/i18n-types';
export {
  detectInitialLocale,
  detectUserLocale,
  formatDuration,
  formatFileSize,
  formatNumber,
  formatPercent,
  updateDocumentLang,
} from '@utils/intl-utils';

/**
 * Format file size in bytes to locale-aware string.
 *
 * @deprecated Use `formatBytes(bytes, locale)` from `@utils/format-utils` instead.
 *   Both functions delegate to `formatFileSize` — the `format-utils` version
 *   additionally supports a locale-unaware fallback when no locale is given.
 *
 * @param bytes - Number of bytes
 * @param locale - BCP 47 locale identifier
 * @returns Formatted file size string
 */
export function formatBytes(bytes: number, locale: Locale): string {
  return formatFileSize(bytes, locale);
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
