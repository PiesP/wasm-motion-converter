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

import type { ConversionQuality, SmartFrameSkipMode } from '@t/conversion-types';

/** Base options shared by all format encoders */
export interface BaseEncoderOptions {
  width: number;
  height: number;
  quality: ConversionQuality;
  scale: number;
  /** Frame decimation: keep every Nth frame (1 = keep all) */
  frameDecimation?: number;
  /** Callback fired after each frame is decoded */
  onFrameDecoded?: (frameIndex: number, totalFrames: number) => void;
  /**
   * Callback fired after each frame is encoded.
   * @note Currently only used by the GIF encoder; WebP does not invoke this.
   */
  onFrameEncoded?: (frameIndex: number, totalFrames: number) => void;
  /** Smart frame skip mode — similarity-based frame deduplication */
  smartFrameSkip?: SmartFrameSkipMode;
}

/**
 * Calculate auto-decimation ratio based on source/target FPS and scale.
 *
 * Decimation reduces the number of frames sent to the encoder, which directly
 * impacts output file size and processing time. The strategy is:
 *
 * 1. **FPS-based decimation** (`baseDecimation`): If the source FPS exceeds the
 *    target FPS, decimate to approximately match the target. E.g., 60fps → 15fps
 *    yields `baseDecimation = 4` (keep every 4th frame).
 *
 * 2. **Scale-based boost** (`scaleBoost`): At larger output scales, each frame
 *    occupies more bytes in the output. A full-scale (1.0x) encoded frame is
 *    roughly 4x the data of a 0.5x frame. To compensate and keep output sizes
 *    manageable, we apply MORE aggressive decimation at larger scales:
 *    - scale >= 1.0 → boost = 4 (e.g., 30fps source → effective 7.5fps output)
 *    - 0.5 < scale < 1.0 → boost = 2 (moderate decimation increase)
 *    - scale <= 0.5 → boost = 1 (no additional decimation; output is already small)
 *
 * The boosted decimation is multiplicative: `baseDecimation * scaleBoost`.
 * This prioritizes usability (conversion completes in reasonable time) over
 * frame fidelity at large scales, where users typically expect faster results.
 *
 * @param sourceFps - Source video frame rate
 * @param targetFps - Desired output frame rate
 * @param scale - Output scale factor (e.g., 1.0 = full resolution)
 * @param forceDecimation - Override all calculations (used for memory-pressure forced decimation)
 * @returns Frame decimation factor (1 = keep every frame, N = keep every Nth frame)
 */
export function calcAutoDecimation(
  sourceFps: number,
  targetFps: number,
  scale: number,
  forceDecimation?: number
): number {
  if (forceDecimation !== undefined) return forceDecimation;
  const baseDecimation = sourceFps > targetFps ? Math.max(1, Math.round(sourceFps / targetFps)) : 1;
  // Scale boost: larger output scales need more decimation to keep
  // file sizes and encoding time reasonable (see JSDoc rationale above).
  const scaleBoost = scale >= 1.0 ? 4 : scale > 0.5 ? 2 : 1;
  return baseDecimation * scaleBoost;
}
