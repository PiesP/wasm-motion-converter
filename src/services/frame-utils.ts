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

import type { VideoRotation } from '@t/conversion-types';
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
  rotation?: VideoRotation | undefined;
}

/**
 * Resolve square-pixel output dimensions from decoder config, preferring display
 * aspect dimensions over coded dimensions and raw display dimensions.
 * Returns null if no valid dimensions can be determined.
 */
export function resolveVideoDimensions(
  config: VideoConfigWithDimensions
): { width: number; height: number } | null {
  if (
    config.rotation !== undefined &&
    config.rotation !== 0 &&
    config.rotation !== 90 &&
    config.rotation !== 180 &&
    config.rotation !== 270
  ) {
    return null;
  }
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
  return config.rotation === 90 || config.rotation === 270
    ? { width: height, height: width }
    : { width, height };
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

export async function copyFrameToPixels(
  frame: VideoFrame,
  width: number,
  height: number,
  ctx: FrameProcessingContext,
  pixelFormat: CpuPixelFormat,
  rotation: VideoRotation = 0
): Promise<Uint8Array> {
  const srcW = frame.codedWidth ?? frame.displayWidth;
  const srcH = frame.codedHeight ?? frame.displayHeight;
  const needsScaling = srcW !== width || srcH !== height;
  const needsTransform = rotation !== 0;

  if (ctx.copyPath === 'canvas' || needsScaling || needsTransform) {
    ctx.copyPath = 'canvas';
    return copyFrameCanvas(frame, width, height, pixelFormat, rotation);
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
  return copyFrameCanvas(frame, width, height, pixelFormat, rotation);
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
  pixelFormat: CpuPixelFormat,
  rotation: VideoRotation
): Promise<Uint8Array> {
  const { ctx } = getOrCreateCanvas(width, height);

  // Clear canvas before drawing (reuses same canvas across frames)
  if (rotation !== 0) ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // Try GPU-accelerated scaling via createImageBitmap first.
  // Falls back to canvas drawImage on failure (e.g., exotic codecs, old browsers).
  if (rotation === 0) {
    if (frame.displayWidth === width && frame.displayHeight === height) {
      ctx.drawImage(frame, 0, 0);
      const imageData = ctx.getImageData(0, 0, width, height);
      return convertImageData(imageData, width, height, pixelFormat);
    }

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
  }

  const drawWidth = rotation === 90 || rotation === 270 ? height : width;
  const drawHeight = rotation === 90 || rotation === 270 ? width : height;
  try {
    if (rotation === 90) {
      ctx.translate(width, 0);
      ctx.rotate(Math.PI / 2);
    } else if (rotation === 180) {
      ctx.translate(width, height);
      ctx.rotate(Math.PI);
    } else if (rotation === 270) {
      ctx.translate(0, height);
      ctx.rotate(-Math.PI / 2);
    }
    // The five-argument overload uses VideoFrame's visible intrinsic image.
    // Using coded dimensions as a source rectangle can include padded codec rows.
    ctx.drawImage(frame, 0, 0, drawWidth, drawHeight);
  } finally {
    if (rotation !== 0) ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

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
  fallbackMs?: number,
  durationUs?: number
): { durationMs: number; ctx: FrameProcessingContext } {
  const raw = durationUs ?? frame.duration;
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

// ─── Bounded, approximate frame-motion comparison ──────────────────

const MOTION_TILE_COLUMNS = 16;
const MOTION_TILE_COUNT = MOTION_TILE_COLUMNS * MOTION_TILE_COLUMNS;
const MOTION_CHANNELS = 3;

/** Two ordered signatures, including all typed-array backing storage. */
export const MOTION_SIGNATURE_PEAK_BYTES =
  2 * MOTION_TILE_COUNT * (MOTION_CHANNELS * (3 + 4 + 8 + 8) + 4);

/**
 * RGB area statistics for a fixed spatial grid. Every source pixel contributes
 * to one tile. Color sums and first spatial moments retain cursor position
 * within tiles; each retained signature owns 18,688 bytes at any frame size.
 * This is an approximation: different images can have equal tile statistics,
 * including rearrangements that preserve all first moments and color extrema.
 */
export interface MotionSignature {
  readonly width: number;
  readonly height: number;
  readonly means: Uint8Array;
  readonly colorSums: Uint32Array;
  readonly minima: Uint8Array;
  readonly maxima: Uint8Array;
  readonly counts: Uint32Array;
  readonly horizontalMoments: Float64Array;
  readonly verticalMoments: Float64Array;
}

export interface MotionComparison {
  /** Area-weighted mean of RGB tile differences, in the 0–255 range. */
  readonly globalDistance: number;
  /** Strongest tile change, including a guarded color-extrema change. */
  readonly localDistance: number;
  /** Conservative motion score suitable for existing skip thresholds. */
  readonly distance: number;
}

export function computeMotionSignature(
  pixelData: Uint8Array,
  width: number,
  height: number,
  pixelStride: 3 | 4 = 3
): MotionSignature {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_FRAME_PIXEL_COUNT / height ||
    pixelData.byteLength < width * height * pixelStride
  ) {
    throw new RangeError('Invalid motion signature frame dimensions or pixels');
  }

  const sums = new Uint32Array(MOTION_TILE_COUNT * MOTION_CHANNELS);
  const counts = new Uint32Array(MOTION_TILE_COUNT);
  // Keep unrounded integer sums. At the hard pixel ceiling, tile-relative
  // coordinates keep every weighted sum below Number.MAX_SAFE_INTEGER.
  const horizontalMoments = new Float64Array(sums.length);
  const verticalMoments = new Float64Array(sums.length);
  const minima = new Uint8Array(sums.length);
  const maxima = new Uint8Array(sums.length);
  minima.fill(255);

  for (let y = 0; y < height; y++) {
    const tileRow = Math.min(
      MOTION_TILE_COLUMNS - 1,
      Math.floor((y * MOTION_TILE_COLUMNS) / height)
    );
    for (let x = 0; x < width; x++) {
      const tileColumn = Math.min(
        MOTION_TILE_COLUMNS - 1,
        Math.floor((x * MOTION_TILE_COLUMNS) / width)
      );
      const tile = tileRow * MOTION_TILE_COLUMNS + tileColumn;
      const tileOffset = tile * MOTION_CHANNELS;
      const localX = x - Math.ceil((tileColumn * width) / MOTION_TILE_COLUMNS);
      const localY = y - Math.ceil((tileRow * height) / MOTION_TILE_COLUMNS);
      const pixelOffset = (y * width + x) * pixelStride;
      counts[tile]!++;
      for (let channel = 0; channel < MOTION_CHANNELS; channel++) {
        const value = pixelData[pixelOffset + channel]!;
        const offset = tileOffset + channel;
        sums[offset] = sums[offset]! + value;
        horizontalMoments[offset] = horizontalMoments[offset]! + value * localX;
        verticalMoments[offset] = verticalMoments[offset]! + value * localY;
        if (value < minima[offset]!) minima[offset] = value;
        if (value > maxima[offset]!) maxima[offset] = value;
      }
    }
  }

  const means = new Uint8Array(sums.length);
  for (let tile = 0; tile < MOTION_TILE_COUNT; tile++) {
    const count = counts[tile]!;
    if (count === 0) continue;
    for (let channel = 0; channel < MOTION_CHANNELS; channel++) {
      const offset = tile * MOTION_CHANNELS + channel;
      means[offset] = Math.round(sums[offset]! / count);
    }
  }
  return {
    width,
    height,
    means,
    colorSums: sums,
    minima,
    maxima,
    counts,
    horizontalMoments,
    verticalMoments,
  };
}

export function compareMotionSignatures(
  current: MotionSignature,
  previous: MotionSignature
): MotionComparison {
  if (current.width !== previous.width || current.height !== previous.height) {
    throw new RangeError('Motion signatures must have matching dimensions');
  }

  let weightedDistance = 0;
  let localDistance = 0;
  for (let tile = 0; tile < MOTION_TILE_COUNT; tile++) {
    const count = current.counts[tile]!;
    if (count === 0) continue;
    let meanDifference = 0;
    let extremaDifference = 0;
    let spatialChange = false;
    let appearanceChange = false;
    let colorRange = 0;
    for (let channel = 0; channel < MOTION_CHANNELS; channel++) {
      const offset = tile * MOTION_CHANNELS + channel;
      meanDifference += Math.abs(current.means[offset]! - previous.means[offset]!);
      const channelRange = Math.max(
        current.maxima[offset]! - current.minima[offset]!,
        previous.maxima[offset]! - previous.minima[offset]!
      );
      spatialChange ||=
        channelRange >= 64 &&
        current.colorSums[offset] === previous.colorSums[offset] &&
        Math.max(
          Math.abs(current.horizontalMoments[offset]! - previous.horizontalMoments[offset]!),
          Math.abs(current.verticalMoments[offset]! - previous.verticalMoments[offset]!)
        ) >= channelRange;
      appearanceChange ||=
        Math.abs(current.colorSums[offset]! - previous.colorSums[offset]!) >= 64 &&
        channelRange >= 64;
      colorRange = Math.max(
        colorRange,
        current.maxima[offset]! - current.minima[offset]!,
        previous.maxima[offset]! - previous.minima[offset]!
      );
      extremaDifference = Math.max(
        extremaDifference,
        Math.abs(current.minima[offset]! - previous.minima[offset]!),
        Math.abs(current.maxima[offset]! - previous.maxima[offset]!)
      );
    }
    const tileDistance = meanDifference / MOTION_CHANNELS;
    weightedDistance += tileDistance * count;
    // A single changed codec-noise pixel should not dominate an otherwise
    // unchanged tile. Strong extrema count only when its area mean moved too.
    const safeguardedDistance =
      tileDistance >= 1 && extremaDifference >= 32
        ? Math.max(tileDistance, extremaDifference)
        : tileDistance;
    // A high-contrast cursor/text change must survive dilution in a large tile.
    // Require stable unrounded channel sums and a contrast-sized displacement
    // so a one-level codec fluctuation cannot alone trigger the safeguard.
    // Balanced textured noise may still be retained; this is approximate motion
    // detection, never a lossless equality decision.
    const spatialSafeguard = (spatialChange && colorRange >= 64) || appearanceChange ? 7 : 0;
    localDistance = Math.max(localDistance, safeguardedDistance, spatialSafeguard);
  }

  const globalDistance = weightedDistance / (current.width * current.height);
  return { globalDistance, localDistance, distance: Math.max(globalDistance, localDistance) };
}

/**
 * Get the approximate motion threshold for a given smart skip mode.
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
