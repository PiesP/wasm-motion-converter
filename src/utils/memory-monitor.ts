/**
 * Memory monitoring utilities for tracking browser memory usage during conversions.
 *
 * Provides basic memory status detection and conservative available-memory estimation.
 * Uses `performance.memory` (Chrome/Edge) when available, with fallbacks for other
 * browsers via `navigator.deviceMemory` and conservative defaults.
 */

interface MemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
  usagePercentage: number;
}

// Thresholds for memory warning levels
const MEMORY_CRITICAL_THRESHOLD = 80; // 80% - critical

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
  // Primary: performance.memory (Chrome/Edge)
  // @ts-expect-error - performance.memory is non-standard but available in Chrome/Edge
  const memory = performance.memory as
    | { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
    | undefined;

  if (memory) {
    const usedJsHeapSize = memory.usedJSHeapSize;
    const totalJsHeapSize = memory.totalJSHeapSize;
    const jsHeapSizeLimit = memory.jsHeapSizeLimit;
    const usagePercentage = (usedJsHeapSize / jsHeapSizeLimit) * 100;

    return {
      usedJsHeapSize,
      totalJsHeapSize,
      jsHeapSizeLimit,
      usagePercentage,
    };
  }

  // Fallback: navigator.deviceMemory (Chrome/Edge/Safari — returns GB)
  const deviceMemoryGB = (
    navigator as Navigator & { deviceMemory?: number }
  ).deviceMemory;
  if (typeof deviceMemoryGB === 'number' && deviceMemoryGB > 0) {
    const jsHeapSizeLimit = deviceMemoryGB * 1024 * 1024 * 1024;
    // Assume ~40% heap usage when we cannot measure it directly
    const assumedUsage = jsHeapSizeLimit * 0.4;
    const usagePercentage = 40;

    return {
      usedJSHeapSize: assumedUsage,
      totalJSHeapSize: assumedUsage,
      jsHeapSizeLimit,
      usagePercentage,
    };
  }

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
    return false;
  }
  return memInfo.usagePercentage > MEMORY_CRITICAL_THRESHOLD;
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
    // Return actual available memory
    return memInfo.jsHeapSizeLimit - memInfo.usedJSHeapSize;
  }

  // Conservative estimate: assume 4GB limit with 40% already used
  const conservativeLimit = 4 * 1024 * 1024 * 1024; // 4GB
  const assumedUsage = conservativeLimit * 0.4; // 40% used
  return conservativeLimit - assumedUsage;
}
