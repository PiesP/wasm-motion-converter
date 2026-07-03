// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Internationalization Utilities (i18n module re-export barrel)
 *
 * Re-exports all utilities from @utils/intl-utils for convenient imports
 * via the @i18n path alias.
 */

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
