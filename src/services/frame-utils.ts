// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Frame Processing Utilities
 *
 * Zero-copy frame processing where possible:
 * - VideoFrame.copyTo() for standard 4-channel formats (RGBA/BGRA/RGBX/BGRX)
 * - createImageBitmap fallback only for unsupported formats
 *
 * Modern encoders retain opaque RGBA. The legacy WASM WebP path can still
 * request packed RGB from the same exact native/canvas strategy.
 *
 * BufferPool: Reuses Uint8Array allocations across frames to reduce GC.
 */

import { MAX_FRAME_PIXEL_COUNT } from '@utils/constants';
import type { BufferPool } from './buffer-pool';
import { getPooledBufferSize, globalBufferPool } from './buffer-pool';
import type { CpuPixelFormat } from './frame-memory';

// ─── Video Dimension Resolution ────────────────────────────────────

export interface VideoConfigWithDimensions {
  codedWidth?: number | undefined;
  codedHeight?: number | undefined;
  displayAspectWidth?: number | undefined;
  displayAspectHeight?: number | undefined;
  displayWidth?: number | undefined;
  displayHeight?: number | undefined;
}

/**
 * Resolve square-pixel output dimensions from decoder config, preferring display
 * aspect dimensions over coded dimensions and raw display dimensions.
 * Returns null if no valid dimensions can be determined.
 */
export function resolveVideoDimensions(
  config: VideoConfigWithDimensions
): { width: number; height: number } | null {
  const hasDisplayAspect =
    config.displayAspectWidth !== undefined || config.displayAspectHeight !== undefined;
  const width = hasDisplayAspect
    ? config.displayAspectWidth
    : (config.codedWidth ?? config.displayWidth);
  const height = hasDisplayAspect
    ? config.displayAspectHeight
    : (config.codedHeight ?? config.displayHeight);

  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width === undefined ||
    height === undefined ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_FRAME_PIXEL_COUNT / height
  ) {
    return null;
  }
  return { width, height };
}

// ─── Cached copyTo path ───────────────────────────────────────────
// Strategy detection result cached after first frame to avoid repeated
// try/catch fallback attempts on every frame.
// Now stored in per-conversion context to prevent cross-conversion bleed.

export type FrameCopyStrategy = 'RGBX' | 'RGBA' | 'BGRA' | 'BGRX' | 'canvas';

const NATIVE_COPY_STRATEGIES: readonly Exclude<FrameCopyStrategy, 'canvas'>[] = [
  'RGBX',
  'RGBA',
  'BGRA',
  'BGRX',
];

export async function copyFrameToRGB(
  frame: VideoFrame,
  width: number,
  height: number,
  ctx: FrameProcessingContext
): Promise<Uint8Array> {
  return copyFrameToPixels(frame, width, height, ctx, 'rgb');
}

/** Copy one frame to opaque RGBA while retaining the exact successful strategy. */
export async function copyFrameToRGBA(
  frame: VideoFrame,
  width: number,
  height: number,
  ctx: FrameProcessingContext
): Promise<Uint8Array> {
  return copyFrameToPixels(frame, width, height, ctx, 'rgba');
}

export async function copyFrameToPixels(
  frame: VideoFrame,
  width: number,
  height: number,
  ctx: FrameProcessingContext,
  pixelFormat: CpuPixelFormat
): Promise<Uint8Array> {
  const srcW = frame.codedWidth ?? frame.displayWidth;
  const srcH = frame.codedHeight ?? frame.displayHeight;
  const needsScaling = srcW !== width || srcH !== height;

  if (ctx.copyPath === 'canvas' || needsScaling) {
    ctx.copyPath = 'canvas';
    return copyFrameCanvas(frame, width, height, pixelFormat);
  }

  const cachedStrategy = ctx.copyPath;
  if (cachedStrategy) {
    try {
      return await copyFrameNative(frame, width, height, cachedStrategy, pixelFormat);
    } catch {
      ctx.copyPath = null;
    }
  }

  for (const strategy of NATIVE_COPY_STRATEGIES) {
    if (strategy === cachedStrategy) continue;
    try {
      const result = await copyFrameNative(frame, width, height, strategy, pixelFormat);
      ctx.copyPath = strategy;
      return result;
    } catch {
      // Probe the next native layout only during first-frame strategy discovery.
    }
  }

  ctx.copyPath = 'canvas';
  return copyFrameCanvas(frame, width, height, pixelFormat);
}

async function copyFrameNative(
  frame: VideoFrame,
  width: number,
  height: number,
  strategy: Exclude<FrameCopyStrategy, 'canvas'>,
  pixelFormat: CpuPixelFormat
): Promise<Uint8Array> {
  const validBytes = width * height * 4;
  const size = frame.allocationSize({
    rect: { x: 0, y: 0, width, height },
    layout: [{ offset: 0, stride: width * 4 }],
    format: strategy,
  });
  const maxPooledBytes = getPooledBufferSize(validBytes);
  if (!Number.isSafeInteger(size) || size < validBytes || size > maxPooledBytes) {
    throw new RangeError(`Invalid ${strategy} allocation size: ${size}`);
  }
  const buffer = globalBufferPool.acquire(size);
  try {
    await frame.copyTo(buffer, {
      rect: { x: 0, y: 0, width, height },
      layout: [{ offset: 0, stride: width * 4 }],
      format: strategy,
    });
    if (pixelFormat === 'rgba') {
      normalizeOpaqueRgba(buffer, width, height, strategy);
      return buffer;
    }
    const rgb = convertRGBAToRGB(buffer, width, height, strategy);
    globalBufferPool.release(buffer);
    return rgb;
  } catch (error) {
    globalBufferPool.release(buffer);
    throw error;
  }
}

function normalizeOpaqueRgba(
  buffer: Uint8Array,
  width: number,
  height: number,
  strategy: Exclude<FrameCopyStrategy, 'canvas'>
): void {
  const pixels = width * height;
  const swapsRedAndBlue = strategy === 'BGRA' || strategy === 'BGRX';
  for (let index = 0; index < pixels; index++) {
    const offset = index * 4;
    if (swapsRedAndBlue) {
      const blue = buffer[offset]!;
      buffer[offset] = buffer[offset + 2]!;
      buffer[offset + 2] = blue;
    }
    buffer[offset + 3] = 255;
  }
}

/** Strategy 2: Canvas fallback for exotic formats + GPU-accelerated scaling */

// ── Canvas cache for copyFrameCanvas ──────────────────────────────
// Creating OffscreenCanvas + getContext('2d') is expensive (~0.3ms per call).
// Since every frame in a conversion uses the same (width, height),
// cache the canvas/context pair keyed by dimensions to avoid per-frame
// allocation and GPU context setup cost.

interface CachedCanvas {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
}

const scaledCanvasCache = new Map<string, CachedCanvas>();

function getOrCreateCanvas(width: number, height: number): CachedCanvas {
  const key = `${width}x${height}`;
  const cached = scaledCanvasCache.get(key);
  if (cached) return cached;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to get 2d context from OffscreenCanvas');
  const entry: CachedCanvas = { canvas, ctx };
  scaledCanvasCache.set(key, entry);
  return entry;
}

/** Release all cached canvases. Call after conversion completes or on error. */
export function clearCanvasCache(): void {
  for (const entry of scaledCanvasCache.values()) {
    entry.canvas.width = 0;
    entry.canvas.height = 0;
  }
  scaledCanvasCache.clear();
}

async function copyFrameCanvas(
  frame: VideoFrame,
  width: number,
  height: number,
  pixelFormat: CpuPixelFormat
): Promise<Uint8Array> {
  const { ctx } = getOrCreateCanvas(width, height);

  // Clear canvas before drawing (reuses same canvas across frames)
  ctx.clearRect(0, 0, width, height);

  // Try GPU-accelerated scaling via createImageBitmap first.
  // Falls back to canvas drawImage on failure (e.g., exotic codecs, old browsers).
  try {
    const bitmap = await createImageBitmap(frame, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'medium',
    });
    try {
      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, width, height);
      return convertImageData(imageData, width, height, pixelFormat);
    } finally {
      bitmap.close();
    }
  } catch {
    // Fallback: canvas drawImage with source→dest rect scaling
  }

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
  return convertImageData(imageData, width, height, pixelFormat);
}

function convertImageData(
  imageData: ImageData,
  width: number,
  height: number,
  pixelFormat: CpuPixelFormat
): Uint8Array {
  const validBytes = width * height * 4;
  if (imageData.data.byteLength < validBytes) {
    throw new RangeError(
      `Canvas RGBA buffer is too small: expected ${validBytes} bytes, got ${imageData.data.byteLength}`
    );
  }
  const rgba = new Uint8Array(
    imageData.data.buffer as ArrayBuffer,
    imageData.data.byteOffset,
    validBytes
  );
  for (let offset = 3; offset < validBytes; offset += 4) rgba[offset] = 255;
  if (pixelFormat === 'rgba') return rgba;
  return convertRGBAToRGB(rgba, width, height, 'RGBA');
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
  const targetPool = pool ?? globalBufferPool;
  const dst = targetPool.acquire(pixelCount * 3);

  // The source view itself must contain the complete RGBA payload. Checking the
  // underlying ArrayBuffer would incorrectly allow reads past a subarray's end.
  const needsBytes = pixelCount * 4;
  if (src.byteLength < needsBytes) {
    targetPool.release(dst);
    throw new RangeError(
      `RGBA source buffer is too small: expected ${needsBytes} bytes, got ${src.byteLength}`
    );
  }

  // Uint32Array requires a 4-byte-aligned byteOffset. Unaligned views are
  // valid input, so use the byte-wise path for them instead of throwing.
  if (needsBytes > 0 && src.byteOffset % Uint32Array.BYTES_PER_ELEMENT === 0) {
    // Fast path: 4-byte-at-a-time Uint32 reads
    const src32 = new Uint32Array(src.buffer, src.byteOffset, pixelCount);
    if (format === 'RGBA' || format === 'RGBX') {
      // RGBA: R=byte0, G=byte1, B=byte2, A/X=byte3 (little-endian: 0xAABBGGRR in uint32)
      for (let i = 0; i < pixelCount; i++) {
        const v = src32[i]!;
        const dstIdx = i * 3;
        dst[dstIdx] = v & 0xff; // R
        dst[dstIdx + 1] = (v >> 8) & 0xff; // G
        dst[dstIdx + 2] = (v >> 16) & 0xff; // B
      }
    } else {
      // BGRA/BGRX: B=byte0, G=byte1, R=byte2, A/X=byte3
      for (let i = 0; i < pixelCount; i++) {
        const v = src32[i]!;
        const dstIdx = i * 3;
        dst[dstIdx] = (v >> 16) & 0xff; // R (from byte 2)
        dst[dstIdx + 1] = (v >> 8) & 0xff; // G (from byte 1)
        dst[dstIdx + 2] = v & 0xff; // B (from byte 0)
      }
    }
  } else {
    // Fallback: per-byte copy for an unaligned source view.
    if (format === 'RGBA' || format === 'RGBX') {
      for (let i = 0; i < pixelCount; i++) {
        const srcIdx = i * 4;
        const dstIdx = i * 3;
        dst[dstIdx] = src[srcIdx]!; // R
        dst[dstIdx + 1] = src[srcIdx + 1]!; // G
        dst[dstIdx + 2] = src[srcIdx + 2]!; // B
      }
    } else {
      // BGRA/BGRX: B=byte0, G=byte1, R=byte2
      for (let i = 0; i < pixelCount; i++) {
        const srcIdx = i * 4;
        const dstIdx = i * 3;
        dst[dstIdx] = src[srcIdx + 2]!; // R
        dst[dstIdx + 1] = src[srcIdx + 1]!; // G
        dst[dstIdx + 2] = src[srcIdx]!; // B
      }
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
  /** Exact successful copy strategy, detected once per conversion. */
  copyPath: FrameCopyStrategy | null;
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
 * Returns a new context instead of mutating the input, preserving
 * referential transparency and pure function semantics.
 *
 * No clamping: the original video frame duration is used as-is to maintain
 * accurate playback speed. Clamping is applied only at the output stage
 * when writing frames (see writeFrameWithDelay in gif-encoder-service).
 *
 * @param frame - The VideoFrame to extract duration from
 * @param ctx - Per-conversion context for carry state
 * @returns An object with the duration in ms and an updated context
 */
export function getFrameDurationMs(
  frame: VideoFrame,
  ctx: FrameProcessingContext,
  fallbackMs?: number
): { durationMs: number; ctx: FrameProcessingContext } {
  const raw = frame.duration as number | null;
  if (raw == null || raw <= 0) {
    return { durationMs: fallbackMs ?? 100, ctx };
  }
  // Add any fractional remainder from previous frames
  const totalUs = raw + ctx.durationCarryUs;
  const ms = Math.round(totalUs / 1000);
  // Save the sub-millisecond remainder for next frame in new context
  const newCarry = totalUs - ms * 1000;
  return {
    durationMs: Math.max(1, ms),
    ctx: { ...ctx, durationCarryUs: newCarry },
  };
}

// ─── MAD (Mean Absolute Difference) for Frame Similarity ──────────

/**
 * Extract 8×8 grayscale samples from RGB frame data.
 * Uses center-sampling within each grid cell, matching dHash sampling positions.
 * Returns 64-byte Uint8Array with grayscale values 0-255.
 */
export function compute8x8Grayscale(
  pixelData: Uint8Array,
  width: number,
  height: number,
  pixelStride: 3 | 4 = 3
): Uint8Array {
  const gray = new Uint8Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const srcX = Math.floor(((x + 0.5) * width) / 8);
      const srcY = Math.floor(((y + 0.5) * height) / 8);
      const idx = (srcY * width + srcX) * pixelStride;
      gray[y * 8 + x] =
        ((pixelData[idx] ?? 0) + (pixelData[idx + 1] ?? 0) + (pixelData[idx + 2] ?? 0)) / 3;
    }
  }
  return gray;
}

/**
 * Compute Mean Absolute Difference between two 8×8 grayscale arrays.
 *
 * Lower = more similar. Unlike dHash (which is sensitive to compression noise
 * in gradient comparisons), MAD directly compares per-pixel intensity and
 * correlates better with human perception of frame similarity.
 *
 * Interpretation:
 * - 0.0-1.5: Nearly identical (noise only)
 * - 1.5-3.0: Very similar (tiny motion or lighting change)
 * - 3.0-6.0: Moderate change
 * - 6.0+: Significant change (different scene)
 */
export function computeMAD(current: Uint8Array, previous: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < 64; i++) {
    sum += Math.abs((current[i] ?? 0) - (previous[i] ?? 0));
  }
  return sum / 64;
}

/**
 * Get the MAD threshold for a given smart skip mode.
 * Returns -1 for 'off' (never skip).*/
export function getSkipThreshold(mode: 'off' | 'low' | 'medium' | 'high' | 'adaptive'): number {
  switch (mode) {
    case 'off':
      return -1;
    case 'adaptive':
      return -2; // signal for adaptive motion-classified decimation
    case 'low':
      return 1.5;
    case 'medium':
      return 3;
    case 'high':
      return 6;
  }
}
