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
 *
 * BufferPool: Reuses Uint8Array allocations across frames to reduce GC.
 */

import { globalBufferPool } from './buffer-pool';

// ─── Cached copyTo path ───────────────────────────────────────────
// Strategy detection result cached after first frame to avoid repeated
// try/catch fallback attempts on every frame.
let cachedCopyPath: 'rgb' | 'four-channel' | 'canvas' | null = null;

/**
 * Copy VideoFrame pixels directly to RGB Uint8Array.
 *
 * Strategy:
 * 1. Try native RGB output via copyTo({ format: 'RGB' }) — zero-conversion path.
 *    Supported in Chrome 114+, Firefox 130+.
 * 2. Fall back to 4-channel formats (RGBX/BGRX/RGBA/BGRA) + fast Uint32Array RGBA→RGB.
 * 3. Last resort: OffscreenCanvas for exotic YUV/NV12 formats.
 *
 * The detected path is cached after the first frame to avoid repeated
 * try/catch overhead on subsequent frames.
 */
export async function copyFrameToRGB(
  frame: VideoFrame,
  width: number,
  height: number
): Promise<Uint8Array> {
  // Use cached path from first frame detection
  if (cachedCopyPath === 'rgb') {
    return copyFrameRGB(frame, width, height);
  }
  if (cachedCopyPath === 'four-channel') {
    return copyFrameFourChannel(frame, width, height);
  }

  // ── Strategy 1: Native RGB output (zero-conversion path) ──
  // Chrome 114+ / Firefox 130+ support format:'RGB' in copyTo options.
  try {
    const result = await copyFrameRGB(frame, width, height);
    cachedCopyPath = 'rgb';
    return result;
  } catch {
    // format:'RGB' not supported, fall through to 4-channel path
  }

  // ── Strategy 2: 4-channel formats + fast Uint32Array RGBA→RGB ──
  try {
    const result = await copyFrameFourChannel(frame, width, height);
    cachedCopyPath = 'four-channel';
    return result;
  } catch {
    // Fall through to canvas fallback
  }

  // ── Strategy 3: Canvas fallback (cached for subsequent frames) ──
  cachedCopyPath = 'canvas';
  return copyFrameCanvas(frame, width, height);
}

/** Strategy 1: Native RGB copyTo */
async function copyFrameRGB(frame: VideoFrame, width: number, height: number): Promise<Uint8Array> {
  const size = width * height * 3;
  const buffer = globalBufferPool.acquire(size);
  const layout = await frame.copyTo(buffer, {
    rect: { x: 0, y: 0, width, height },
    layout: [{ offset: 0, stride: width * 3 }],
    format: 'RGB' as VideoFrameCopyToOptions['format'],
  });
  // Verify we actually got RGB data (3 bytes per pixel)
  if (layout && layout[0]?.stride === width * 3) {
    return buffer;
  }
  globalBufferPool.release(buffer);
  throw new Error('RGB layout unexpected');
}

/** Strategy 2: 4-channel copyTo + fast RGBA→RGB */
async function copyFrameFourChannel(
  frame: VideoFrame,
  width: number,
  height: number
): Promise<Uint8Array> {
  const fourChannelFormats: Array<'RGBX' | 'BGRX' | 'RGBA' | 'BGRA'> = [
    'RGBX',
    'BGRX',
    'RGBA',
    'BGRA',
  ];

  for (const fmt of fourChannelFormats) {
    try {
      const size = frame.allocationSize({
        rect: { x: 0, y: 0, width, height },
        layout: [{ offset: 0, stride: width * 4 }],
      });
      const buffer = globalBufferPool.acquire(size);
      await frame.copyTo(buffer, {
        rect: { x: 0, y: 0, width, height },
        layout: [{ offset: 0, stride: width * 4 }],
      });

      const rgb = rgbaToRGBFast(buffer, width, height, fmt);
      globalBufferPool.release(buffer);
      return rgb;
    } catch {
      // Format not supported, try next
    }
  }
  throw new Error('No 4-channel format supported');
}

/** Strategy 3: Canvas fallback for exotic formats */
async function copyFrameCanvas(
  frame: VideoFrame,
  width: number,
  height: number
): Promise<Uint8Array> {
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
  const rgb = rgbaToRGBFast(rgbaBuf, width, height, 'RGBA');

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
function rgbaToRGBFast(
  src: Uint8Array,
  width: number,
  height: number,
  format: 'RGBA' | 'BGRA' | 'RGBX' | 'BGRX'
): Uint8Array {
  const pixelCount = width * height;
  const dst = globalBufferPool.acquire(pixelCount * 3);

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
export function getSkipThreshold(mode: 'off' | 'low' | 'medium' | 'high'): number {
  switch (mode) {
    case 'off':
      return -1;
    case 'low':
      return 2;
    case 'medium':
      return 3;
    case 'high':
      return 5;
  }
}
