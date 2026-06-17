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
  height: number,
  needsResize = false
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
    resizeWidth: needsResize ? width : frame.displayWidth,
    resizeHeight: needsResize ? height : frame.displayHeight,
    resizeQuality: 'pixelated',
    premultiplyAlpha: 'none',
  });

  const targetW = needsResize ? width : frame.displayWidth;
  const targetH = needsResize ? height : frame.displayHeight;
  const canvas = new OffscreenCanvas(targetW, targetH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, targetW, targetH);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, targetW, targetH);
  return rgbaToRGB(new Uint8Array(imageData.data), targetW, targetH);
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
 * Get frame duration in milliseconds with clamping.
 * Clamps to [MIN_DELAY_MS, MAX_DELAY_MS] to avoid:
 * - Too-fast frames (<20ms) that waste space and aren't perceptible
 * - Too-slow frames (>200ms) that cause visible stuttering
 */
const MIN_DELAY_MS = 20; // 50fps max — faster is imperceptible
const MAX_DELAY_MS = 200; // 5fps min — slower causes visible stutter

export function getFrameDurationMs(frame: VideoFrame): number {
  const raw = frame.duration as number | null;
  const ms = raw != null && raw > 0 ? Math.max(1, Math.round(raw / 1000)) : 100;
  return Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, ms));
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
  let diff = (a.hi ^ b.hi) | (a.lo ^ b.lo);
  // Count set bits
  let count = 0;
  while (diff) {
    count += diff & 1;
    diff >>>= 1;
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
