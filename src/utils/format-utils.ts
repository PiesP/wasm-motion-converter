// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { BYTES_PER_KB } from './constants.js';

/**
 * ID generation utility
 *
 * Generates a collision-resistant UUID using `crypto.randomUUID()`.
 */
export function createId(): string {
  return crypto.randomUUID();
}

/**
 * Format duration in seconds to human-readable time string
 *
 * @param seconds - Duration in seconds
 * @param locale - Optional BCP 47 locale for locale-aware formatting.
 *                 When provided, delegates to the locale-aware formatter
 *                 from `@utils/intl-utils` (e.g. "1분 30초" for ko).
 *                 When omitted, falls back to H:MM:SS format (e.g. "1:30").
 * @returns Formatted time string
 */
export function formatDurationSeconds(seconds: number, locale?: string): string {
  if (locale) {
    return formatDurationLocale(seconds * 1000, locale as Locale);
  }

  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  const pad = (num: number): string => num.toString().padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${pad(mins)}:${pad(secs)}`;
  }

  return `${mins}:${pad(secs)}`;
}

/**
 * Format bytes to human-readable string
 *
 * @param bytes - Number of bytes to format (must be non-negative)
 * @param locale - Optional BCP 47 locale for locale-aware formatting.
 *                 When provided, delegates to `formatFileSize()` from
 *                 `@utils/intl-utils` (e.g. "1,024 KB" in en).
 *                 When omitted, falls back to locale-unaware format (e.g. "1024.0 KB").
 * @returns Formatted file size string with appropriate unit
 */
export function formatBytes(bytes: number, locale?: string): string {
  if (locale) {
    return formatFileSizeLocale(bytes, locale as Locale);
  }

  if (bytes === 0) return '0 B';

  const k = BYTES_PER_KB;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}

// ─── Locale-aware delegates (imported from intl-utils) ──────────────────
// intl-utils does not import from format-utils, so this is safe.

import type { Locale } from '@t/i18n-types';
import {
  formatDuration as formatDurationLocale,
  formatFileSize as formatFileSizeLocale,
} from './intl-utils';
