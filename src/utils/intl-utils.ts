// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Intl Utilities — locale-aware formatting for durations, numbers, and percentages.
 *
 * Provides thin wrappers around the ECMAScript Internationalization API (Intl)
 * with project-specific formatting conventions.
 */

// ─── Number ─────────────────────────────────────────────────────────────────

/**
 * Format a number with locale-aware grouping separators.
 *
 * @param value - Number to format
 * @param locale - BCP 47 language tag
 * @param options - Optional Intl.NumberFormatOptions overrides
 * @returns Formatted number string (e.g., "1,000", "1,000,000")
 */
export function formatNumber(
  value: number,
  locale: string,
  options?: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

// ─── Percentage ─────────────────────────────────────────────────────────────

/**
 * Format a number as a percentage string.
 *
 * @param value - Percentage value (0–100)
 * @param locale - BCP 47 language tag
 * @param decimals - Number of decimal places (default: 0)
 * @returns Formatted percentage string (e.g., "50%", "33.3%")
 */
export function formatPercent(value: number, locale: string, decimals?: number): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: decimals ?? 0,
    maximumFractionDigits: decimals ?? 0,
  }).format(value / 100);
}
