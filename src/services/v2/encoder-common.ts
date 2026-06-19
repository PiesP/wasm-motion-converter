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
  /** Callback fired after each frame is encoded */
  onFrameEncoded?: (frameIndex: number, totalFrames: number) => void;
  /** Smart frame skip mode — similarity-based frame deduplication */
  smartFrameSkip?: SmartFrameSkipMode;
}

/** Calculate auto-decimation ratio based on source/target FPS and scale */
export function calcAutoDecimation(
  sourceFps: number,
  targetFps: number,
  scale: number,
  forceDecimation?: number
): number {
  if (forceDecimation !== undefined) return forceDecimation;
  const baseDecimation = sourceFps > targetFps ? Math.max(1, Math.round(sourceFps / targetFps)) : 1;
  const scaleBoost = scale >= 1.0 ? 4 : scale > 0.5 ? 2 : 1;
  return baseDecimation * scaleBoost;
}
