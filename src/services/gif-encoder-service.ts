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

import { schedulerYield as yieldToMain } from '@piesp/browser-core/util';
import {
  GIF_LZW_RATIO,
  GIF_MAX_BUFFER_BYTES,
  GIF_MAX_FRAME_DELAY_CS,
  GIF_MIN_FRAME_DELAY_MS,
} from '@utils/constants';
import { logger } from '@utils/logger';
import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import { globalBufferPool } from './buffer-pool';
import { decodeFrames } from './decoder-service';
import type { DemuxResult } from './demuxer-service';
import { createDynamicDecimationController } from './dynamic-decimation-controller';
import type { BaseEncoderOptions } from './encoder-common';
import { convertRGBToRGBA } from './frame-utils';
import { OutputLimitError, resolveOutputLimits } from './output-limits';

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
 * Bounded to at most 3 entries (one per quality level: 0, 8, 12).
 * Each entry is a 64-element Int8Array (~64 bytes).
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
 * Quantize streaming frame delays to GIF centiseconds without accumulating
 * per-frame rounding error. The returned value is the next encoded delay in
 * centiseconds; callers skip a continuation frame when it is zero.
 */
export function createGifDelayQuantizer(): (delayMs: number) => number {
  let scheduledDurationMs = 0;
  let emittedDurationCs = 0;

  return (delayMs: number): number => {
    scheduledDurationMs += Math.max(0, delayMs);
    const targetDurationCs = Math.max(emittedDurationCs, Math.round(scheduledDurationMs / 10));
    const nextDelayCs = targetDurationCs - emittedDurationCs;
    emittedDurationCs = targetDurationCs;
    return nextDelayCs;
  };
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
  const w = Math.max(1, Math.floor(srcW * opts.scale));
  const h = Math.max(1, Math.floor(srcH * opts.scale));
  const maxColors = QUALITY_COLORS[opts.quality];
  const ditherStrength = QUALITY_DITHER_STRENGTH[opts.quality];
  const frameDecimation = opts.frameDecimation ?? 1;
  const outputLimits = resolveOutputLimits('gif', opts);

  logger.info('encoders', '  │  ├─ GIF: codec support check', { codec: demux.config.codec });

  const startTime = performance.now();

  // Streaming encoder — writes frames one at a time
  const estimatedFrames = Math.max(1, Math.floor(demux.totalFrames / (opts.frameDecimation ?? 1)));
  const estimatedBytes = Math.min(w * h * estimatedFrames * GIF_LZW_RATIO, GIF_MAX_BUFFER_BYTES);
  let initialCapacity = 1;
  const requestedInitialCapacity = Math.max(4096, Math.round(estimatedBytes));
  while (
    initialCapacity < requestedInitialCapacity &&
    initialCapacity < outputLimits.maxOutputBytes
  ) {
    initialCapacity *= 2;
  }
  const encoder = GIFEncoder({
    auto: true,
    // A power-of-two starting capacity keeps gifenc's geometric growth from
    // overshooting the power-of-two production byte ceiling.
    initialCapacity: Math.min(outputLimits.maxOutputBytes, initialCapacity),
  });

  // gifenc grows its stream automatically. Wrap every supported write method so
  // each logical write and any geometric capacity growth are authorized before
  // gifenc allocates or mutates its buffer. During growth, gifenc retains the old
  // buffer while allocating and copying into the new one, so both capacities must
  // fit inside the output memory budget simultaneously.
  let streamBytes = encoder.bytesView().byteLength;
  const originalWriteByte = encoder.stream.writeByte.bind(encoder.stream);
  const originalWriteBytes = encoder.stream.writeBytes.bind(encoder.stream);
  const originalWriteBytesView = encoder.stream.writeBytesView.bind(encoder.stream);

  function predictStreamCapacity(currentCapacity: number, requiredCapacity: number): number {
    if (currentCapacity >= requiredCapacity) return currentCapacity;
    const geometricCapacity = Math.floor(
      currentCapacity * (currentCapacity < 1024 * 1024 ? 2 : 1.125)
    );
    return Math.max(requiredCapacity, geometricCapacity, currentCapacity === 0 ? 0 : 256);
  }

  function assertCanWriteBytes(byteLength: number): void {
    const requiredCapacity = streamBytes + byteLength;
    if (!Number.isSafeInteger(requiredCapacity) || requiredCapacity > outputLimits.maxOutputBytes) {
      throw new OutputLimitError('gif', 'byte', outputLimits.maxOutputBytes);
    }

    const currentCapacity = encoder.stream.buffer.byteLength;
    if (requiredCapacity <= currentCapacity) return;
    const nextCapacity = predictStreamCapacity(currentCapacity, requiredCapacity);
    if (
      !Number.isSafeInteger(nextCapacity) ||
      nextCapacity > outputLimits.maxOutputBytes ||
      currentCapacity + nextCapacity > outputLimits.maxOutputBytes
    ) {
      throw new OutputLimitError('gif', 'byte', outputLimits.maxOutputBytes);
    }
  }

  encoder.stream.writeByte = (byte: number): void => {
    assertCanWriteBytes(1);
    originalWriteByte(byte);
    streamBytes++;
  };
  encoder.stream.writeBytes = (
    bytes: Uint8Array | number[],
    offset = 0,
    length = bytes.length - offset
  ): void => {
    const safeLength = Math.max(0, Math.min(length, bytes.length - offset));
    assertCanWriteBytes(safeLength);
    originalWriteBytes(bytes, offset, safeLength);
    streamBytes += safeLength;
  };
  encoder.stream.writeBytesView = (
    bytes: Uint8Array,
    offset = 0,
    length = bytes.byteLength - offset
  ): void => {
    const safeLength = Math.max(0, Math.min(length, bytes.byteLength - offset));
    assertCanWriteBytes(safeLength);
    originalWriteBytesView(bytes, offset, safeLength);
    streamBytes += safeLength;
  };

  let globalPalette: number[][] | null = null;
  let globalPaletteWritten = false;
  let outputTotalDelay = 0;
  const quantizeDelay = createGifDelayQuantizer();
  let encodeIdx = 0;
  let outputFrames = 0;
  let splitFrames = 0;
  let totalInputFrames = 0;
  /** Estimated total frames from demuxer — used for progress reporting only */
  let estimatedTotalFrames = 0;
  let skippedByDecimation = 0;
  let smartSkipped = 0;
  let sourceTotalMs = demux.sourceTotalMs;

  // Reusable indexed pixel buffer — avoids per-frame ~2MB allocation.
  // applyPalette() returns a new Uint8Array each call; we reuse this buffer
  // by copying the indexed data into it and passing the same reference to
  // encoder.writeFrame(). gifenc only reads the data synchronously, so reuse is safe.
  let indexedBuffer: Uint8Array | null = null;

  let accumulatedDuration = 0;

  // Dynamic decimation controller — monitors JS heap and skips frames under pressure
  const decimationController = createDynamicDecimationController();

  // Cache for applyPalette reuse: store reference to the last RGBA data quantized.
  // If the same data is passed again (e.g., re-quantization after a pool release/reacquire),
  // we can skip re-quantization. This also avoids redundant work for split frames.
  let lastQuantizedData: Uint8Array | null = null;
  let lastIndexedData: Uint8Array | null = null;

  function assertCanWriteOutputFrame(): void {
    if (outputFrames >= outputLimits.maxFrames) {
      throw new OutputLimitError('gif', 'frame', outputLimits.maxFrames);
    }
  }

  function writeIndexedFrame(indexed: Uint8Array, delay: number): void {
    const palette = globalPalette;
    if (!palette) return;
    assertCanWriteOutputFrame();
    encoder.writeFrame(indexed, w, h, {
      ...(globalPaletteWritten ? {} : { palette }),
      repeat: 0,
      delay,
    });
    outputFrames++;
    globalPaletteWritten = true;
  }

  function writeQuantizedFrame(indexed: Uint8Array, delayMs: number): boolean {
    const delayCs = quantizeDelay(delayMs);
    if (delayCs <= 0) return false;
    writeIndexedFrame(indexed, delayCs * 10);
    outputTotalDelay += delayCs;
    return true;
  }

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
      if (lastIndexedData && lastIndexedData !== indexed) {
        globalBufferPool.release(lastIndexedData);
      }
      lastQuantizedData = rgbData;
      lastIndexedData = indexed;
    }
    const requiredSize = indexed.length;
    if (!indexedBuffer || indexedBuffer.length < requiredSize) {
      if (indexedBuffer) globalBufferPool.release(indexedBuffer);
      indexedBuffer = globalBufferPool.acquire(requiredSize);
    }
    indexedBuffer.set(indexed);

    // gifenc's writeFrame expects delay in MILLISECONDS and converts
    // internally to centiseconds via Math.round(delay/10).
    // Do NOT pre-convert to cs — that would double-divide by 10.
    if (delayMs <= GIF_MAX_FRAME_DELAY_CS * 10) {
      writeQuantizedFrame(indexedBuffer, delayMs);
      return;
    }
    // Split long-delay frames into multiple writes with the same indexed data.
    // No re-quantization needed — the pixel content is identical.
    let remainingMs = delayMs;
    while (remainingMs > 0) {
      const chunk = Math.min(remainingMs, GIF_MAX_FRAME_DELAY_CS * 10);
      writeQuantizedFrame(indexedBuffer, chunk);
      remainingMs -= chunk;
      if (remainingMs > 0) splitFrames++;
    }
  }

  try {
    // Decode frames with streaming callback — each frame is encoded immediately
    const {
      totalInputFrames: totalDecoded,
      skippedByDecimation: decoderSkippedByDecimation,
      smartSkipped: decoderSmartSkipped,
      sourceTotalMs: decodedSourceTotalMs,
      tailAccumulatedMs,
    } = await decodeFrames(
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
            await yieldToMain();
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

          // Apply minimum delays (in ms, will be converted to cs in writeFrameWithDelay)
          const delay = Math.max(GIF_MIN_FRAME_DELAY_MS, totalDelayWithAccumulated);

          // Reject the next emitted frame before allocating RGBA/indexed buffers.
          assertCanWriteOutputFrame();

          // Bayer ordered dithering (applied to RGB buffer in-place)
          if (ditherStrength > 0) {
            bayerDitherRGB(rgbData, w, h, ditherStrength);
          }

          let rgbReleased = false;
          let rgba: Uint8Array | null = null;
          try {
            // Convert RGB → RGBA for gifenc compatibility (pooled).
            rgba = convertRGBToRGBA(rgbData, w, h);
            // The encoder now owns the RGBA buffer; the source RGB buffer is no
            // longer needed after conversion.
            globalBufferPool.release(rgbData);
            rgbReleased = true;

            // Quantize: compute global palette from first frame, reuse for subsequent
            if (encodeIdx === 0) {
              globalPalette = quantize(rgba, maxColors, { format: 'rgb565' });
            }

            writeFrameWithDelay(rgba, delay);
          } finally {
            if (!rgbReleased) {
              globalBufferPool.release(rgbData);
            }
            // Invalidate the quantize cache: lastQuantizedData points to the
            // RGBA buffer being returned to the pool, so it is no longer valid.
            if (lastQuantizedData === rgba) {
              lastQuantizedData = null;
            }
            if (rgba) {
              globalBufferPool.release(rgba);
            }
          }

          // Report encoding progress (50~90% range in pipeline)
          if (opts.onFrameEncoded) {
            opts.onFrameEncoded(encodeIdx, estimatedTotalFrames);
          }

          encodeIdx++;
        },
      },
      signal
    );
    sourceTotalMs = decodedSourceTotalMs;

    totalInputFrames = totalDecoded;
    skippedByDecimation = decoderSkippedByDecimation;
    smartSkipped = decoderSmartSkipped;

    if (encodeIdx === 0) {
      throw new Error('No frames decoded for GIF encoding');
    }

    // ── Tail accumulated duration fix ──
    // In streaming mode, frames skipped after the last kept frame have their
    // durations accumulated by the decoder but never consumed. Add this tail
    // duration as extra delay on the last frame by writing a continuation frame
    // with the same pixel data and only the tail delay.
    const totalTailDuration = tailAccumulatedMs + accumulatedDuration;
    if (totalTailDuration > 0 && lastIndexedData && globalPalette) {
      // Pass ms directly — gifenc converts ms→cs internally via Math.round(delay/10)
      let remainingTailMs = totalTailDuration;
      while (remainingTailMs > 0) {
        if (signal?.aborted) throw new DOMException('Conversion cancelled', 'AbortError');
        const delay = Math.min(remainingTailMs, GIF_MAX_FRAME_DELAY_CS * 10);
        writeQuantizedFrame(lastIndexedData, delay);
        remainingTailMs -= delay;
        if (remainingTailMs > 0) splitFrames++;
        if ((splitFrames & 63) === 0) await yieldToMain();
      }
      logger.info('encoders', 'GIF tail duration added', {
        tailMs: Math.round(totalTailDuration),
        tailCs: Math.round(totalTailDuration / 10),
      });
    }

    encoder.finish();
    const streamCapacity = encoder.stream.buffer.byteLength;
    const finalCopyPeakBytes = streamCapacity + streamBytes;
    if (
      !Number.isSafeInteger(finalCopyPeakBytes) ||
      finalCopyPeakBytes > outputLimits.maxOutputBytes
    ) {
      throw new OutputLimitError('gif', 'byte', outputLimits.maxOutputBytes);
    }
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
      smartSkipped,
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
      smartSkipped,
    });

    return rawBytes;
  } finally {
    // Release indexed buffer back to pool if it was allocated
    if (indexedBuffer) {
      globalBufferPool.release(indexedBuffer);
      indexedBuffer = null;
    }
    if (lastIndexedData) {
      globalBufferPool.release(lastIndexedData);
      lastIndexedData = null;
    }
  }
}
