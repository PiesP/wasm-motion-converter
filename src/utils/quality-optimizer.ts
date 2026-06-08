// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import type { ConversionFormat, ConversionQuality } from '@t/conversion-types';
import { QUALITY_PRESETS } from './constants';

/**
 * Calculate optimal FPS based on source video FPS and quality preset
 *
 * Strategy:
 * - Don't exceed source FPS (wasteful - upsampling doesn't add quality)
 * - Don't go below preset FPS (maintains quality floor)
 * - Returns min(sourceFPS, presetFPS) for best balance
 *
 * Examples:
 * - 30 FPS source, high quality (30 FPS preset) → 30 FPS (perfect match)
 * - 10 FPS source, medium quality (20 FPS preset) → 10 FPS (no fake interpolation)
 * - 60 FPS source, high quality (30 FPS preset) → 30 FPS (reasonable downsampling)
 *
 * @param sourceFPS - Original video frame rate (must be > 0)
 * @param quality - Quality preset (low/medium/high)
 * @param format - Output format (gif/webp)
 * @returns Optimized FPS value between 1 and 60
 * @throws Error if sourceFPS is not a positive number
 *
 * @example
 * const fps = getOptimalFPS(30, 'high', 'gif'); // Returns 30
 * const fps = getOptimalFPS(10, 'medium', 'webp'); // Returns 10
 */
export function getOptimalFPS(
  sourceFps: number,
  quality: ConversionQuality,
  format: ConversionFormat
): number {
  // Validate input
  if (!Number.isFinite(sourceFps) || sourceFps <= 0) {
    throw new Error(`Invalid sourceFPS: ${sourceFps}. Must be a positive number.`);
  }

  // Get preset FPS for this quality/format combination
  // AVIF reuses WebP presets (same encoding characteristics)
  const presetFormat = format === 'avif' ? 'webp' : format;
  const preset = QUALITY_PRESETS[presetFormat][quality];
  const presetFps = 'fps' in preset ? preset.fps : 15;

  // Don't exceed source FPS (no point in upsampling frames)
  // Don't go below preset FPS (maintains quality baseline)
  const optimalFps = Math.min(sourceFps, presetFps);

  // Ensure we have a valid FPS (at least 1, at most 60)
  return Math.max(1, Math.min(60, Math.round(optimalFps)));
}
