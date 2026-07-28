// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ConversionProfileReport } from './conversion-profiler';

/**
 * Main-realm storage for the most recently completed conversion profile.
 *
 * Worker conversions cannot expose their profiler instance directly because
 * it lives in a separate JavaScript realm. Storing the structured report here
 * gives diagnostics and browser tests one route-independent API.
 */
let lastCompletedReport: ConversionProfileReport | null = null;

export function getLastConversionProfileReport(): ConversionProfileReport | null {
  return lastCompletedReport;
}

export function setLastConversionProfileReport(report: ConversionProfileReport): void {
  lastCompletedReport = report;
}

export function clearLastConversionProfileReport(): void {
  lastCompletedReport = null;
}
