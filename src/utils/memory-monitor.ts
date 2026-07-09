// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { ConversionFormat } from '@t/conversion-types';
import {
  BYTES_PER_KB,
  BYTES_PER_MB,
  MEMORY_CRITICAL_RATIO,
  MEMORY_CRITICAL_THRESHOLD,
  MEMORY_DEFAULT_AVAILABLE_MB,
  MEMORY_WARNING_RATIO,
} from './constants.js';
import { getMemoryInfo as getRawMemoryInfo } from './memory-info.js';

/**
 * Memory monitoring utilities for tracking browser memory usage during conversions.
 *
 * Wraps memory-info.ts with additional convenience functions
 * (isMemoryCritical, getMemoryUsageMB, checkMemoryForConversion).
 * The underlying raw memory access is owned by memory-info.ts.
 */

export type { MemoryInfo } from './memory-info.js';

/**
 * Get current JS heap memory info.
 * Delegates to memory-info.ts (the SSOT for performance.memory access).
 */
export function getMemoryInfo(): import('./memory-info').MemoryInfo | null {
  return getRawMemoryInfo();
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
  return Math.round(memInfo.usedJSHeapSize / BYTES_PER_MB);
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
  const decoderOverhead = 50 * BYTES_PER_MB;
  const totalBytes = frameMemory + outputMemory + decoderOverhead;
  return Math.round(totalBytes / BYTES_PER_MB);
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
    ? Math.round((memInfo.jsHeapSizeLimit - memInfo.usedJSHeapSize) / BYTES_PER_MB)
    : MEMORY_DEFAULT_AVAILABLE_MB;

  if (estimatedMB > availableMB * MEMORY_CRITICAL_RATIO) {
    return { level: 'critical', estimatedMB, availableMB };
  }
  if (estimatedMB > availableMB * MEMORY_WARNING_RATIO) {
    return { level: 'warning', estimatedMB, availableMB };
  }
  return { level: 'ok', estimatedMB, availableMB };
}
