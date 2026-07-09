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
 * Get current JS heap memory info from the Performance API.
 * Chrome-only — returns null when unavailable.
 */
export function getMemoryInfo(): MemoryInfo | null {
  if ('memory' in performance && performance.memory) {
    const memory = performance.memory as {
      usedJSHeapSize: number;
      totalJSHeapSize: number;
      jsHeapSizeLimit: number;
    };
    const deviceMemoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    return {
      usedJSHeapSize: memory.usedJSHeapSize,
      totalJSHeapSize: memory.totalJSHeapSize,
      jsHeapSizeLimit: memory.jsHeapSizeLimit,
      usagePercentage: (memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100,
      deviceMemoryGB: typeof deviceMemoryGB === 'number' ? deviceMemoryGB : undefined,
    };
  }

  const deviceMemoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof deviceMemoryGB === 'number' && deviceMemoryGB > 0) {
    // deviceMemory is total device RAM, not JS heap limit.
    // Use a conservative estimate: ~25% of device memory as available JS heap.
    const jsHeapSizeLimit = deviceMemoryGB * BYTES_PER_KB * BYTES_PER_MB * DEVICE_MEMORY_HEAP_RATIO;
    return {
      usedJSHeapSize: 0, // Unknown without performance.memory
      totalJSHeapSize: 0,
      jsHeapSizeLimit,
      usagePercentage: 0, // Cannot determine without actual measurement
      deviceMemoryGB,
    };
  }

  return null;
}
