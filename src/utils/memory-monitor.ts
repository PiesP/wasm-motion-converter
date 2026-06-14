// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Memory monitoring utilities for tracking browser memory usage during conversions.
 *
 * Provides basic memory status detection and conservative available-memory estimation.
 * Uses `performance.memory` (Chrome/Edge) when available, with fallbacks for other
 * browsers via `navigator.deviceMemory` and conservative defaults.
 *
 * Firefox notes:
 * - `performance.memory` is not available → falls back to `navigator.deviceMemory`
 * - `navigator.deviceMemory` may return 0 or be unavailable → falls back to 4GB default
 * - Decoded frame memory is tracked separately via trackDecodedFrame() / releaseDecodedFrame()
 */

interface MemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
  usagePercentage: number;
  /** Device memory hint from navigator.deviceMemory (GB), if available */
  deviceMemoryGB?: number;
  /** Estimated decoded frame memory (bytes), tracked separately */
  decodedFrameBytes?: number;
}

// Thresholds for memory warning levels
const MEMORY_CRITICAL_THRESHOLD = 80; // 80% - critical

// Tracked decoded frame memory (bytes) — updated by WebCodecs decoder
let trackedDecodedFrameBytes = 0;

/**
 * Track decoded frame memory for accurate memory pressure estimation.
 * Called by WebCodecs decoder when a frame is decoded.
 *
 * @param bytes - Frame memory size in bytes (width × height × 4 for RGBA)
 */
export function trackDecodedFrame(bytes: number): void {
  if (bytes > 0) {
    trackedDecodedFrameBytes += bytes;
  }
}

/**
 * Release tracked decoded frame memory.
 * Called by WebCodecs decoder when a frame is closed/released.
 *
 * @param bytes - Frame memory size in bytes to release
 */
export function releaseDecodedFrame(bytes: number): void {
  trackedDecodedFrameBytes = Math.max(0, trackedDecodedFrameBytes - bytes);
}

/**
 * Reset all tracked decoded frame memory.
 * Called when conversion is cancelled or completed.
 */
export function resetTrackedFrames(): void {
  trackedDecodedFrameBytes = 0;
}

/**
 * Get current tracked decoded frame memory.
 *
 * @returns Tracked frame memory in bytes
 */
export function getTrackedFrameBytes(): number {
  return trackedDecodedFrameBytes;
}

/**
 * Get current memory usage information.
 *
 * Prefers `performance.memory` (Chrome/Edge). When unavailable, estimates from
 * `navigator.deviceMemory` (Chrome/Edge/Safari) or falls back to a conservative
 * default so that memory-aware decisions still work on Firefox and other browsers.
 *
 * @returns Memory info object or null when no data is available at all
 */
function getMemoryInfo(): MemoryInfo | null {
  // Primary: performance.memory (Chrome/Edge, non-standard)
  if ('memory' in performance && performance.memory) {
    const memory = performance.memory as {
      usedJSHeapSize: number;
      totalJSHeapSize: number;
      jsHeapSizeLimit: number;
    };

    const usedJSHeapSize = memory.usedJSHeapSize;
    const totalJSHeapSize = memory.totalJSHeapSize;
    const jsHeapSizeLimit = memory.jsHeapSizeLimit;
    const usagePercentage = (usedJSHeapSize / jsHeapSizeLimit) * 100;
    const deviceMemoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;

    return {
      usedJSHeapSize,
      totalJSHeapSize,
      jsHeapSizeLimit,
      usagePercentage,
      deviceMemoryGB: typeof deviceMemoryGB === 'number' ? deviceMemoryGB : undefined,
      decodedFrameBytes: trackedDecodedFrameBytes,
    };
  }

  // Fallback: navigator.deviceMemory (Chrome/Edge/Safari/Firefox — returns GB)
  const deviceMemoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof deviceMemoryGB === 'number' && deviceMemoryGB > 0) {
    const jsHeapSizeLimit = deviceMemoryGB * 1024 * 1024 * 1024;
    // Conservative: assume 50% heap usage when we cannot measure it directly
    const assumedUsage = jsHeapSizeLimit * 0.5;
    const usagePercentage = 50;

    return {
      usedJSHeapSize: assumedUsage,
      totalJSHeapSize: assumedUsage,
      jsHeapSizeLimit,
      usagePercentage,
      deviceMemoryGB,
      decodedFrameBytes: trackedDecodedFrameBytes,
    };
  }

  // No APIs available: return null so callers can use conservative defaults
  return null;
}

/**
 * Check if memory usage is at a critical level (>80%).
 *
 * On browsers without `performance.memory`, uses `navigator.deviceMemory`
 * as a rough signal. When neither API is available, returns false (unknown).
 *
 * @returns True if heap usage exceeds critical threshold
 *
 * @example
 * if (isMemoryCritical()) {
 *   logger.warn('performance', 'Memory is running out; conversion may fail');
 * }
 */
export function isMemoryCritical(): boolean {
  const memInfo = getMemoryInfo();
  if (!memInfo) {
    // ponytail: Firefox — no performance.memory or navigator.deviceMemory available.
    // Use tracked decoded frame bytes as a soft signal with a 2 GB soft limit.
    if (trackedDecodedFrameBytes > 2_147_483_648) return true; // 2 GB soft limit
    return false;
  }

  // Include decoded frame memory in the critical check
  const totalUsed = memInfo.usedJSHeapSize + (memInfo.decodedFrameBytes ?? 0);
  const effectivePercentage = (totalUsed / memInfo.jsHeapSizeLimit) * 100;
  return effectivePercentage > MEMORY_CRITICAL_THRESHOLD;
}

/**
 * Get available memory in bytes.
 *
 * Returns remaining heap space (limit - used) when `performance.memory` is
 * available, an estimate from `navigator.deviceMemory`, or a conservative
 * default (4GB limit, 40% assumed usage) for browsers with neither API.
 *
 * @returns Available memory in bytes
 *
 * @example
 * const available = getAvailableMemory();
 * const needed = 100_000_000; // 100 MB
 * if (available < needed) {
 *   logger.warn('performance', 'Insufficient memory available', { available, needed });
 * }
 */
export function getAvailableMemory(): number {
  const memInfo = getMemoryInfo();

  if (memInfo) {
    // Return actual available memory minus decoded frame estimate
    const heapAvailable = memInfo.jsHeapSizeLimit - memInfo.usedJSHeapSize;
    const decodedFrames = memInfo.decodedFrameBytes ?? 0;
    return Math.max(0, heapAvailable - decodedFrames);
  }

  // When neither performance.memory nor navigator.deviceMemory is available,
  // fall back to a conservative 4GB limit with 40% assumed usage (→ 2.4GB available).
  const deviceMemoryGB = (navigator as { deviceMemory?: number }).deviceMemory;
  const fallbackLimit =
    typeof deviceMemoryGB === 'number' && deviceMemoryGB > 0
      ? deviceMemoryGB * 1024 * 1024 * 1024
      : 4 * 1024 * 1024 * 1024;
  const assumedUsage = fallbackLimit * 0.4;
  return Math.max(0, fallbackLimit - assumedUsage);
}
