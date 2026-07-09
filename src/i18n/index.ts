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
// NOTE: Only locale detection and document-lang utilities are re-exported here.
// Locale-aware formatters (formatDuration, formatBytes, etc.) should be imported
// directly from their canonical homes:
//   - formatDuration(ms, locale)  → @utils/intl-utils  (milliseconds)
//   - formatDurationSeconds(seconds, locale) → @utils/format-utils  (seconds)
//   - formatBytes(bytes, locale)  → @utils/format-utils
// This avoids SSOT confusion between ms-vs-seconds parameter units.
export {
  detectInitialLocale,
  detectUserLocale,
  updateDocumentLang,
} from '@utils/intl-utils';
// ─── Types ──────────────────────────────────────────────────────────────────
export type {
  Locale,
  LocaleInfo,
  PartialTranslations,
  TFunction,
  TranslationKeys,
  Translations,
} from './types';
