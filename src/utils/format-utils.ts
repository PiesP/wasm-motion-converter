// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Format Utilities & Internationalization
 *
 * ID generation, duration formatting, file size formatting, and i18n helpers.
 * Consolidated from format-utils.ts and intl-utils.ts during code audit
 * (over-engineering reduction: merge tiny utility files).
 */

import { formatDuration, formatFileSize, normalizeLocale } from '@piesp/browser-core/locale';
import type { Locale } from '@t/i18n-types';
import { DEFAULT_LOCALE, APP_LOCALE_CODES, isAppLocale } from '@t/i18n-types';

import { BYTES_PER_KB, LOCALE_STORAGE_KEY } from './constants';

export { createId } from '@piesp/browser-core/util';

// ============================================================================
// Duration Formatting
// ============================================================================

/**
 * Format duration in seconds to human-readable time string.
 *
 * @param seconds - Duration in seconds
 * @param locale - Optional BCP 47 locale for locale-aware formatting.
 *                 When omitted, falls back to H:MM:SS format.
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

// ============================================================================
// File Size Formatting
// ============================================================================

/**
 * Format bytes to human-readable string.
 *
 * @param bytes - Number of bytes to format (must be non-negative)
 * @param locale - Optional BCP 47 locale for locale-aware formatting.
 *                 When omitted, falls back to locale-unaware format.
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

// ============================================================================
// Locale Detection
// ============================================================================

/**
 * Detect user's preferred locale from browser settings.
 *
 * Tries exact match first, then base-language match (e.g. "en-GB" → "en").
 * Falls back to `defaultLocale` if nothing matches.
 */
export function detectUserLocale(
  supportedLocales: Locale[],
  defaultLocale: Locale = DEFAULT_LOCALE
): Locale {
  const match = (raw: unknown): Locale | null => {
    if (typeof raw !== 'string') return null;
    const normalized = normalizeLocale(raw);
    return isAppLocale(normalized) && supportedLocales.includes(normalized) ? normalized : null;
  };

  try {
    const platformLanguage = (
      globalThis as { chrome?: { i18n?: { getUILanguage?: () => string } } }
    ).chrome?.i18n?.getUILanguage?.();
    const platformMatch = match(platformLanguage);
    if (platformMatch) return platformMatch;
  } catch {
    // Platform API may be unavailable outside an extension.
  }

  try {
    if (typeof navigator !== 'undefined') {
      const languages = navigator.languages;
      if (languages?.length) {
        for (const language of languages) {
          const matched = match(language);
          if (matched) return matched;
        }
      } else {
        const matched = match(navigator.language);
        if (matched) return matched;
      }
    }
  } catch {
    // Navigator may be unavailable in an isolated runtime.
  }

  return defaultLocale;
}

/**
 * Detect the initial locale using the app's configured LOCALES.
 *
 * Checks localStorage first, then browser language preference via
 * `detectUserLocale()`, then falls back to DEFAULT_LOCALE.
 */
export function detectInitialLocale(storageKey = LOCALE_STORAGE_KEY): Locale {
  try {
    const stored = localStorage.getItem(storageKey);
    if (isAppLocale(stored)) return stored;
  } catch {
    /* localStorage unavailable */
  }

  const matched = detectUserLocale([...APP_LOCALE_CODES]);
  if (matched) return matched;

  return DEFAULT_LOCALE;
}

/**
 * Update document-level language attributes.
 */
export function updateDocumentLang(locale: Locale, dir: 'ltr' | 'rtl'): void {
  document.documentElement.setAttribute('lang', locale);
  document.documentElement.setAttribute('dir', dir);
}

// ============================================================================
// Locale-Aware Formatting (Intl API)
// ============================================================================

/**
 * Format file size with locale-aware separators and units.
 */
export function formatFileSizeLocale(bytes: number, locale: Locale): string {
  return formatFileSize(bytes, locale);
}

/**
 * Format duration with locale-aware units.
 *
 * @param ms - Duration in **milliseconds** (not seconds).
 * @param locale - BCP 47 locale identifier
 */
export function formatDurationLocale(ms: number, locale: Locale): string {
  return formatDuration(ms, locale);
}
