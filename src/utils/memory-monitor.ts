/**
 * Memory monitoring utilities for tracking browser memory usage during conversions.
 *
 * Provides basic memory status detection and conservative available-memory estimation.
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
 * Get current memory usage information (Chrome/Edge only).
 * Returns null if performance.memory is not available.
 *
 * @returns Memory info object or null for unsupported browsers
 */
function getMemoryInfo(): MemoryInfo | null {
  // @ts-expect-error - performance.memory is non-standard but available in Chrome/Edge
  const memory = performance.memory;

  if (!memory) {
    return null;
  }

  const usedJsHeapSize = memory.usedJSHeapSize;
  const totalJsHeapSize = memory.totalJSHeapSize;
  const jsHeapSizeLimit = memory.jsHeapSizeLimit;
  const usagePercentage = (usedJsHeapSize / jsHeapSizeLimit) * 100;

  return {
    usedJSHeapSize: usedJsHeapSize,
    totalJSHeapSize: totalJsHeapSize,
    jsHeapSizeLimit,
    usagePercentage,
  };
}

/**
 * Check if memory usage is at a critical level (>80%).
 *
 * @returns True if heap usage exceeds critical threshold
 *
 * @example
 * if (isMemoryCritical()) {
 *   console.warn('Memory is running out, conversion may fail');
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
 * Returns remaining heap space (limit - used) or conservative estimate.
 *
 * @returns Available memory in bytes
 *
 * @example
 * const available = getAvailableMemory();
 * const needed = 100_000_000; // 100 MB
 * if (available < needed) {
 *   console.warn('Insufficient memory available');
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
