// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * i18n Module
 *
 * Internationalization infrastructure for wasm-motion-converter.
 * Provides locale-aware formatting utilities re-exported from intl-utils.
 *
 * NOTE: The duplicate singleton locale system (locale-store.ts, use-i18n.ts)
 * has been removed. The canonical locale system is the context-based
 * `LocaleProvider` / `useLocale()` from `@hooks/use-locale`.
 *
 * @module
 *
 * @example
 * ```tsx
 * // Using formatting utilities
 * import { formatDuration, formatBytes, formatNumber, formatRelativeTime } from '@i18n';
 *
 * const duration = formatDuration(90000, 'en'); // "1m 30s"
 * const size = formatBytes(1572864, 'ko');       // "1.5 MB"
 * ```
 */

// ─── Re-exports from @t/i18n-types for convenience ──────────────────────────
export type { Locale as LocaleCode } from '@t/i18n-types';
// ─── Intl Utilities ─────────────────────────────────────────────────────────
export {
  detectInitialLocale,
  detectUserLocale,
  formatDate,
  formatDuration,
  formatFileSize as formatBytes,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatTime,
  updateDocumentLang,
} from './intl-utils';
// ─── Types ──────────────────────────────────────────────────────────────────
export type {
  Locale,
  LocaleInfo,
  PartialTranslations,
  TFunction,
  TranslationKeys,
  Translations,
} from './types';
