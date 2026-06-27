// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Internationalization Utilities
 *
 * Core i18n helpers: locale detection, Intl API wrappers, lang attribute management.
 */

import { DEFAULT_LOCALE, LOCALES, type Locale } from '@t/i18n-types';

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
  if (typeof navigator === 'undefined') return defaultLocale;

  const browserLangs = navigator.languages ?? (navigator.language ? [navigator.language] : []);
  if (browserLangs.length === 0) return defaultLocale;

  for (const lang of browserLangs) {
    if (!lang) continue;
    const baseLang = lang.split('-')[0]?.toLowerCase() ?? lang.toLowerCase();
    const exactMatch = supportedLocales.find((l) => l.toLowerCase() === lang.toLowerCase());
    if (exactMatch) return exactMatch;
    const baseMatch = supportedLocales.find(
      (l) => l.toLowerCase().startsWith(baseLang) || baseLang.startsWith(l.toLowerCase())
    );
    if (baseMatch) return baseMatch;
  }

  return defaultLocale;
}

/**
 * Detect the initial locale using the app's configured LOCALES.
 *
 * Checks localStorage first, then browser language preference via
 * `detectUserLocale()`, then falls back to DEFAULT_LOCALE.
 *
 * This is the single canonical implementation — all other locale-detection
 * functions (the former `getLocale()` in `i18n/index.ts`,
 * `detectBrowserLocale()` / `detectInitialLocale()` in `i18n/locale-store.ts`)
 * have been removed in favour of this one.
 */
export function detectInitialLocale(storageKey = 'dropconvert.locale'): Locale {
  // 1. Stored preference
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored && LOCALES.some((l) => l.code === stored)) return stored as Locale;
  } catch {
    /* localStorage unavailable */
  }

  // 2. Browser language → LOCALES match
  const matched = detectUserLocale(LOCALES.map((l) => l.code));
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

/**
 * Format file size with locale-aware separators.
 */
export function formatFileSize(bytes: number, locale: Locale): string {
  if (bytes === 0) return `${new Intl.NumberFormat(locale).format(0)} B`;
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  const k = 1024;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  const value = bytes / k ** i;
  const unit = units[i] ?? 'B';
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: i === 0 ? 0 : 2 }).format(value)} ${unit}`;
}

/**
 * Format duration with locale-aware units.
 *
 * @param ms - Duration in **milliseconds** (not seconds).
 *             For a seconds-based formatter, see `formatDurationSeconds()` in format-utils.
 * @param locale - BCP 47 locale identifier
 */
export function formatDuration(ms: number, locale: Locale): string {
  if (ms < 1000) return `${new Intl.NumberFormat(locale).format(Math.round(ms))}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Format number with locale-aware grouping.
 */
export function formatNumber(
  value: number,
  locale: Locale,
  options?: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

/**
 * Format percentage with locale-aware formatting.
 */
export function formatPercent(value: number, locale: Locale, digits = 0): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: digits }).format(
    value / 100
  );
}
