// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Output Size Estimation
 *
 * Heuristic-based output size estimation for GIF, Animated WebP, and Animated AVIF.
 * Used to warn users before conversion and for memory planning.
 *
 * All estimates are conservative (upper-bound) to avoid surprises.
 * Actual sizes are typically 10-25% smaller.
 */

import type { ConversionFormat, ConversionQuality } from '@t/conversion-types';
import {
  AVIF_BPP_CONSERVATIVE,
  AVIF_OVERHEAD_PER_FRAME,
  GIF_BPP_CONSERVATIVE,
  GIF_PALETTE_OVERHEAD_PER_FRAME,
  WEBP_OVERHEAD_PER_FRAME,
} from './constants';
import { formatBytes } from './format-utils';

/**
 * Bytes-per-pixel (BPP) estimate for WebP lossy encoding at each quality level.
 *
 * Measured empirically on a 1080p H.264 video:
 *   - low (q=0.6): ~0.08-0.12 BPP
 *   - medium (q=0.75): ~0.15-0.2 BPP
 *   - high (q=0.85): ~0.25-0.35 BPP
 *
 * Using the upper end of each range as a conservative estimate.
 */
const WEBP_BPP: Record<ConversionQuality, number> = {
  low: 0.12,
  medium: 0.2,
  high: 0.35,
};

/**
 * Estimate GIF output size in bytes.
 *
 * Formula: pixelCount × BPP × frames + palette_overhead × frames
 *
 * @param width - Output width in pixels (after scaling)
 * @param height - Output height in pixels (after scaling)
 * @param totalFrames - Estimated number of frames after decimation
 * @returns Estimated GIF size in bytes
 */
export function estimateGifOutputSize(width: number, height: number, totalFrames: number): number {
  const pixelCount = width * height;
  const frameBytes = pixelCount * GIF_BPP_CONSERVATIVE + GIF_PALETTE_OVERHEAD_PER_FRAME;
  return Math.ceil(frameBytes * totalFrames);
}

/**
 * Estimate animated WebP output size in bytes.
 *
 * Formula: pixelCount × BPP(quality) × frames + overhead × frames
 * WebP is a keyframe-only encoder (no inter-frame compression) — this
 * estimate accounts for the higher per-frame bitrate.
 *
 * @param width - Output width in pixels (after scaling)
 * @param height - Output height in pixels (after scaling)
 * @param totalFrames - Estimated number of frames after decimation
 * @param quality - Conversion quality level
 * @returns Estimated WebP size in bytes
 */
export function estimateWebpOutputSize(
  width: number,
  height: number,
  totalFrames: number,
  quality: ConversionQuality
): number {
  const pixelCount = width * height;
  const bpp = WEBP_BPP[quality];
  const frameBytes = pixelCount * bpp + WEBP_OVERHEAD_PER_FRAME;
  return Math.ceil(frameBytes * totalFrames);
}

/** Estimate animated AVIF output size in bytes. */
export function estimateAvifOutputSize(
  width: number,
  height: number,
  totalFrames: number,
  quality: ConversionQuality
): number {
  const pixelCount = width * height;
  const frameBytes = pixelCount * AVIF_BPP_CONSERVATIVE[quality] + AVIF_OVERHEAD_PER_FRAME;
  return Math.ceil(frameBytes * totalFrames);
}

/**
 * Estimated output size with human-readable formatting.
 */
export interface OutputSizeEstimate {
  /** Estimated size in bytes */
  bytes: number;
  /** Human-readable size string (e.g. "12.5 MB") */
  formatted: string;
}

/**
 * Produce a formatted output size estimate.
 *
 * @example
 *   estimateOutputSize(960, 540, 150, 'high', 'gif')
 *   // → { bytes: 14019440, formatted: "13.4 MB" }
 */
export function estimateOutputSize(
  width: number,
  height: number,
  totalFrames: number,
  quality: ConversionQuality,
  format: ConversionFormat
): OutputSizeEstimate {
  const bytes =
    format === 'gif'
      ? estimateGifOutputSize(width, height, totalFrames)
      : format === 'avif'
        ? estimateAvifOutputSize(width, height, totalFrames, quality)
        : estimateWebpOutputSize(width, height, totalFrames, quality);

  return { bytes, formatted: formatBytes(bytes) };
}
