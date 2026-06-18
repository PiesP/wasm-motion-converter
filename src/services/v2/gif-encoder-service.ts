// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { logger } from '@utils/logger';
import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import type { ConversionProgress } from '@/types/v2-conversion-types';
import { decodeFrames } from './decoder-service';
import type { DemuxResult } from './demuxer-service';

export interface GifEncodeOptions {
  width: number;
  height: number;
  quality: 'low' | 'medium' | 'high';
  scale: number;
  /** Frame decimation: keep every Nth frame (1 = keep all, 2 = keep 50%, etc.) */
  frameDecimation?: number;
  /** Callback fired after each frame is decoded (for progress tracking) */
  onFrameDecoded?: (frameIndex: number, totalFrames: number) => void;
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
 * Encode demuxed video frames to GIF.
 *
 * Pipeline:
 *   1. decodeFrames (common VideoDecoder pipeline + dedup) → RGB frames
 *   2. Per-frame: dither → quantize → writeFrame
 */
export async function encodeGif(
  demux: DemuxResult,
  opts: GifEncodeOptions,
  _onProgress?: GifProgressCallback,
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

  // Decode frames using common VideoDecoder pipeline
  const {
    frames: rgbFrames,
    totalInputFrames,
    skippedByDecimation,
    sourceTotalMs,
  } = await decodeFrames(
    demux,
    {
      width: w,
      height: h,
      frameDecimation,
      hwAccel: 'prefer-software',
      onFrameDecoded: opts.onFrameDecoded,
    },
    signal
  );

  let splitFrames = 0;
  let encodeIdx = 0;
  let accumulatedDuration = 0;

  // T2: Maximum delay per frame — prevents a single frame from displaying too long
  const MAX_FRAME_DELAY = 200;
  // Minimum delay for the first frame — ensures it's visible to human eyes
  // GIF/WebP players may render frames too quickly otherwise
  const MIN_FIRST_FRAME_DELAY = 100;
  // Minimum delay for any frame — frames shorter than this are perceptually instant
  const MIN_FRAME_DELAY = 50;

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

  logger.info('encoders', 'GIF encoding started', {
    decodedFrames: totalInputFrames,
    keptFrames: rgbFrames.length,
    resolution: `${w}×${h}`,
    maxColors,
    quality: opts.quality,
    scale: opts.scale,
  });

  // Write collected RGB frames to GIF encoder
  for (const { data: rgb, duration: totalDelay } of rgbFrames) {
    if (signal?.aborted) {
      throw new DOMException('Cancelled', 'AbortError');
    }

    // Add accumulated delay from skipped frames
    const totalDelayWithAccumulated = totalDelay + accumulatedDuration;
    accumulatedDuration = 0;

    const isFirstFrame = encodeIdx === 0;

    // Apply minimum delays:
    // - First frame: always at least MIN_FIRST_FRAME_DELAY (100ms) so humans can see it
    // - Other frames: at least MIN_FRAME_DELAY (50ms) to avoid perceptual instant
    let delay: number;
    if (isFirstFrame) {
      delay = Math.max(MIN_FIRST_FRAME_DELAY, totalDelayWithAccumulated);
    } else {
      delay = Math.max(MIN_FRAME_DELAY, totalDelayWithAccumulated);
    }

    // Bayer ordered dithering
    if (ditherStrength > 0) {
      bayerDitherRGB(rgb, w, h, ditherStrength);
    }

    // Quantize: compute global palette from first frame, reuse for subsequent frames
    if (encodeIdx === 0) {
      globalPalette = quantize(rgb, maxColors, { format: 'rgb565' });
    }

    writeFrameWithDelay(rgb, delay);
    encodeIdx++;
  }

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
    sourceDurationMs: Math.round(sourceTotalMs * 1000),
    outputDurationMs: Math.round(outputTotalDelay),
    timingErrorMs: Math.round(outputTotalDelay - sourceTotalMs * 1000),
  });
  logger.info('encoders', '  │  └─ GIF: encode finished', {
    keptFrames: encodeIdx,
    outputBytes: rawBytes.length,
    duration: `${totalElapsed.toFixed(2)}s`,
    skippedByDecimation,
  });

  return rawBytes;
}
