// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Memory Info — Single abstraction over `performance.memory` (Chrome-only).
 *
 * This is the ONLY module that directly accesses `performance.memory`.
 * All other modules must import from here (or from memory-monitor.ts which
 * re-exports and extends this) to ensure a single source of truth for
 * browser memory information.
 */

import { BYTES_PER_KB, BYTES_PER_MB, DEVICE_MEMORY_HEAP_RATIO } from './constants.js';

export interface MemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
  usagePercentage: number;
  deviceMemoryGB?: number | undefined;
}

/**
 * A device-RAM heuristic for resource caps, never a measured JS heap value.
 * Callers must label it as an estimate and must not infer current heap usage.
 */
export function getEstimatedHeapLimitBytes(): number | null {
  const deviceMemoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (
    typeof deviceMemoryGB !== 'number' ||
    !Number.isFinite(deviceMemoryGB) ||
    deviceMemoryGB <= 0
  ) {
    return null;
  }
  const estimate = Math.floor(
    deviceMemoryGB * BYTES_PER_KB * BYTES_PER_MB * DEVICE_MEMORY_HEAP_RATIO
  );
  return Number.isSafeInteger(estimate) && estimate > 0 ? estimate : null;
}

/**
 * Get current JS heap memory info from the Performance API.
 * Chrome-only — returns null when unavailable.
 */
export function getMemoryInfo(): MemoryInfo | null {
  const memory = 'memory' in performance ? performance.memory : undefined;
  if (!memory || typeof memory !== 'object') return null;

  const { usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit } = memory as {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
  if (
    !Number.isFinite(usedJSHeapSize) ||
    !Number.isFinite(totalJSHeapSize) ||
    !Number.isFinite(jsHeapSizeLimit) ||
    usedJSHeapSize < 0 ||
    totalJSHeapSize < usedJSHeapSize ||
    jsHeapSizeLimit <= 0 ||
    totalJSHeapSize > jsHeapSizeLimit ||
    usedJSHeapSize > jsHeapSizeLimit
  ) {
    return null;
  }

  const deviceMemoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return {
    usedJSHeapSize,
    totalJSHeapSize,
    jsHeapSizeLimit,
    usagePercentage: (usedJSHeapSize / jsHeapSizeLimit) * 100,
    deviceMemoryGB:
      typeof deviceMemoryGB === 'number' && Number.isFinite(deviceMemoryGB) && deviceMemoryGB > 0
        ? deviceMemoryGB
        : undefined,
  };
}
