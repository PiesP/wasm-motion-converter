// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Common encoder types and utilities for the conversion pipeline.
 *
 * Shared between GIF and WebP encoders to avoid duplication:
 * - EncoderOptions base interface
 * - Frame decimation calculation
 * - Progress callback types
 */

import type { SmartFrameSkipMode } from '@t/conversion-types';
import { FPS_CLAMP_MAX, MEMORY_PRESSURE_TARGET_FPS, MIN_OUTPUT_FPS } from '@utils/constants';

/** Base options shared by all format encoders */
export interface BaseEncoderOptions {
  width: number;
  height: number;
  quality: import('@t/conversion-types').ConversionQuality;
  scale: number;
  /** Frame decimation: keep every Nth frame (1 = keep all) */
  frameDecimation?: number | undefined;
  /** Callback fired after each frame is decoded */
  onFrameDecoded?: ((frameIndex: number, totalFrames: number) => void) | undefined;
  /**
   * Callback fired after each frame is encoded.
   * @note Currently only used by the GIF encoder; WebP does not invoke this.
   */
  onFrameEncoded?: ((frameIndex: number, totalFrames: number) => void) | undefined;
  /** Smart frame skip mode — similarity-based frame deduplication */
  smartFrameSkip?: SmartFrameSkipMode | undefined;
}

/**
 * Calculate frame decimation ratio from source FPS to target FPS.
 *
 * Decimation reduces the number of frames sent to the encoder, which directly
 * impacts output file size, conversion time, and motion smoothness.
 *
 * The formula is simple: `decimation = round(sourceFps / targetFps)`,
 * clamped to ensure output never drops below MIN_OUTPUT_FPS (3fps).
 *
 * Scale no longer affects frame rate. Resolution and frame rate are separate
 * quality axes — the user's scale choice controls output dimensions, while
 * quality (passed as targetFps by the caller) controls frame rate.
 *
 * Example (60fps source):
 *   targetFps=8  (GIF low)    → decimation=8  → output ~7.5fps
 *   targetFps=12 (GIF medium) → decimation=5  → output ~12fps
 *   targetFps=20 (GIF high)   → decimation=3  → output ~20fps
 *   targetFps=30 (WebP high) → decimation=2 → output ~30fps
 *
 * @param sourceFps - Source video frame rate
 * @param targetFps - Desired output frame rate (from a format-specific target FPS map)
 * @param forceDecimation - Override all calculations (used for memory-pressure forced decimation)
 * @returns Frame decimation factor (1 = keep every frame, N = keep every Nth frame)
 */
export function calcAutoDecimation(
  sourceFps: number,
  targetFps: number,
  forceDecimation?: number
): number {
  if (forceDecimation !== undefined && Number.isFinite(forceDecimation) && forceDecimation > 0) {
    return Math.max(1, Math.round(forceDecimation));
  }

  // Guard against unreliable fps detection: clamp to reasonable range
  const clampedFps =
    Number.isFinite(sourceFps) && sourceFps > 0
      ? Math.max(1, Math.min(sourceFps, FPS_CLAMP_MAX))
      : 1;
  const safeTargetFps = Number.isFinite(targetFps) && targetFps > 0 ? targetFps : clampedFps;

  // Base decimation: keep every Nth frame to approximately match target FPS
  const baseDecimation =
    clampedFps > safeTargetFps ? Math.max(1, Math.round(clampedFps / safeTargetFps)) : 1;

  // MIN_OUTPUT_FPS guard: ensure output never drops below the floor.
  // E.g., 120fps source with 8fps target → decimation=15 → output=8fps ✓
  //       120fps source with 5fps target (hypothetical) → decimation=24 → output=5fps ✓
  //       60fps source with 8fps target → decimation=8 → output=7.5fps ✓
  const outputFps = clampedFps / baseDecimation;
  if (outputFps < MIN_OUTPUT_FPS) {
    // Recalculate: use floor to keep output at or above MIN_OUTPUT_FPS
    return Math.max(1, Math.floor(clampedFps / MIN_OUTPUT_FPS));
  }

  return baseDecimation;
}

/**
 * Combine the selected quality preset with the critical-memory target without
 * ever keeping more frames than the preset already requested.
 */
export function calcMemoryPressureDecimation(sourceFps: number, targetFps: number): number {
  return Math.max(
    calcAutoDecimation(sourceFps, targetFps),
    calcAutoDecimation(sourceFps, MEMORY_PRESSURE_TARGET_FPS)
  );
}
