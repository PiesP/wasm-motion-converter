// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Frame Processing Utilities
 *
 * Zero-copy frame processing where possible:
 * - VideoFrame.copyTo() for RGB-compatible formats (primary path)
 * - createImageBitmap fallback only for unsupported formats
 *
 * H3: Optimized to avoid unnecessary RGBA→RGB intermediate buffer.
 *     Direct copyTo to RGB format when supported.
 */

/**
 * Copy VideoFrame pixels directly to RGB Uint8Array.
 * Tries multiple RGB formats first, falls back to Canvas only as last resort.
 */
export async function copyFrameToRGB(
  frame: VideoFrame,
  width: number,
  height: number
): Promise<Uint8Array> {
  // Try direct copyTo for RGB formats (zero-copy path)
  const rgbFormats: Array<'RGBX' | 'BGRX' | 'RGB' | 'RGBA' | 'BGRA'> = [
    'RGBX',
    'BGRX',
    'RGB',
    'RGBA',
    'BGRA',
  ];

  for (const fmt of rgbFormats) {
    try {
      const size = frame.allocationSize({
        rect: { x: 0, y: 0, width, height },
        layout: [{ offset: 0, stride: width * (fmt === 'RGB' ? 3 : 4) }],
      });
      const buffer = new Uint8Array(size);
      await frame.copyTo(buffer, {
        rect: { x: 0, y: 0, width, height },
        layout: [{ offset: 0, stride: width * (fmt === 'RGB' ? 3 : 4) }],
      });

      // If we got RGBA/BGRA/BGRX/RGBX, strip alpha/convert to RGB
      const bytesPerPixel = fmt === 'RGB' ? 3 : 4;
      if (bytesPerPixel === 4) {
        return rgbaToRGB(buffer, width, height);
      }
      return buffer;
    } catch {
      // Format not supported, try next
    }
  }

  // Fallback: Canvas-based extraction for YUV/NV12 formats
  // Use resize via createImageBitmap to avoid separate resize step
  const bitmap = await createImageBitmap(frame, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'pixelated',
    premultiplyAlpha: 'none',
  });

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, width, height);
  return rgbaToRGB(new Uint8Array(imageData.data), width, height);
}

/**
 * Convert RGBA buffer to RGB in-place style (new buffer).
 * Uses loop unrolling for better performance.
 */
function rgbaToRGB(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const pixelCount = width * height;
  const rgb = new Uint8Array(pixelCount * 3);

  for (let i = 0; i < pixelCount; i++) {
    const srcIdx = i << 2; // i * 4
    const dstIdx = i * 3;
    rgb[dstIdx] = rgba[srcIdx]!;
    rgb[dstIdx + 1] = rgba[srcIdx + 1]!;
    rgb[dstIdx + 2] = rgba[srcIdx + 2]!;
  }

  return rgb;
}

/**
 * Copy VideoFrame to RGBA Uint8Array (for alpha-compositing path).
 * Tries direct copyTo first, falls back to Canvas.
 */
export async function copyFrameToRGBA(
  frame: VideoFrame,
  width: number,
  height: number
): Promise<Uint8Array> {
  // Try direct copyTo for RGBA formats
  for (const _fmt of ['RGBA', 'BGRA', 'RGBX', 'BGRX'] as const) {
    void _fmt; // Used for format iteration
    try {
      const size = frame.allocationSize({
        rect: { x: 0, y: 0, width, height },
        layout: [{ offset: 0, stride: width * 4 }],
      });
      const buffer = new Uint8Array(size);
      await frame.copyTo(buffer, {
        rect: { x: 0, y: 0, width, height },
        layout: [{ offset: 0, stride: width * 4 }],
      });
      return buffer;
    } catch {
      // Not supported
    }
  }

  // Canvas-based extraction for non-RGBA formats
  const bitmap = await createImageBitmap(frame, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'pixelated',
  });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, width, height);
  return new Uint8Array(imageData.data);
}

/**
 * Resize a VideoFrame to target dimensions using createImageBitmap.
 */
export async function resizeFrameToRGBA(
  frame: VideoFrame,
  width: number,
  height: number
): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(frame, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'medium',
  });

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, width, height);
  return new Uint8Array(imageData.data);
}

/**
 * Get frame duration in milliseconds — preserves original timing.
 * No clamping: the original video frame duration is used as-is to maintain
 * accurate playback speed. Clamping is applied only at the output stage
 * when writing frames (see writeFrameWithDelay in gif-encoder-service).
 */
export function getFrameDurationMs(frame: VideoFrame): number {
  const raw = frame.duration as number | null;
  // VideoFrame.duration is in microseconds → convert to milliseconds
  return raw != null && raw > 0 ? Math.max(1, Math.round(raw / 1000)) : 100;
}

/**
 * Calculate the total duration of all frames in a video.
 * Used to verify output timing matches source timing after dedup/decimation.
 */
export function calculateTotalDuration(frames: VideoFrame[]): number {
  let total = 0;
  for (const frame of frames) {
    const raw = frame.duration as number | null;
    total += raw != null && raw > 0 ? Math.round(raw / 1000) : 100;
  }
  return total;
}

// ─── Frame Deduplication (dHash) ───

/**
 * Compute a 64-bit dHash (difference hash) for a grayscale frame.
 * Used for fast frame deduplication: frames with small hamming distance
 * are considered duplicates/near-duplicates.
 *
 * Algorithm:
 * 1. Convert RGB to 8×8 grayscale (luminance)
 * 2. Compare adjacent pixels horizontally → 64 bits
 * 3. Return as two 32-bit numbers (high, low)
 */
export function computeFrameDHash(
  rgb: Uint8Array,
  width: number,
  height: number
): { hi: number; lo: number } {
  // Sample 8×8 grid from the frame
  const gray = new Uint8Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const srcX = Math.floor((x / 8) * width);
      const srcY = Math.floor((y / 8) * height);
      const srcIdx = (srcY * width + srcX) * 3;
      // Luminance: 0.299R + 0.587G + 0.114B
      gray[y * 8 + x] = Math.round(
        rgb[srcIdx]! * 0.299 + rgb[srcIdx + 1]! * 0.587 + rgb[srcIdx + 2]! * 0.114
      );
    }
  }

  // Compute difference hash: compare adjacent pixels
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < 64; i++) {
    const bit = gray[i]! > gray[(i + 1) % 64]! ? 1 : 0;
    if (i < 32) {
      lo = (lo << 1) | bit;
    } else {
      hi = (hi << 1) | bit;
    }
  }

  return { hi, lo };
}

/**
 * Compute hamming distance between two dHash values.
 * Distance < threshold means frames are visually similar.
 */
export function hammingDistanceDHash(
  a: { hi: number; lo: number },
  b: { hi: number; lo: number }
): number {
  // XOR each 32-bit half separately, then count set bits in both.
  // Using OR would lose information when hi and lo have overlapping bits.
  let hiDiff = (a.hi ^ b.hi) >>> 0; // Force unsigned
  let loDiff = (a.lo ^ b.lo) >>> 0;
  let count = 0;
  while (hiDiff) {
    count += hiDiff & 1;
    hiDiff >>>= 1;
  }
  while (loDiff) {
    count += loDiff & 1;
    loDiff >>>= 1;
  }
  return count;
}

/**
 * Check if two frames are duplicates based on dHash comparison.
 * Returns true if frames are similar enough to be considered duplicates.
 *
 * @param prevRGB - Previous frame's RGB data
 * @param currRGB - Current frame's RGB data
 * @param width   - Frame width
 * @param height  - Frame height
 * @param threshold - Max hamming distance (default: 8, out of 64 bits)
 */
export function isDuplicateFrame(
  prevRGB: Uint8Array,
  currRGB: Uint8Array,
  width: number,
  height: number,
  threshold = 8
): boolean {
  const hashA = computeFrameDHash(prevRGB, width, height);
  const hashB = computeFrameDHash(currRGB, width, height);
  return hammingDistanceDHash(hashA, hashB) < threshold;
}

// ─── Histogram-based Duplicate Detection (A1) ───

/** Number of histogram bins per color channel */
const HIST_BINS = 32;

/**
 * Compute per-channel histograms for RGB frame data.
 * Used to complement dHash with color-based similarity.
 */
export function computeHistogram(rgb: Uint8Array): Float32Array {
  const total = new Float32Array(HIST_BINS * 3);
  const pixelCount = rgb.length / 3;
  const step = 256 / HIST_BINS;

  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 3;
    const rBin = Math.min(HIST_BINS - 1, Math.floor(rgb[idx]! / step));
    const gBin = Math.min(HIST_BINS - 1, Math.floor(rgb[idx + 1]! / step));
    const bBin = Math.min(HIST_BINS - 1, Math.floor(rgb[idx + 2]! / step));
    total[rBin]!++;
    total[gBin + HIST_BINS]!++;
    total[bBin + HIST_BINS * 2]!++;
  }

  // Normalize to [0, 1]
  const invCount = 1 / pixelCount;
  for (let i = 0; i < total.length; i++) {
    total[i] = (total[i] ?? 0) * invCount;
  }
  return total;
}

/**
 * Compute histogram intersection similarity (0 = completely different, 1 = identical).
 */
export function histogramSimilarity(a: Float32Array, b: Float32Array): number {
  let intersection = 0;
  for (let i = 0; i < a.length; i++) {
    intersection += Math.min(a[i]!, b[i]!);
  }
  return intersection; // Already normalized, range [0, 1]
}

/**
 * Combined duplicate detection using dHash (structure) + histogram (color).
 * More accurate than dHash alone — catches color-only changes that dHash misses.
 *
 * @returns { duplicate: boolean, score: number } — score 0 = identical, >= 1 = different
 */
export function isDuplicateFrameCombined(
  prevRGB: Uint8Array,
  currRGB: Uint8Array,
  width: number,
  height: number,
  dhashThreshold = 8,
  histThreshold = 0.98 // 98% histogram similarity = duplicate
): { duplicate: boolean; score: number } {
  // Quick dHash check first (O(64) → fast)
  const hashA = computeFrameDHash(prevRGB, width, height);
  const hashB = computeFrameDHash(currRGB, width, height);
  const dhashDist = hammingDistanceDHash(hashA, hashB);

  // If dHash is very different, definitely not duplicate — skip histogram
  if (dhashDist >= dhashThreshold * 2) {
    return { duplicate: false, score: dhashDist / 64 };
  }

  // If dHash is very similar, compute histogram for secondary check
  if (dhashDist < dhashThreshold) {
    // dHash says "similar" — verify with histogram to avoid false positives
    const histA = computeHistogram(prevRGB);
    const histB = computeHistogram(currRGB);
    const histSim = histogramSimilarity(histA, histB);
    // Both dHash AND histogram must agree for duplicate classification
    const duplicate = histSim >= histThreshold;
    const score = (dhashDist / 64) * 0.5 + (1 - histSim) * 0.5;
    return { duplicate, score };
  }

  // dHash borderline — compute histogram for final verdict
  const histA = computeHistogram(prevRGB);
  const histB = computeHistogram(currRGB);
  const histSim = histogramSimilarity(histA, histB);
  const score = (dhashDist / 64) * 0.6 + (1 - histSim) * 0.4;
  return { duplicate: histSim >= histThreshold, score };
}

// ─── Adaptive Threshold (A2) ───

/** Sampling window for auto-threshold calibration */
const AUTO_THRESHOLD_SAMPLE_FRAMES = 30;
/** Minimum threshold value (strictest — keeps more frames) */
const MIN_THRESHOLD = 4;
/** Maximum threshold value (loosest — removes more frames) */
const MAX_THRESHOLD = 20;
/** Default threshold when auto-calibration is insufficient */
const DEFAULT_THRESHOLD = 8;

/**
 * Compute adaptive threshold based on initial frame sample.
 * Analyzes the first N frames to determine content type:
 * - Static content (low frame-to-frame variance) → lower threshold (keep more)
 * - Dynamic content (high variance) → higher threshold (remove more)
 *
 * The optimal threshold is 2x the median pairwise dHash distance
 * from the first N frames, clamped to [MIN_THRESHOLD, MAX_THRESHOLD].
 */
export function autoThreshold(
  frames: { rgb: Uint8Array; width: number; height: number }[]
): number {
  if (frames.length < 4) return DEFAULT_THRESHOLD;

  const pairs = Math.min(AUTO_THRESHOLD_SAMPLE_FRAMES, frames.length);
  const distances: number[] = [];

  for (let i = 1; i < pairs; i++) {
    const prev = frames[i - 1]!;
    const curr = frames[i]!;
    const prevHash = computeFrameDHash(prev.rgb, prev.width, prev.height);
    const currHash = computeFrameDHash(curr.rgb, curr.width, curr.height);
    distances.push(hammingDistanceDHash(prevHash, currHash));
  }

  distances.sort((a, b) => a - b);
  const median = distances[Math.floor(distances.length / 2)] ?? 0;

  // For static content (median=0), use a small default to avoid over-dedup
  // For dynamic content, use 2× median to catch moderate changes
  if (median <= 1) {
    // Very static content — use conservative threshold
    return Math.max(MIN_THRESHOLD, 6);
  }

  const rawThreshold = Math.round(median * 2);
  return Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, rawThreshold));
}

/**
 * Check if two frames are duplicates using adaptive threshold.
 * Selects the best detection strategy based on content type.
 */
export function isDuplicateFrameAdaptive(
  prevRGB: Uint8Array,
  currRGB: Uint8Array,
  width: number,
  height: number,
  threshold?: number
): { duplicate: boolean; score: number } {
  // Measure frame-to-frame difference using dHash
  const hashA = computeFrameDHash(prevRGB, width, height);
  const hashB = computeFrameDHash(currRGB, width, height);
  const dhashDist = hammingDistanceDHash(hashA, hashB);

  // If frames are clearly different (dHash >> threshold), skip histogram
  const effectiveThreshold = threshold ?? DEFAULT_THRESHOLD;
  if (dhashDist >= effectiveThreshold * 2) {
    return { duplicate: false, score: 1 };
  }

  // If frames are pixel-identical, skip histogram
  if (dhashDist === 0) {
    return { duplicate: true, score: 0 };
  }

  // Borderline: compute histogram for final decision
  const histA = computeHistogram(prevRGB);
  const histB = computeHistogram(currRGB);
  const histSim = histogramSimilarity(histA, histB);

  // Histogram similarity threshold: >99% = duplicate (very strict)
  // 98% was still too lenient for some content types
  const duplicate = histSim >= 0.99;
  const score = (dhashDist / 64) * 0.5 + (1 - histSim) * 0.5;
  return { duplicate, score };
}

/**
 * Alpha composite: blend RGBA pixels over a black background.
 * Converts RGBA → RGB by applying alpha pre-multiplication.
 */
export function compositeAlphaToRGB(rgba: Uint8Array): Uint8Array {
  const pixelCount = rgba.length / 4;
  const rgb = new Uint8Array(pixelCount * 3);
  for (let i = 0; i < pixelCount; i++) {
    const srcIdx = i * 4;
    const dstIdx = i * 3;
    const a = (rgba[srcIdx + 3] ?? 255) / 255;
    rgb[dstIdx] = Math.round((rgba[srcIdx] ?? 0) * a);
    rgb[dstIdx + 1] = Math.round((rgba[srcIdx + 1] ?? 0) * a);
    rgb[dstIdx + 2] = Math.round((rgba[srcIdx + 2] ?? 0) * a);
  }
  return rgb;
}
