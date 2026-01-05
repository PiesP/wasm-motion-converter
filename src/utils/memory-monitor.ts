/**
 * Memory monitoring utilities for tracking browser memory usage during conversions
 */

import type { ConversionFormat, ConversionScale } from '../types/conversion-types';

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
function estimateMemoryUsage(
  videoSize: number,
  duration: number,
  resolution: number
): MemoryEstimate {
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

/**
 * Get available memory in bytes
 * Returns remaining heap space (limit - used) or conservative estimate
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

/**
 * Estimate memory requirements for a conversion
 *
 * @param fileSize - Input file size in bytes
 * @param format - Output format (GIF requires more memory for palette)
 * @param scale - Scale factor (smaller scale = less memory)
 * @returns Estimated memory usage in bytes
 */
export function estimateConversionMemory(
  fileSize: number,
  format: ConversionFormat,
  scale: ConversionScale
): number {
  // Base multiplier: video processing typically uses 5-7x file size
  let baseSizeMultiplier = 6;
  // Format-specific adjustments
  if (format === 'gif') {
    // GIF palette generation requires additional memory
    baseSizeMultiplier *= 1.5;
  }

  let memoryEstimate = fileSize * baseSizeMultiplier;

  // Scale adjustment: memory usage scales with pixel count (quadratic)
  // 50% scale = 25% pixel count = 25% memory
  const scaleMultiplier = scale * scale;
  memoryEstimate *= scaleMultiplier;

  return memoryEstimate;
}

/**
 * Check if a conversion will likely fit in available memory
 *
 * @param fileSize - Input file size in bytes
 * @param format - Output format
 * @param scale - Scale factor
 * @param safetyMargin - Safety margin percentage (default 0.6 = 60% threshold)
 * @returns Object with canFit boolean and recommended settings if needed
 */
export function checkConversionMemoryFit(
  fileSize: number,
  format: ConversionFormat,
  scale: ConversionScale,
  safetyMargin: number = 0.6
): {
  canFit: boolean;
  estimatedMemory: number;
  availableMemory: number;
  usagePercentage: number;
  recommendation?: {
    scale?: ConversionScale;
    quality?: 'low';
    message: string;
  };
} {
  const estimatedMemory = estimateConversionMemory(fileSize, format, scale);
  const availableMemory = getAvailableMemory();
  const usagePercentage = (estimatedMemory / availableMemory) * 100;

  const canFit = estimatedMemory <= availableMemory * safetyMargin;

  if (canFit) {
    return {
      canFit: true,
      estimatedMemory,
      availableMemory,
      usagePercentage,
    };
  }

  // Generate recommendation
  let recommendation: {
    scale?: ConversionScale;
    quality?: 'low';
    message: string;
  };

  // Try to find a scale that fits
  const scales: ConversionScale[] = [0.5, 0.75, 1.0];
  const currentScaleIndex = scales.indexOf(scale);

  if (currentScaleIndex > 0) {
    // Can downscale
    const recommendedScale = scales[currentScaleIndex - 1] as ConversionScale;
    recommendation = {
      scale: recommendedScale,
      quality: 'low',
      message: `Reduced to ${recommendedScale * 100}% scale and low quality to conserve memory`,
    };
  } else {
    // Already at lowest scale
    recommendation = {
      quality: 'low',
      message: 'Reduced to low quality to conserve memory (file may be too large)',
    };
  }

  return {
    canFit: false,
    estimatedMemory,
    availableMemory,
    usagePercentage,
    recommendation,
  };
}
