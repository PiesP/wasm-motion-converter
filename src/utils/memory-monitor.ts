// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Memory monitoring utilities for tracking browser memory usage during conversions.
 */

export const MEMORY_CRITICAL_THRESHOLD = 80; // 80% - critical

export interface MemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
  usagePercentage: number;
  deviceMemoryGB?: number;
}

function getMemoryInfo(): MemoryInfo | null {
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
    const jsHeapSizeLimit = deviceMemoryGB * 1024 * 1024 * 1024;
    return {
      usedJSHeapSize: jsHeapSizeLimit * 0.5,
      totalJSHeapSize: jsHeapSizeLimit * 0.5,
      jsHeapSizeLimit,
      usagePercentage: 50,
      deviceMemoryGB,
    };
  }

  return null;
}

/**
 * Check if memory usage is at a critical level (>80%).
 */
export function isMemoryCritical(): boolean {
  const memInfo = getMemoryInfo();
  if (!memInfo) return false;
  return memInfo.usagePercentage > MEMORY_CRITICAL_THRESHOLD;
}

/**
 * Get current memory usage in MB. Returns null if unavailable.
 */
export function getMemoryUsageMB(): number | null {
  const memInfo = getMemoryInfo();
  if (!memInfo) return null;
  return Math.round(memInfo.usedJSHeapSize / (1024 * 1024));
}

/**
 * Get current memory usage as a formatted string (e.g. "128 MB / 512 MB (25%)").
 */
export function getMemoryUsageString(): string | null {
  const memInfo = getMemoryInfo();
  if (!memInfo) return null;
  const usedMB = Math.round(memInfo.usedJSHeapSize / (1024 * 1024));
  const totalMB = Math.round(memInfo.totalJSHeapSize / (1024 * 1024));
  return `${usedMB} MB / ${totalMB} MB (${Math.round(memInfo.usagePercentage)}%)`;
}
