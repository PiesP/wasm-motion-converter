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
