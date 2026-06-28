// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * GIF Encoder Service — Streaming Architecture
 *
 * Interleaves decoding and encoding: frames are encoded immediately after
 * decoding, so only 1 RGB + 1 RGBA buffer exists in memory at any time.
 *
 * Previous architecture held ALL decoded frames in an array, causing:
 *   - 1080p @ 30fps × 5s = 146 frames × 6MB = ~900MB peak
 *   - GC thrashing from per-frame allocations
 *
 * New architecture peak: ~12MB (1 RGB + 1 RGBA + encoder internal buffer)
 *
 * Pipeline:
 *   1. decodeFrames streams frames via callback (no array accumulation)
 *   2. Per frame: dither → RGB→RGBA (pooled) → quantize/applyPalette → writeFrame
 *   3. Encoder writes GIF incrementally
 */

import {
  GIF_LZW_RATIO,
  GIF_MAX_BUFFER_BYTES,
  GIF_MAX_FRAME_DELAY_CS,
  GIF_MIN_FIRST_FRAME_DELAY_MS,
  GIF_MIN_FRAME_DELAY_MS,
} from '@utils/constants';
import { logger } from '@utils/logger';
import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import { globalBufferPool } from './buffer-pool';
import { decodeFrames } from './decoder-service';
import type { DemuxResult } from './demuxer-service';
import { createDynamicDecimationController } from './dynamic-decimation-controller';
import type { BaseEncoderOptions } from './encoder-common';

const QUALITY_COLORS: Record<BaseEncoderOptions['quality'], number> = {
  low: 64, // 128 → 64: perceptual studies show banding is visible below ~32 colors,
  // but 64 colors provides acceptable quality for "low" preset while
  // reducing palette computation time and file size
  medium: 128,
  high: 256,
};

// Bayer ordered dithering strength per quality (0-255 range, lower = subtler)
// low quality: dithering disabled (0) — fewer colors don't benefit from dithering
const QUALITY_DITHER_STRENGTH: Record<BaseEncoderOptions['quality'], number> = {
  low: 0,
  medium: 8,
  high: 12, // 4 → 12: high quality needs stronger dithering to produce
  // smooth gradients with full 256-color palette; 4 was too subtle
};

/**
 * Convert RGB (3 bytes/pixel) to RGBA (4 bytes/pixel) using buffer pool.
 * gifenc's quantize() and applyPalette() require RGBA input because they
 * internally cast the buffer to Uint32Array (4-byte aligned).
 *
 * Optimization: Uses Uint32Array view to write 4 bytes at a time.
 * Instead of 4 separate byte writes per pixel, we pack R,G,B,0xFF into
 * a single uint32 write. This reduces loop overhead by ~4x.
 *
 * For a 1080p frame (2M pixels), this saves ~1-2ms vs byte-by-byte copy.
 */
function rgbToRgbaPooled(rgb: Uint8Array, width: number, height: number): Uint8Array {
  const pixelCount = width * height;
  const rgba = globalBufferPool.acquire(pixelCount * 4);

  // Uint32Array view over the RGBA buffer for 4-byte-at-a-time writes
  const rgba32 = new Uint32Array(rgba.buffer, rgba.byteOffset, pixelCount);

  // Little-endian: uint32 = 0xAABBGGRR → bytes [RR, GG, BB, AA]
  // We want [R, G, B, 0xFF] → uint32 = 0xFF << 24 | B << 16 | G << 8 | R
  for (let i = 0; i < pixelCount; i++) {
    const srcIdx = i * 3;
    const r = rgb[srcIdx]!;
    const g = rgb[srcIdx + 1]!;
    const b = rgb[srcIdx + 2]!;
    rgba32[i] = (0xff << 24) | (b << 16) | (g << 8) | r;
  }

  return rgba;
}

// ─── Bayer Ordered Dithering ────────────────────────────────────────

// Bayer ordered dithering 8x8 pattern (pre-normalized to 0-63 range)
const BAYER_8X8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

/**
 * Pre-computed scaled threshold LUT cache.
 * Key = dither strength (0-255), Value = flattened 64-element Int8Array.
 *
 * Instead of computing (BAYER[y][x] - 32) * scale per-pixel per-frame,
 * we pre-compute the threshold for each quality's strength once.
 */
const DITHER_LUT_CACHE: Map<number, Int8Array> = new Map();

function getDitherLUT(strength: number): Int8Array {
  let lut = DITHER_LUT_CACHE.get(strength);
  if (lut) return lut;

  const scale = strength / 64;
  lut = new Int8Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      lut[y * 8 + x] = ((BAYER_8X8[y]![x]! - 32) * scale) | 0;
    }
  }
  DITHER_LUT_CACHE.set(strength, lut);
  return lut;
}

/**
 * Apply Bayer ordered dithering to RGB buffer in-place.
 * Uses pre-computed LUT for thresholds — avoids per-pixel multiply.
 * Skips pixels where threshold === 0 (1/64 of pixels at strength=8).
 */
function bayerDitherRGB(rgb: Uint8Array, width: number, height: number, strength: number): void {
  if (strength <= 0) return;

  const lut = getDitherLUT(strength);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * 3;
    const lutRow = y & 7;
    for (let x = 0; x < width; x++) {
      const threshold = lut[lutRow * 8 + (x & 7)]!;
      if (threshold === 0) continue;

      const idx = rowOffset + x * 3;
      const r = rgb[idx]!;
      const g = rgb[idx + 1]!;
      const b = rgb[idx + 2]!;

      const rt = r + threshold;
      const gt = g + threshold;
      const bt = b + threshold;
      rgb[idx] = rt < 0 ? 0 : rt > 255 ? 255 : rt;
      rgb[idx + 1] = gt < 0 ? 0 : gt > 255 ? 255 : gt;
      rgb[idx + 2] = bt < 0 ? 0 : bt > 255 ? 255 : bt;
    }
  }
}

/**
 * Encode demuxed video frames to GIF with streaming decode→encode.
 *
 * Instead of collecting all decoded frames into an array first, each frame
 * is encoded immediately upon decoding. This reduces peak memory from
 * O(N × frame_size) to O(frame_size).
 */
export async function encodeGif(
  demux: DemuxResult,
  opts: BaseEncoderOptions,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const srcW = opts.width;
  const srcH = opts.height;
  const w = Math.floor(srcW * opts.scale);
  const h = Math.floor(srcH * opts.scale);
  const maxColors = QUALITY_COLORS[opts.quality];
  const ditherStrength = QUALITY_DITHER_STRENGTH[opts.quality];
  const frameDecimation = opts.frameDecimation ?? 1;

  logger.info('encoders', '  │  ├─ GIF: codec support check', { codec: demux.config.codec });

  const startTime = performance.now();

  // Streaming encoder — writes frames one at a time
  const estimatedFrames = Math.max(1, Math.floor(demux.totalFrames / (opts.frameDecimation ?? 1)));
  const estimatedBytes = Math.min(w * h * estimatedFrames * GIF_LZW_RATIO, GIF_MAX_BUFFER_BYTES);
  const encoder = GIFEncoder({
    auto: true,
    initialCapacity: Math.max(4096, Math.round(estimatedBytes)),
  });

  let globalPalette: number[][] | null = null;
  let outputTotalDelay = 0;
  let encodeIdx = 0;
  let splitFrames = 0;
  let totalInputFrames = 0;
  /** Estimated total frames from demuxer — used for progress reporting only */
  let estimatedTotalFrames = 0;
  let skippedByDecimation = 0;
  const sourceTotalMs = demux.chunks.reduce((sum, ch) => sum + (ch.duration ?? 0), 0) / 1000;

  // Reusable indexed pixel buffer — avoids per-frame ~2MB allocation.
  // applyPalette() returns a new Uint8Array each call; we reuse this buffer
  // by copying the indexed data into it and passing the same reference to
  // encoder.writeFrame(). gifenc only reads the data synchronously, so reuse is safe.
  let indexedBuffer: Uint8Array | null = null;

  // T2: Maximum delay per frame — prevents a single frame from displaying too long
  // gifenc's writeFrame delay is in centiseconds (cs), so convert from ms.
  const MAX_FRAME_DELAY_CS = GIF_MAX_FRAME_DELAY_CS;
  // Minimum delay for the first frame — ensures it's visible to human eyes
  // Converted from ms to centiseconds (÷10) for gifenc API.
  const MIN_FIRST_FRAME_DELAY_CS = Math.round(GIF_MIN_FIRST_FRAME_DELAY_MS / 10);
  // Minimum delay for any frame — frames shorter than this are perceptually instant
  const MIN_FRAME_DELAY_CS = Math.round(GIF_MIN_FRAME_DELAY_MS / 10);

  let accumulatedDuration = 0;

  // Dynamic decimation controller — monitors JS heap and skips frames under pressure
  const decimationController = createDynamicDecimationController();

  // Cache for applyPalette reuse: store reference to the last RGBA data quantized.
  // If the same data is passed again (e.g., re-quantization after a pool release/reacquire),
  // we can skip re-quantization. This also avoids redundant work for split frames.
  let lastQuantizedData: Uint8Array | null = null;
  let lastIndexedData: Uint8Array | null = null;

  function writeFrameWithDelay(rgbData: Uint8Array, delayMs: number): void {
    const pal = globalPalette;
    if (!pal) return;
    // Quantize once — applyPalette allocates ~2MB per call at 1080p.
    // Reuse the cached indexed data if the source data hasn't changed.
    let indexed: Uint8Array;
    if (lastQuantizedData === rgbData && lastIndexedData) {
      indexed = lastIndexedData;
    } else {
      indexed = applyPalette(rgbData, pal, 'rgb565');
      lastQuantizedData = rgbData;
      lastIndexedData = indexed;
    }
    const requiredSize = indexed.length;
    if (!indexedBuffer || indexedBuffer.length < requiredSize) {
      if (indexedBuffer) globalBufferPool.release(indexedBuffer);
      indexedBuffer = globalBufferPool.acquire(requiredSize);
    }
    indexedBuffer.set(indexed);

    // Convert ms → centiseconds for gifenc writeFrame API
    let remainingCs = Math.round(delayMs / 10);
    if (remainingCs <= MAX_FRAME_DELAY_CS) {
      encoder.writeFrame(indexedBuffer, w, h, { palette: pal, repeat: 0, delay: remainingCs });
      outputTotalDelay += remainingCs;
      return;
    }
    // Split long-delay frames into multiple writes with the same indexed data.
    // No re-quantization needed — the pixel content is identical.
    while (remainingCs > 0) {
      const chunk = Math.min(remainingCs, MAX_FRAME_DELAY_CS);
      encoder.writeFrame(indexedBuffer, w, h, { palette: pal, repeat: 0, delay: chunk });
      outputTotalDelay += chunk;
      remainingCs -= chunk;
      if (remainingCs > 0) splitFrames++;
    }
  }

  try {
    // Decode frames with streaming callback — each frame is encoded immediately
    const { totalInputFrames: totalDecoded } = await decodeFrames(
      demux,
      {
        width: w,
        height: h,
        frameDecimation,
        hwAccel: 'prefer-hardware',
        smartFrameSkip: opts.smartFrameSkip,
        onFrameDecoded: (_frameNum, total) => {
          estimatedTotalFrames = total;
          // Report decoding progress — throttle to every 10 frames
          if (opts.onFrameDecoded && (encodeIdx % 10 === 0 || encodeIdx === 0)) {
            opts.onFrameDecoded(encodeIdx, total);
          }
        },
        // Streaming callback: encode each frame immediately upon decoding
        onFrameAvailable: async (
          rgbData: Uint8Array,
          frameDurationMs: number,
          frameNum: number
        ) => {
          if (signal?.aborted) {
            globalBufferPool.release(rgbData);
            throw new DOMException('Cancelled', 'AbortError');
          }

          totalInputFrames = frameNum;

          // Yield to browser event loop every 5 frames to prevent UI freezing.
          // Per-frame setTimeout(0) adds 1-4ms overhead per frame (150-600ms total
          // for a 150-frame video). Yielding every 5 frames reduces this to ~30-120ms
          // while still keeping the UI responsive.
          if (frameNum % 5 === 0) {
            await Promise.resolve();
          }

          // ── Dynamic decimation based on memory pressure ──
          const shouldSkip = decimationController.shouldSkip(frameNum);

          if (shouldSkip) {
            // Skip this frame: accumulate its duration and release buffer
            accumulatedDuration += frameDurationMs;
            globalBufferPool.release(rgbData);
            return;
          }

          // Accumulate duration from skipped frames (both decoder decimation + dynamic skip)
          const totalDelayWithAccumulated = frameDurationMs + accumulatedDuration;
          accumulatedDuration = 0;

          const isFirstFrame = encodeIdx === 0;

          // Apply minimum delays (in ms, will be converted to cs in writeFrameWithDelay)
          let delay: number;
          if (isFirstFrame) {
            delay = Math.max(GIF_MIN_FIRST_FRAME_DELAY_MS, totalDelayWithAccumulated);
          } else {
            delay = Math.max(GIF_MIN_FRAME_DELAY_MS, totalDelayWithAccumulated);
          }

          // Bayer ordered dithering (applied to RGB buffer in-place)
          if (ditherStrength > 0) {
            bayerDitherRGB(rgbData, w, h, ditherStrength);
          }

          // Convert RGB → RGBA for gifenc compatibility (pooled)
          const rgba = rgbToRgbaPooled(rgbData, w, h);
          // Release the RGB buffer back to pool immediately
          globalBufferPool.release(rgbData);

          // Quantize: compute global palette from first frame, reuse for subsequent
          if (encodeIdx === 0) {
            globalPalette = quantize(rgba, maxColors, { format: 'rgb565' });
          }

          writeFrameWithDelay(rgba, delay);
          // Release RGBA buffer after encoding
          // Invalidate cache since this buffer may be reused by the pool
          if (lastQuantizedData === rgba) {
            lastQuantizedData = null;
            lastIndexedData = null;
          }
          globalBufferPool.release(rgba);

          // Report encoding progress (50~90% range in pipeline)
          if (opts.onFrameEncoded) {
            opts.onFrameEncoded(encodeIdx, estimatedTotalFrames);
          }

          encodeIdx++;
        },
      },
      signal
    );

    totalInputFrames = totalDecoded;
    // Compute skippedByDecimation from decoder stats
    skippedByDecimation = totalInputFrames - encodeIdx;

    if (encodeIdx === 0) {
      throw new Error('No frames decoded for GIF encoding');
    }

    encoder.finish();
    const rawBytes = encoder.bytes();
    const totalElapsed = (performance.now() - startTime) / 1000;

    logger.info('encoders', 'GIF encoding complete', {
      decodedFrames: totalInputFrames,
      keptFrames: encodeIdx,
      totalFrames: demux.totalFrames,
      outputBytes: rawBytes.length,
      fps: Math.round(encodeIdx / totalElapsed),
      duration: `${totalElapsed.toFixed(2)}s`,
      resolution: `${w}×${h}`,
      quality: opts.quality,
      maxColors,
      frameDecimation,
      skippedByDecimation,
      splitFrames,
      sourceDurationMs: Math.round(sourceTotalMs),
      outputDurationCs: Math.round(outputTotalDelay),
      timingErrorCs: Math.round(outputTotalDelay - Math.round(sourceTotalMs / 10)),
      dynamicSkipCount: decimationController.getSkipCount(),
    });
    logger.info('encoders', '  │  └─ GIF: encode finished', {
      keptFrames: encodeIdx,
      outputBytes: rawBytes.length,
      duration: `${totalElapsed.toFixed(2)}s`,
      skippedByDecimation,
    });

    return rawBytes;
  } finally {
    // Release indexed buffer back to pool if it was allocated
    if (indexedBuffer) {
      globalBufferPool.release(indexedBuffer);
      indexedBuffer = null;
    }
  }
}
