// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * i18n Module
 *
 * Internationalization infrastructure for wasm-motion-converter.
 * Provides locale-aware translations, formatting utilities, and reactive locale management.
 *
 * @module
 *
 * @example
 * ```tsx
 * // Using the hook
 * import { useI18n } from '@i18n';
 *
 * function MyComponent() {
 *   const { t, locale, setLocale } = useI18n();
 *   return <button>{t('settings.convert')}</button>;
 * }
 * ```
 *
 * @example
 * ```tsx
 * // Using formatting utilities
 * import { formatDuration, formatBytes, formatNumber, formatRelativeTime } from '@i18n';
 *
 * const duration = formatDuration(90000, 'en'); // "1m 30s"
 * const size = formatBytes(1572864, 'ko');       // "1.5 MB"
 * ```
 *
 * @example
 * ```tsx
 * // Using locale store directly
 * import { createLocaleStore, LOCALES, DEFAULT_LOCALE } from '@i18n';
 *
 * const [locale, setLocale, store] = createLocaleStore();
 * ```
 */

// ─── Re-exports from @t/i18n-types for convenience ──────────────────────────
export type { Locale as LocaleCode } from '@t/i18n-types';
// ─── Intl Utilities ─────────────────────────────────────────────────────────
export {
  formatBytes,
  formatDate,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatTime,
} from './intl-utils';
// ─── Locale Store ───────────────────────────────────────────────────────────
// Re-export detectInitialLocale as a local function for use in `locale` constant
export {
  createLocaleStore,
  DEFAULT_LOCALE,
  detectInitialLocale,
  getLocaleSignal,
  initLocaleStore,
  LOCALES,
  setLocale,
} from './locale-store';

import type { Locale } from './types';

/**
 * Get the initial locale (synchronous, for use in entry point).
 * For reactive locale management in components, use `useI18n()` hook.
 */
export function getLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en';
  const browserLangs = navigator.languages ?? (navigator.language ? [navigator.language] : []);
  if (browserLangs.length === 0) return 'en';
  for (const lang of browserLangs) {
    if (!lang) continue;
    const base = lang.split('-')[0]?.toLowerCase() ?? '';
    if (base === 'ko') return 'ko';
    if (base === 'en') return 'en';
  }
  return 'en';
}
// ─── Types ──────────────────────────────────────────────────────────────────
export type {
  Locale,
  LocaleInfo,
  PartialTranslations,
  TFunction,
  TranslationKeys,
  Translations,
} from './types';
export type { UseI18nReturn } from './use-i18n';
// ─── Hook ───────────────────────────────────────────────────────────────────
export { useI18n } from './use-i18n';
