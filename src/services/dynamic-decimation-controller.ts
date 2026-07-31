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
 *                      null if memory info is unavailable. Defaults to calling
 *                      getMemoryInfo() from memory-monitor, which accesses
 *                      Chrome-only performance.memory. **Callers SHOULD provide
 *                      their own check function** (e.g. from memory-monitor or
 *                      a worker-compatible alternative) to avoid coupling to
 *                      the browser API. Providing a custom check also makes
 *                      the controller testable without a real browser.
 */
export function createDynamicDecimationController(
  memoryCheck?: () => DecimationMemoryInfo | null
): DynamicDecimationController {
  type SkipPolicy = 'none' | 'sustained' | 'critical';

  let actualSkipCount = 0;
  let policyFrameCount = 0;
  let consecutiveMemWarnings = 0;
  let policy: SkipPolicy = 'none';
  let usagePercentage = 0;

  const checkMemory =
    memoryCheck ??
    (() => {
      const info = getMemoryInfo();
      return info ? { usagePercentage: info.usagePercentage } : null;
    });

  function setPolicy(nextPolicy: SkipPolicy): void {
    if (policy !== nextPolicy) {
      policy = nextPolicy;
      policyFrameCount = 0;
    }
  }

  function shouldSkip(frameNum: number): boolean {
    // Sampling is intentionally sparse, but an active skip policy applies to
    // every frame until the next sample changes it.
    if (frameNum % 5 === 0) {
      const memInfo = checkMemory();
      usagePercentage = memInfo?.usagePercentage ?? 0;

      if (!memInfo || usagePercentage <= DYNAMIC_DECIMATION_MEM_THRESHOLD) {
        consecutiveMemWarnings = 0;
        setPolicy('none');
      } else {
        consecutiveMemWarnings++;
        if (usagePercentage > DYNAMIC_DECIMATION_MEM_CRITICAL) {
          setPolicy('critical');
        } else if (consecutiveMemWarnings >= 3) {
          setPolicy('sustained');
        } else {
          setPolicy('none');
        }
      }
    }

    // Always retain the first frame so short conversions produce a visible
    // result even when the heap is already under pressure.
    if (frameNum === 0 || policy === 'none') return false;

    const divisor = policy === 'critical' ? 2 : 3;
    const skip = policyFrameCount % divisor === 0;
    policyFrameCount++;
    if (!skip) return false;

    actualSkipCount++;
    if (policy === 'critical') {
      logger.warn('encoders', 'Critical memory pressure, dynamic frame skip', {
        usagePct: Math.round(usagePercentage),
        frameNum,
        policyFrameCount,
        actualSkipCount,
      });
    } else {
      logger.info('encoders', 'Sustained memory pressure, dynamic frame skip', {
        usagePct: Math.round(usagePercentage),
        frameNum,
        policyFrameCount,
        actualSkipCount,
      });
    }
    return true;
  }

  function getSkipCount(): number {
    return actualSkipCount;
  }

  return { shouldSkip, getSkipCount };
}
