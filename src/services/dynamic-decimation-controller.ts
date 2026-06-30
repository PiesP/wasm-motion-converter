// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Dynamic Decimation Controller
 *
 * Shared utility for GIF and WebP encoders that monitors JS heap usage
 * and dynamically skips frames when memory pressure exceeds thresholds.
 *
 * Thresholds:
 *   - MEM_THRESHOLD (70%): monitoring activates, consecutive warnings tracked
 *   - MEM_CRITICAL (85%): aggressive skip (every other frame)
 *   - Sustained pressure (≥3 consecutive warnings above threshold): skip every 3rd frame
 */

import { logger } from '@utils/logger';
import { getMemoryInfo } from '@utils/memory-monitor';

/** Memory threshold for dynamic decimation (percentage of JS heap limit) */
export const DYNAMIC_DECIMATION_MEM_THRESHOLD = 70;
export const DYNAMIC_DECIMATION_MEM_CRITICAL = 85;

export interface DynamicDecimationController {
  /** Returns true if the given frame should be skipped due to memory pressure */
  shouldSkip(frameNum: number): boolean;
  /** Returns the total number of additional frames skipped due to memory pressure */
  getSkipCount(): number;
}

export interface DecimationMemoryInfo {
  usagePercentage: number;
}

/**
 * Creates a DynamicDecimationController that monitors memory and skips frames
 * under pressure. Reusable across any encoder that needs memory-adaptive frame
 * skipping.
 *
 * @param memoryCheck - Function returning current memory usage percentage, or
 *                      null if memory info is unavailable. Defaults to
 *                      performance.memory-based check.
 */
export function createDynamicDecimationController(
  memoryCheck?: () => DecimationMemoryInfo | null
): DynamicDecimationController {
  let actualSkipCount = 0;
  let dynamicSkipCount = 0;
  let consecutiveMemWarnings = 0;
  let cachedFrameNum = -1;
  let cachedMemInfo: DecimationMemoryInfo | null = null;

  const checkMemory =
    memoryCheck ??
    (() => {
      const info = getMemoryInfo();
      return info ? { usagePercentage: info.usagePercentage } : null;
    });

  function shouldSkip(frameNum: number): boolean {
    // Check JS heap usage every 5 frames to avoid per-frame overhead
    if (frameNum % 5 !== 0) return false;

    // Cache memory result within the same 5-frame window
    if (frameNum !== cachedFrameNum) {
      cachedFrameNum = frameNum;
      cachedMemInfo = checkMemory();
    }

    const memInfo = cachedMemInfo;
    if (!memInfo || memInfo.usagePercentage <= DYNAMIC_DECIMATION_MEM_THRESHOLD) {
      consecutiveMemWarnings = 0;
      return false;
    }

    consecutiveMemWarnings++;

    if (memInfo.usagePercentage > DYNAMIC_DECIMATION_MEM_CRITICAL) {
      // Critical: skip every other frame (aggressive)
      const skip = dynamicSkipCount % 2 === 0;
      dynamicSkipCount++;
      if (skip) {
        actualSkipCount++;
      }
      logger.warn('encoders', 'Critical memory pressure, dynamic frame skip', {
        usagePct: Math.round(memInfo.usagePercentage),
        frameNum,
        dynamicSkipCount,
        actualSkipCount,
      });
      return skip;
    }

    if (consecutiveMemWarnings >= 3) {
      // Sustained pressure: skip every 3rd frame
      const skip = dynamicSkipCount % 3 === 0;
      dynamicSkipCount++;
      if (skip) {
        actualSkipCount++;
      }
      logger.info('encoders', 'Sustained memory pressure, dynamic frame skip', {
        usagePct: Math.round(memInfo.usagePercentage),
        frameNum,
        dynamicSkipCount,
        actualSkipCount,
      });
      return skip;
    }

    return false;
  }

  function getSkipCount(): number {
    return actualSkipCount;
  }

  return { shouldSkip, getSkipCount };
}
