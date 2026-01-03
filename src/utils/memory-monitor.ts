/**
 * Memory monitoring utilities for tracking browser memory usage during conversions
 */

export interface MemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
  usagePercentage: number;
}

/**
 * Get current memory usage information (Chrome/Edge only)
 * Returns null if performance.memory is not available
 */
export function getMemoryInfo(): MemoryInfo | null {
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

/**
 * Check if memory usage is high (>60%)
 */
export function isMemoryHigh(): boolean {
  const memInfo = getMemoryInfo();
  if (!memInfo) {
    return false;
  }
  return memInfo.usagePercentage > 60;
}

/**
 * Format memory size in human-readable format
 */
export function formatMemorySize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  const gb = mb / 1024;

  if (gb >= 1) {
    return `${gb.toFixed(2)} GB`;
  }
  return `${mb.toFixed(2)} MB`;
}

/**
 * Log current memory usage to console
 */
export function logMemoryUsage(context: string): void {
  const memInfo = getMemoryInfo();
  if (!memInfo) {
    console.log(`[Memory Monitor] ${context}: Memory API not available`);
    return;
  }

  console.log(`[Memory Monitor] ${context}:`, {
    used: formatMemorySize(memInfo.usedJSHeapSize),
    total: formatMemorySize(memInfo.totalJSHeapSize),
    limit: formatMemorySize(memInfo.jsHeapSizeLimit),
    usagePercentage: `${memInfo.usagePercentage.toFixed(1)}%`,
  });
}
