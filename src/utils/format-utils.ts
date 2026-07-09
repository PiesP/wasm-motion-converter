// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Format Utilities & Internationalization
 *
 * ID generation, duration formatting, file size formatting, and i18n helpers.
 * Consolidated from format-utils.ts and intl-utils.ts during code audit
 * (over-engineering reduction: merge tiny utility files).
 */

import type { Locale } from '@t/i18n-types';
import { DEFAULT_LOCALE, LOCALES } from '@t/i18n-types';
import { BYTES_PER_KB, LOCALE_STORAGE_KEY } from './constants';

// ============================================================================
// ID Generation
// ============================================================================

/**
 * Generate a collision-resistant UUID using `crypto.randomUUID()`.
 */
export function createId(): string {
  return crypto.randomUUID();
}

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
 */
export function detectInitialLocale(storageKey = LOCALE_STORAGE_KEY): Locale {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored && LOCALES.some((l) => l.code === stored)) return stored as Locale;
  } catch {
    /* localStorage unavailable */
  }

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

// ============================================================================
// Locale-Aware Formatting (Intl API)
// ============================================================================

/**
 * Format file size with locale-aware separators and units.
 */
export function formatFileSizeLocale(bytes: number, locale: Locale): string {
  if (bytes === 0) return `${new Intl.NumberFormat(locale).format(0)} ${fileUnit(0, locale)}`;
  const k = BYTES_PER_KB;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), 3);
  const value = bytes / k ** i;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: i === 0 ? 0 : 2 }).format(value)} ${fileUnit(i, locale)}`;
}

const FILE_UNITS: Record<string, readonly string[]> = {
  en: ['B', 'KB', 'MB', 'GB'],
  ko: ['바이트', 'KB', 'MB', 'GB'],
};

function fileUnit(index: number, locale: Locale): string {
  const units = FILE_UNITS[locale] ?? FILE_UNITS.en!;
  return units[index] ?? 'B';
}

/**
 * Format duration with locale-aware units.
 *
 * @param ms - Duration in **milliseconds** (not seconds).
 * @param locale - BCP 47 locale identifier
 */
export function formatDurationLocale(ms: number, locale: Locale): string {
  const units = DURATION_UNITS[locale] ?? DURATION_UNITS.en!;
  if (ms < 1000) return `${new Intl.NumberFormat(locale).format(Math.round(ms))}${units.ms}`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}${units.min} ${seconds}${units.sec}`;
  return `${(ms / 1000).toFixed(1)}${units.sec}`;
}

interface DurationUnits {
  readonly ms: string;
  readonly sec: string;
  readonly min: string;
}

const DURATION_UNITS: Record<string, DurationUnits> = {
  en: { ms: 'ms', sec: 's', min: 'm' },
  ko: { ms: 'ms', sec: '초', min: '분' },
};
