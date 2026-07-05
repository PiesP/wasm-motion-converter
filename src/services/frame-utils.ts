// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Frame Processing Utilities
 *
 * Zero-copy frame processing where possible:
 * - VideoFrame.copyTo() for standard 4-channel formats (RGBA/BGRA/RGBX/BGRX)
 * - createImageBitmap fallback only for unsupported formats
 *
 * H3: Optimized to avoid unnecessary RGBA→RGB intermediate buffer.
 *     Uses standard 4-channel copyTo formats (RGBA tried first) with
 *     fast Uint32Array RGBA→RGB conversion.
 *
 * BufferPool: Reuses Uint8Array allocations across frames to reduce GC.
 */

import type { BufferPool } from './buffer-pool';
import { globalBufferPool } from './buffer-pool';

// ─── Video Dimension Resolution ────────────────────────────────────

export interface VideoConfigWithDimensions {
  codedWidth?: number;
  codedHeight?: number;
  displayAspectWidth?: number;
  displayAspectHeight?: number;
  displayWidth?: number;
  displayHeight?: number;
}

/**
 * Resolve video dimensions from decoder config, preferring coded dimensions
 * over display aspect dimensions over raw display dimensions.
 * Returns null if no valid dimensions can be determined.
 */
export function resolveVideoDimensions(
  config: VideoConfigWithDimensions
): { width: number; height: number } | null {
  const width = config.codedWidth ?? config.displayAspectWidth ?? config.displayWidth;
  const height = config.codedHeight ?? config.displayAspectHeight ?? config.displayHeight;
  if (!width || !height) return null;
  return { width, height };
}

// ─── Cached copyTo path ───────────────────────────────────────────
// Strategy detection result cached after first frame to avoid repeated
// try/catch fallback attempts on every frame.
// Now stored in per-conversion context to prevent cross-conversion bleed.

/**
 * Copy VideoFrame pixels directly to RGB Uint8Array.
 *
 * Strategy:
 * 1. Try 4-channel formats (RGBA/BGRA/RGBX/BGRX) + fast Uint32Array RGBA→RGB.
 *    'RGBA' is tried first as it is the most widely supported.
 * 2. Last resort: OffscreenCanvas for exotic YUV/NV12 formats.
 *
 * The detected path is cached in the per-conversion context after the first
 * frame to avoid repeated try/catch overhead on subsequent frames.
 *
 * @param frame - The VideoFrame to copy
 * @param width - Target width
 * @param height - Target height
 * @param ctx - Per-conversion context for caching the detected path
 */
export async function copyFrameToRGB(
  frame: VideoFrame,
  width: number,
  height: number,
  ctx: FrameProcessingContext
): Promise<Uint8Array> {
  // ── Scaling detection ──
  // VideoFrame.copyTo() with rect={width,height} CROPS the source frame
  // to those dimensions rather than scaling. When target dimensions differ
  // from the source, we must route through the canvas path which properly
  // scales via drawImage().
  const srcW = frame.codedWidth ?? frame.displayWidth;
  const srcH = frame.codedHeight ?? frame.displayHeight;
  const needsScaling = srcW !== width || srcH !== height;

  if (needsScaling) {
    ctx.copyPath = 'canvas';
    return copyFrameCanvas(frame, width, height);
  }

  // Use cached path from first frame detection
  if (ctx.copyPath === 'four-channel') {
    return copyFrameFourChannel(frame, width, height);
  }

  // ── Strategy 1: 4-channel formats + fast Uint32Array RGBA→RGB ──
  // RGBA is tried first (most widely supported), then BGRA, RGBX, BGRX.
  try {
    const result = await copyFrameFourChannel(frame, width, height);
    ctx.copyPath = 'four-channel';
    return result;
  } catch {
    // Fall through to canvas fallback
  }

  // ── Strategy 2: Canvas fallback (cached for subsequent frames) ──
  ctx.copyPath = 'canvas';
  return copyFrameCanvas(frame, width, height);
}

/**
 * Yield to the event loop to keep the UI responsive.
 * Uses scheduler.yield() (Chrome 115+) if available, falls back to setTimeout(0).
 * The availability check is cached since it doesn't change during a page session.
 */
const hasSchedulerYield = typeof globalThis.scheduler?.yield === 'function';

export function yieldToMain(): Promise<void> {
  if (hasSchedulerYield) {
    return scheduler.yield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Strategy 0 (new): Try copyTo with RGBX format for zero-JS-conversion copy.
 * The browser's native C++ implementation handles YUV→RGB conversion during copy,
 * eliminating the need for manual convertRGBAToRGB() on the hot path.
 *
 * VideoFrame.copyTo() supports format conversion:
 *   I420, I422, I444, NV12, NV21 → RGBA, RGBX, BGRA, BGRX
 */
async function copyFrameRGBX(
  frame: VideoFrame,
  width: number,
  height: number
): Promise<Uint8Array> {
  const size = frame.allocationSize({
    rect: { x: 0, y: 0, width, height },
    layout: [{ offset: 0, stride: width * 4 }],
    format: 'RGBX',
  });
  const buffer = globalBufferPool.acquire(size);
  try {
    await frame.copyTo(buffer, {
      rect: { x: 0, y: 0, width, height },
      layout: [{ offset: 0, stride: width * 4 }],
      format: 'RGBX',
    });
    // RGBX data: every 4th byte is padding. Convert to tight RGB in-place.
    // We can't avoid this copy since the encoder expects packed RGB.
    const pixelCount = width * height;
    const rgb = globalBufferPool.acquire(pixelCount * 3);
    const buf32 = new Uint32Array(buffer.buffer, buffer.byteOffset, pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      const v = buf32[i]!;
      const dstIdx = i * 3;
      rgb[dstIdx] = v & 0xff; // R
      rgb[dstIdx + 1] = (v >> 8) & 0xff; // G
      rgb[dstIdx + 2] = (v >> 16) & 0xff; // B
    }
    return rgb;
  } finally {
    globalBufferPool.release(buffer);
  }
}

/** Strategy 1: 4-channel copyTo + fast RGBA→RGB */
async function copyFrameFourChannel(
  frame: VideoFrame,
  width: number,
  height: number
): Promise<Uint8Array> {
  // Try RGBX first (native YUV→RGB conversion in browser)
  try {
    return await copyFrameRGBX(frame, width, height);
  } catch {
    // RGBX not supported, fall through to RGBA/BGRA path
  }

  const fourChannelFormats: Array<'RGBA' | 'BGRA' | 'RGBX' | 'BGRX'> = [
    'RGBA',
    'BGRA',
    'RGBX',
    'BGRX',
  ];

  for (const fmt of fourChannelFormats) {
    try {
      const size = frame.allocationSize({
        rect: { x: 0, y: 0, width, height },
        layout: [{ offset: 0, stride: width * 4 }],
      });
      const buffer = globalBufferPool.acquire(size);
      try {
        await frame.copyTo(buffer, {
          rect: { x: 0, y: 0, width, height },
          layout: [{ offset: 0, stride: width * 4 }],
        });

        const rgb = convertRGBAToRGB(buffer, width, height, fmt);
        return rgb;
      } finally {
        globalBufferPool.release(buffer);
      }
    } catch {
      // Format not supported, try next
    }
  }
  throw new Error('No 4-channel format supported');
}

/** Strategy 2: Canvas fallback for exotic formats + GPU-accelerated scaling */
async function copyFrameCanvas(
  frame: VideoFrame,
  width: number,
  height: number
): Promise<Uint8Array> {
  // Try GPU-accelerated scaling via createImageBitmap first.
  // Falls back to canvas drawImage on failure (e.g., exotic codecs, old browsers).
  try {
    const bitmap = await createImageBitmap(frame, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'medium',
    });
    try {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Failed to get 2d context');
      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, width, height);
      const rgb = convertRGBAToRGB(new Uint8Array(imageData.data), width, height, 'RGBA');
      canvas.width = 0;
      canvas.height = 0;
      return rgb;
    } finally {
      bitmap.close();
    }
  } catch {
    // Fallback: canvas drawImage with source→dest rect scaling
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to get 2d context from OffscreenCanvas');
  ctx.drawImage(
    frame,
    0,
    0,
    frame.codedWidth || frame.displayWidth,
    frame.codedHeight || frame.displayHeight,
    0,
    0,
    width,
    height
  );

  const imageData = ctx.getImageData(0, 0, width, height);
  const rgbaBuf = new Uint8Array(imageData.data);
  const rgb = convertRGBAToRGB(rgbaBuf, width, height, 'RGBA');

  // Explicitly release OffscreenCanvas GPU resources
  canvas.width = 0;
  canvas.height = 0;

  return rgb;
}

/**
 * Fast RGBA→RGB conversion using Uint32Array bitwise operations.
 *
 * Reads 4 bytes at a time as a single uint32, then extracts R/G/B with bit shifts.
 * ~2-3x faster than per-pixel byte copying for large frames.
 *
 * @param src - Source 4-channel buffer (RGBA, BGRA, RGBX, or BGRX)
 * @param width - Frame width in pixels
 * @param height - Frame height in pixels
 * @param format - Source channel order
 * @returns New RGB buffer (pooled)
 */
export function convertRGBAToRGB(
  src: Uint8Array,
  width: number,
  height: number,
  format: 'RGBA' | 'BGRA' | 'RGBX' | 'BGRX',
  pool?: BufferPool
): Uint8Array {
  const pixelCount = width * height;
  const dst = (pool ?? globalBufferPool).acquire(pixelCount * 3);

  // Use Uint32Array view for 4-byte-at-a-time reads
  const src32 = new Uint32Array(src.buffer, src.byteOffset, pixelCount);
  const len = pixelCount;

  if (format === 'RGBA' || format === 'RGBX') {
    // RGBA: R=byte0, G=byte1, B=byte2, A/X=byte3 (little-endian: 0xAABBGGRR in uint32)
    // We need bytes 0,1,2 → copy with alpha skip
    for (let i = 0; i < len; i++) {
      const v = src32[i]!;
      const dstIdx = i * 3;
      dst[dstIdx] = v & 0xff; // R
      dst[dstIdx + 1] = (v >> 8) & 0xff; // G
      dst[dstIdx + 2] = (v >> 16) & 0xff; // B
    }
  } else {
    // BGRA/BGRX: B=byte0, G=byte1, R=byte2, A/X=byte3
    for (let i = 0; i < len; i++) {
      const v = src32[i]!;
      const dstIdx = i * 3;
      dst[dstIdx] = (v >> 16) & 0xff; // R (from byte 2)
      dst[dstIdx + 1] = (v >> 8) & 0xff; // G (from byte 1)
      dst[dstIdx + 2] = v & 0xff; // B (from byte 0)
    }
  }

  return dst;
}

/**
 * Fast RGB→RGBA conversion using Uint32Array bitwise operations.
 *
 * Packs RGB bytes (3 bytes/pixel) into RGBA uint32 (4 bytes/pixel) with
 * alpha channel set to 0xFF (fully opaque). Uses the global buffer pool.
 *
 * ~3x faster than per-pixel byte copying by writing 4 bytes at once.
 *
 * @param rgb - Source RGB buffer (3 bytes per pixel)
 * @param width - Frame width in pixels
 * @param height - Frame height in pixels
 * @returns New RGBA buffer (pooled), alpha=0xFF
 */
export function convertRGBToRGBA(
  rgb: Uint8Array,
  width: number,
  height: number,
  pool?: BufferPool
): Uint8Array {
  const pixelCount = width * height;
  const rgba = (pool ?? globalBufferPool).acquire(pixelCount * 4);

  // Uint32Array view over the RGBA buffer for 4-byte-at-a-time writes
  const rgba32 = new Uint32Array(rgba.buffer, rgba.byteOffset, pixelCount);

  // Little-endian: uint32 = 0xAABBGGRR → bytes [RR, GG, BB, AA]
  // We package [R, G, B, 0xFF] → uint32 = 0xFF << 24 | B << 16 | G << 8 | R
  for (let i = 0; i < pixelCount; i++) {
    const srcIdx = i * 3;
    const r = rgb[srcIdx]!;
    const g = rgb[srcIdx + 1]!;
    const b = rgb[srcIdx + 2]!;
    rgba32[i] = (0xff << 24) | (b << 16) | (g << 8) | r;
  }

  return rgba;
}

// ─── Duration accumulation state ──────────────────────────────────
// Track fractional duration remainders to prevent rounding drift.
// E.g., at 30fps each frame is ~33.33ms. Rounding to 33ms loses 0.33ms/frame,
// which accumulates to ~500ms over 1500 frames. We carry the fractional
// remainder across frames so total timing matches source.
//
// Per-conversion context — must be created fresh for each decodeFrames call
// to prevent concurrent conversions from bleeding carry state.

export interface FrameProcessingContext {
  /** Fractional duration remainder in microseconds */
  durationCarryUs: number;
  /** Cached copyTo path — detected on first frame, reused for subsequent frames */
  copyPath: 'four-channel' | 'canvas' | null;
}

/**
 * Create a fresh per-conversion frame processing context.
 * Call this at the start of each decodeFrames invocation.
 */
export function createFrameProcessingContext(): FrameProcessingContext {
  return {
    durationCarryUs: 0,
    copyPath: null,
  };
}

/**
 * Get frame duration in milliseconds — preserves original timing by
 * accumulating fractional remainders across frames to prevent drift.
 *
 * No clamping: the original video frame duration is used as-is to maintain
 * accurate playback speed. Clamping is applied only at the output stage
 * when writing frames (see writeFrameWithDelay in gif-encoder-service).
 *
 * @param frame - The VideoFrame to extract duration from
 * @param ctx - Per-conversion context for carry state
 */
export function getFrameDurationMs(
  frame: VideoFrame,
  ctx: FrameProcessingContext,
  fallbackMs?: number
): number {
  const raw = frame.duration as number | null;
  if (raw == null || raw <= 0) {
    ctx.durationCarryUs = 0;
    return fallbackMs ?? 100;
  }
  // Add any fractional remainder from previous frames
  const totalUs = raw + ctx.durationCarryUs;
  const ms = Math.round(totalUs / 1000);
  // Save the sub-millisecond remainder for next frame
  ctx.durationCarryUs = totalUs - ms * 1000;
  return Math.max(1, ms);
}

// ─── dHash (Difference Hash) for Frame Similarity ──────────────────

/**
 * Compute 8x8 dHash from RGB frame data.
 *
 * Algorithm:
 * 1. Downsample to 8x8 by sampling center of each grid cell
 * 2. Convert to grayscale (R+G+B)/3 at sample point
 * 3. Compare each pixel with its right neighbor → 64-bit hash
 *
 * Returns a BigInt where bit[i] = 1 if pixel[i] > pixel[i+1].
 * Two very similar frames will have a small hamming distance.
 */
export function computeDHash(rgbData: Uint8Array, width: number, height: number): bigint {
  const gray = new Uint8Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const srcX = Math.floor(((x + 0.5) * width) / 8);
      const srcY = Math.floor(((y + 0.5) * height) / 8);
      const idx = (srcY * width + srcX) * 3;
      gray[y * 8 + x] =
        ((rgbData[idx] ?? 0) + (rgbData[idx + 1] ?? 0) + (rgbData[idx + 2] ?? 0)) / 3;
    }
  }
  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 7; x++) {
      if (gray[y * 8 + x]! > gray[y * 8 + x + 1]!) {
        hash |= 1n << BigInt(y * 8 + x);
      }
    }
    if (gray[y * 8 + 7]! > gray[y * 8]!) {
      hash |= 1n << BigInt(y * 8 + 7);
    }
  }
  return hash;
}

/**
 * Hamming distance between two dHashes.
 * Counts the number of differing bits — lower means more similar.
 *
 * Distance interpretation:
 * - 0-2: Nearly identical (noise only)
 * - 3-5: Similar (slow motion or minor change)
 * - 6-10: Moderate change
 * - 11+: Significant change (different scene)
 */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    count++;
    x &= x - 1n;
  }
  return count;
}

/**
 * Get the hamming distance threshold for a given smart skip mode.
 * Frames with distance ≤ threshold are candidates for skipping.
 * Returns -1 for 'off' (never skip).
 */
export function getSkipThreshold(mode: 'off' | 'low' | 'medium' | 'high' | 'adaptive'): number {
  switch (mode) {
    case 'off':
      return -1;
    case 'adaptive':
      return -2; // signal for adaptive motion-classified decimation
    case 'low':
      return 2;
    case 'medium':
      return 3;
    case 'high':
      return 5;
  }
}
