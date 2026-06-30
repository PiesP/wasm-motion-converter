// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { ConversionFormat } from '@t/conversion-types';

import {
  MEMORY_CRITICAL_RATIO,
  MEMORY_CRITICAL_THRESHOLD,
  MEMORY_DEFAULT_AVAILABLE_MB,
  MEMORY_WARNING_RATIO,
} from './constants.js';

/**
 * Memory monitoring utilities for tracking browser memory usage during conversions.
 */

export interface MemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
  usagePercentage: number;
  deviceMemoryGB?: number;
}

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
    const jsHeapSizeLimit = deviceMemoryGB * 1024 * 1024 * 1024 * 0.25;
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
 * Estimate peak memory usage for a conversion (in MB).
 *
 * Formula: raw RGB frames + encoded output + decoder overhead
 * - Each frame: width * height * 3 bytes (RGB)
 * - Peak = all decoded frames in flight + encoder output
 * - Decoder typically holds ~5-10 frames in flight
 *
 * @param width - Output width in pixels
 * @param height - Output height in pixels
 *
 * @param totalFrames - Total number of frames after decimation
 * @param format - Output format (gif uses more memory for palette)
 * @returns Estimated peak memory in MB
 */
function estimatePeakMemoryMB(
  width: number,
  height: number,
  totalFrames: number,
  format: ConversionFormat
): number {
  const bytesPerFrame = width * height * 3; // RGB
  // GIF: streaming encoder processes one frame at a time (~2 in flight)
  // WebP: frames streamed to encoder, ~10 frames in flight
  const inFlightFrames = format === 'gif' ? 2 : Math.min(10, totalFrames);
  const frameMemory = inFlightFrames * bytesPerFrame;
  // Encoder output buffer: ~20% of raw frame data for GIF, ~5% for WebP
  const outputRatio = format === 'gif' ? 0.2 : 0.05;
  const outputMemory = totalFrames * bytesPerFrame * outputRatio;
  // Decoder overhead: ~50MB
  const decoderOverhead = 50 * 1024 * 1024;
  const totalBytes = frameMemory + outputMemory + decoderOverhead;
  return Math.round(totalBytes / (1024 * 1024));
}

/**
 * Check if a conversion is likely to exceed available memory.
 * Returns a warning level: 'ok' | 'warning' | 'critical'
 */
export function checkMemoryForConversion(
  width: number,
  height: number,
  totalFrames: number,
  format: 'gif' | 'webp'
): { level: 'ok' | 'warning' | 'critical'; estimatedMB: number; availableMB: number } {
  const estimatedMB = estimatePeakMemoryMB(width, height, totalFrames, format);
  const memInfo = getMemoryInfo();
  const availableMB = memInfo
    ? Math.round((memInfo.jsHeapSizeLimit - memInfo.usedJSHeapSize) / (1024 * 1024))
    : MEMORY_DEFAULT_AVAILABLE_MB;

  if (estimatedMB > availableMB * MEMORY_CRITICAL_RATIO) {
    return { level: 'critical', estimatedMB, availableMB };
  }
  if (estimatedMB > availableMB * MEMORY_WARNING_RATIO) {
    return { level: 'warning', estimatedMB, availableMB };
  }
  return { level: 'ok', estimatedMB, availableMB };
}
