/**
 * Memory monitoring utilities for tracking browser memory usage during conversions
 */

export type MemoryWarningLevel = 'safe' | 'warning' | 'critical';

interface MemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
  usagePercentage: number;
}

interface MemoryEstimate {
  estimated: boolean;
  usagePercentage: number;
  reason?: string;
}

// Thresholds for memory warning levels
const MEMORY_WARNING_THRESHOLD = 60; // 60% - show warning
const MEMORY_CRITICAL_THRESHOLD = 80; // 80% - critical

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
 * Estimate memory usage based on video characteristics
 * Used as fallback for browsers without performance.memory API
 */
function estimateMemoryUsage(videoSize: number, duration: number, resolution: number): MemoryEstimate {
  // Heuristic: estimate memory usage based on video characteristics
  // Typical conversion uses 5-10x the input file size in memory
  const estimatedMemoryUsage = videoSize * 7;

  // Assume a conservative heap limit of 4GB for most modern browsers
  const assumedHeapLimit = 4 * 1024 * 1024 * 1024;
  const estimatedPercentage = (estimatedMemoryUsage / assumedHeapLimit) * 100;

  // Additional factors that increase memory usage
  let multiplier = 1.0;
  if (resolution > 1920 * 1080) multiplier += 0.3; // 4K video
  if (duration > 30) multiplier += 0.2; // Long video

  return {
    estimated: true,
    usagePercentage: Math.min(estimatedPercentage * multiplier, 95),
    reason: 'Fallback estimation (performance.memory unavailable)',
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
  return memInfo.usagePercentage > MEMORY_CRITICAL_THRESHOLD;
}

/**
 * Get memory warning level with optional fallback estimation
 */
export function getMemoryWarningLevel(
  videoSize?: number,
  duration?: number,
  resolution?: number
): MemoryWarningLevel {
  const memInfo = getMemoryInfo();

  let usagePercentage: number;

  if (memInfo) {
    usagePercentage = memInfo.usagePercentage;
  } else if (videoSize && duration && resolution) {
    // Fallback estimation for browsers without performance.memory
    const estimate = estimateMemoryUsage(videoSize, duration, resolution);
    usagePercentage = estimate.usagePercentage;
  } else {
    // No memory info available and no video characteristics provided
    // Assume safe to avoid false alarms
    return 'safe';
  }

  if (usagePercentage > MEMORY_CRITICAL_THRESHOLD) {
    return 'critical';
  }
  if (usagePercentage > MEMORY_WARNING_THRESHOLD) {
    return 'warning';
  }
  return 'safe';
}

/**
 * Get detailed memory status including estimates for non-Chrome browsers
 */
export function getMemoryStatus(
  videoSize?: number,
  duration?: number,
  resolution?: number
): {
  level: MemoryWarningLevel;
  percentage: number;
  isEstimated: boolean;
} {
  const memInfo = getMemoryInfo();

  if (memInfo) {
    return {
      level: getMemoryWarningLevel(),
      percentage: memInfo.usagePercentage,
      isEstimated: false,
    };
  }

  if (videoSize && duration && resolution) {
    const estimate = estimateMemoryUsage(videoSize, duration, resolution);
    return {
      level: getMemoryWarningLevel(videoSize, duration, resolution),
      percentage: estimate.usagePercentage,
      isEstimated: true,
    };
  }

  return {
    level: 'safe',
    percentage: 0,
    isEstimated: true,
  };
}
