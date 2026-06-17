// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { logger } from '@utils/logger';
import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import type { ConversionProgress } from '@/types/v2-conversion-types';
import type { DemuxResult } from './demuxer-service';
import { copyFrameToRGB, getFrameDurationMs, isDuplicateFrameAdaptive } from './frame-utils';

export interface GifEncodeOptions {
  width: number;
  height: number;
  quality: 'low' | 'medium' | 'high';
  scale: number;
  /** Frame decimation: keep every Nth frame (1 = keep all, 2 = keep 50%, etc.) */
  frameDecimation?: number;
  /** Enable frame deduplication (dHash-based) */
  deduplicate?: boolean;
  /** dHash threshold for deduplication (0-64, lower = stricter) */
  dedupThreshold?: number;
}

const QUALITY_COLORS: Record<GifEncodeOptions['quality'], number> = {
  low: 64,
  medium: 128,
  high: 256,
};

// Bayer ordered dithering strength per quality (0-255 range, lower = subtler)
const QUALITY_DITHER_STRENGTH: Record<GifEncodeOptions['quality'], number> = {
  low: 12,
  medium: 8,
  high: 4,
};

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

function bayerDitherRGB(rgb: Uint8Array, width: number, height: number, strength: number): void {
  if (strength <= 0) return;
  const scale = strength / 64;
  for (let y = 0; y < height; y++) {
    const by = BAYER_8X8[y & 7]!;
    for (let x = 0; x < width; x++) {
      const threshold = (by[x & 7]! - 32) * scale;
      const idx = (y * width + x) * 3;
      const r = rgb[idx]!;
      const g = rgb[idx + 1]!;
      const b = rgb[idx + 2]!;
      rgb[idx] = r + threshold < 0 ? 0 : r + threshold > 255 ? 255 : (r + threshold) | 0;
      rgb[idx + 1] = g + threshold < 0 ? 0 : g + threshold > 255 ? 255 : (g + threshold) | 0;
      rgb[idx + 2] = b + threshold < 0 ? 0 : b + threshold > 255 ? 255 : (b + threshold) | 0;
    }
  }
}

export type GifProgressCallback = (progress: ConversionProgress) => void;

/**
 * Encode demuxed video frames to GIF using streaming encoding + gifsicle post-processing.
 *
 * Pipeline:
 *   1. VideoDecoder (hardware-accelerated) → frame queue
 *   2. Per-frame: copyTo RGB → dither → quantize → writeFrame
 *   3. Post-process: gifsicle -O1 --lossy for 30-50% size reduction
 */
export async function encodeGif(
  demux: DemuxResult,
  opts: GifEncodeOptions,
  onProgress?: GifProgressCallback,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const srcW = opts.width;
  const srcH = opts.height;
  const w = Math.floor(srcW * opts.scale);
  const h = Math.floor(srcH * opts.scale);
  const maxColors = QUALITY_COLORS[opts.quality];
  const ditherStrength = QUALITY_DITHER_STRENGTH[opts.quality];
  const needsResize = w !== srcW || h !== srcH;
  const frameDecimation = opts.frameDecimation ?? 1;
  const doDedup = opts.deduplicate ?? true;
  const dedupThreshold = opts.dedupThreshold ?? 8;

  logger.info('encoders', '  │  ├─ GIF: codec support check', { codec: demux.config.codec });

  // Check codec support
  const support = await VideoDecoder.isConfigSupported(demux.config);
  if (!support.supported) {
    logger.warn('encoders', '  │  ├─ GIF: codec NOT supported', { codec: demux.config.codec });
    throw new Error(`Codec not supported: ${demux.config.codec}`);
  }

  logger.info('encoders', '  │  ├─ GIF: VideoDecoder configured', {
    codec: demux.config.codec,
    hwAccel: support.supported ? 'prefer-hardware' : 'prefer-software',
    resolution: `${w}×${h}`,
    maxColors,
    quality: opts.quality,
    scale: opts.scale,
    frameDecimation,
    dedupEnabled: doDedup,
    dedupThreshold,
  });

  const startTime = performance.now();

  // Collect RGB frames with immediate VideoFrame disposal + deduplication
  // Pipeline: VideoDecoder.output → copyFrameToRGB (async) → write to GIF encoder
  // Each conversion starts immediately in the decoder callback so flush() waits
  // for both decode + convert concurrently (same pattern as WebP encoder).
  const pendingConversions: Promise<void>[] = [];
  const rgbFrames: { data: Uint8Array; duration: number }[] = [];
  let decodeError: Error | null = null;
  let inputFrameCount = 0;
  let accumulatedDuration = 0;
  let skippedByDecimation = 0;
  let skippedByDedup = 0;
  let splitFrames = 0;
  let encodeIdx = 0;

  // T2: Maximum delay per frame — prevents a single frame from displaying too long
  const MAX_FRAME_DELAY = 200;
  // Safety: don't dedup more than 90% of frames
  const MAX_DEDUP_RATIO = 0.9;

  // Streaming GIF encoder — writes frames one at a time
  // Estimate initial capacity: width * height * estimatedFrames * 0.1 (LZW ~10:1)
  const estimatedFrames = Math.max(1, Math.floor(demux.totalFrames / (opts.frameDecimation ?? 1)));
  const estimatedBytes = Math.min(w * h * estimatedFrames * 0.1, 32 * 1024 * 1024);
  const encoder = GIFEncoder({
    auto: true,
    initialCapacity: Math.max(4096, Math.round(estimatedBytes)),
  });
  let globalPalette: number[][] | null = null;
  let outputTotalDelay = 0;
  const sourceTotalDelay = demux.chunks.reduce((sum, ch) => sum + (ch.duration ?? 0), 0) / 1000;

  function writeFrameWithDelay(rgbData: Uint8Array, delayMs: number): void {
    let remaining = delayMs;
    if (remaining <= MAX_FRAME_DELAY) {
      const pal = globalPalette;
      if (!pal) return;
      const indexed = applyPalette(rgbData, pal, 'rgb565');
      encoder.writeFrame(indexed, w, h, { palette: pal, repeat: 0, delay: remaining });
      outputTotalDelay += remaining;
      return;
    }
    while (remaining > 0) {
      const chunk = Math.min(remaining, MAX_FRAME_DELAY);
      const pal = globalPalette;
      if (!pal) return;
      const indexed = applyPalette(rgbData, pal, 'rgb565');
      encoder.writeFrame(indexed, w, h, { palette: pal, repeat: 0, delay: chunk });
      outputTotalDelay += chunk;
      remaining -= chunk;
      if (remaining > 0) splitFrames++;
    }
  }

  // H2: Hardware-accelerated decoding (with fallback)
  const decoder = new VideoDecoder({
    output(frame: VideoFrame) {
      const frameDuration = getFrameDurationMs(frame);
      const frameNum = inputFrameCount++;

      // F2: Frame decimation — skip every Nth frame
      if (frameDecimation > 1 && frameNum % frameDecimation !== 0) {
        accumulatedDuration += frameDuration;
        frame.close();
        skippedByDecimation++;
        return;
      }

      const totalDuration = frameDuration + accumulatedDuration;
      accumulatedDuration = 0;

      const conversion = (async () => {
        try {
          const rgbData = await copyFrameToRGB(frame, w, h, needsResize);
          rgbFrames.push({ data: rgbData, duration: totalDuration });
        } finally {
          frame.close();
        }
      })();
      pendingConversions.push(conversion);

      // Intermediate progress every ~5% of input frames
      const reportInterval = Math.max(1, Math.floor(demux.totalFrames / 20));
      if (onProgress && frameNum % reportInterval === 0) {
        const elapsed = (performance.now() - startTime) / 1000;
        onProgress({
          phase: 'encoding',
          progress: Math.round((frameNum / demux.totalFrames) * 100),
          fps: Math.round(frameNum / elapsed),
          etaSeconds: null,
          memoryMB: 0,
          currentFrame: frameNum,
          totalFrames: demux.totalFrames,
          elapsedMs: Math.round(performance.now() - startTime),
        });
      }
    },
    error(e: Error) {
      logger.error('encoders', 'GIF VideoDecoder error', {
        codec: demux.config.codec,
        error: e.message,
      });
      decodeError = e;
    },
  });

  const swConfig = { ...demux.config, hardwareAcceleration: 'prefer-software' as const };
  decoder.configure(swConfig);

  // Feed all chunks
  for (const chunk of demux.chunks) {
    if (signal?.aborted) {
      if (decoder.state !== 'closed') decoder.close();
      throw new DOMException('Cancelled', 'AbortError');
    }
    if (decodeError) break;
    decoder.decode(chunk);
  }

  // Flush decoder — resolves when all decode + convert are done
  try {
    if (decoder.state !== 'closed') await decoder.flush();
  } catch (e) {
    if (!decodeError) decodeError = e instanceof Error ? e : new Error(String(e));
  }
  if (decoder.state !== 'closed') decoder.close();

  if (decodeError) throw decodeError;

  // Wait for all RGB conversions to finish
  await Promise.all(pendingConversions);

  logger.info('encoders', 'GIF encoding started', {
    decodedFrames: inputFrameCount,
    keptFrames: rgbFrames.length,
    resolution: `${w}×${h}`,
    maxColors,
    quality: opts.quality,
    scale: opts.scale,
  });

  // Write collected RGB frames to GIF encoder with deduplication
  let prevRGBForDedup: Uint8Array | null = null;
  for (const { data: rgb, duration: totalDelay } of rgbFrames) {
    if (signal?.aborted) {
      throw new DOMException('Cancelled', 'AbortError');
    }

    // F1: Frame deduplication — skip similar frames (dHash + histogram adaptive)
    if (prevRGBForDedup !== null && doDedup) {
      const totalProcessed = encodeIdx + skippedByDedup;
      const dedupRatio = totalProcessed > 0 ? skippedByDedup / totalProcessed : 0;
      const result = isDuplicateFrameAdaptive(prevRGBForDedup, rgb, w, h, dedupThreshold);
      if (result.duplicate && dedupRatio < MAX_DEDUP_RATIO) {
        accumulatedDuration += totalDelay;
        skippedByDedup++;
        continue;
      }
    }

    // Add accumulated delay from skipped frames
    const totalDelayWithAccumulated = totalDelay + accumulatedDuration;
    accumulatedDuration = 0;

    const isFirstFrame = encodeIdx === 0;
    const MIN_FIRST_FRAME_DELAY = 100;
    const delay = isFirstFrame
      ? Math.max(MIN_FIRST_FRAME_DELAY, totalDelayWithAccumulated)
      : totalDelayWithAccumulated;

    // Bayer ordered dithering
    if (ditherStrength > 0) {
      bayerDitherRGB(rgb, w, h, ditherStrength);
    }

    // Quantize: compute global palette from first frame, reuse for subsequent frames
    if (encodeIdx === 0) {
      globalPalette = quantize(rgb, maxColors, { format: 'rgb565' });
    }
    writeFrameWithDelay(rgb, delay);
    prevRGBForDedup = rgb;
    encodeIdx++;
  }

  if (encodeIdx === 0) {
    throw new Error('No frames decoded for GIF encoding');
  }

  encoder.finish();
  const rawBytes = encoder.bytes();
  const totalElapsed = (performance.now() - startTime) / 1000;

  logger.info('encoders', 'GIF encoding complete', {
    decodedFrames: inputFrameCount,
    framesEncoded: encodeIdx,
    totalFrames: demux.totalFrames,
    outputBytes: rawBytes.length,
    fps: Math.round(encodeIdx / totalElapsed),
    totalDuration: `${totalElapsed.toFixed(2)}s`,
    resolution: `${w}×${h}`,
    maxColors,
    skippedByDecimation,
    skippedByDedup,
    splitFrames,
    dedupEnabled: doDedup,
    frameDecimation,
    sourceDurationMs: Math.round(sourceTotalDelay),
    outputDurationMs: Math.round(outputTotalDelay),
    timingErrorMs: Math.round(outputTotalDelay - sourceTotalDelay),
  });
  logger.info('encoders', '  │  └─ GIF: encode finished', {
    framesEncoded: encodeIdx,
    outputBytes: rawBytes.length,
    duration: `${totalElapsed.toFixed(2)}s`,
    skippedByDecimation,
    skippedByDedup,
  });

  return rawBytes;
}
