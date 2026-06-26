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
export {
  createLocaleStore,
  DEFAULT_LOCALE,
  detectInitialLocale,
  getLocaleSignal,
  initLocaleStore,
  LOCALES,
  setLocale,
} from './locale-store';
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
