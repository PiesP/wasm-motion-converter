/**
 * Memory monitoring utilities for tracking browser memory usage during conversions
 */

interface MemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
  usagePercentage: number;
}

/**
 * Get current memory usage information (Chrome/Edge only)
 * Returns null if performance.memory is not available
 */
function getMemoryInfo(): MemoryInfo | null {
  // @ts-expect-error - performance.memory is non-standard but available in Chrome/Edge
  const memory = performance.memory;

  if (!memory) {
    return null;
  }

  const usedJSHeapSize = memory.usedJSHeapSize;
  const totalJSHeapSize = memory.totalJSHeapSize;
  const jsHeapSizeLimit = memory.jsHeapSizeLimit;
  const usagePercentage = (usedJSHeapSize / jsHeapSizeLimit) * 100;

  return {
    usedJSHeapSize,
    totalJSHeapSize,
    jsHeapSizeLimit,
    usagePercentage,
  };
}

/**
 * Check if memory usage is at a critical level (>80%)
 */
export function isMemoryCritical(): boolean {
  const memInfo = getMemoryInfo();
  if (!memInfo) {
    return false;
  }
  return memInfo.usagePercentage > 80;
}
