// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { logger } from '@utils/logger';
import type { WebPConfig } from 'wasm-webp';
import { encodeAnimation } from 'wasm-webp';
import type { ConversionProgress } from '@/types/v2-conversion-types';
import { decodeFrames } from './decoder-service';
import type { DemuxResult } from './demuxer-service';
import { isDuplicateFrameAdaptive } from './frame-utils';

export interface WebpEncodeOptions {
  width: number;
  height: number;
  quality: 'low' | 'medium' | 'high';
  scale: number;
  /** Frame decimation: keep every Nth frame (1 = keep all) */
  frameDecimation?: number;
  /** Enable frame deduplication (dHash-based) */
  deduplicate?: boolean;
  /** dHash threshold for deduplication (0-64, lower = stricter) */
  dedupThreshold?: number;
  /** Callback fired after each frame is decoded (for progress tracking) */
  onFrameDecoded?: (frameIndex: number, totalFrames: number) => void;
}

const QUALITY_MAP: Record<WebpEncodeOptions['quality'], number> = {
  low: 60,
  medium: 80,
  high: 92,
};

export type WebpProgressCallback = (progress: ConversionProgress) => void;

/**
 * Encode demuxed video frames to WebP.
 *
 * Pipeline:
 *   1. decodeFrames (common VideoDecoder pipeline + dedup) → RGB frames
 *   2. encodeAnimation (wasm-webp) → WebP output
 */
export async function encodeWebp(
  demux: DemuxResult,
  opts: WebpEncodeOptions,
  _onProgress?: WebpProgressCallback,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const srcW = opts.width;
  const srcH = opts.height;
  const w = Math.floor(srcW * opts.scale);
  const h = Math.floor(srcH * opts.scale);
  const quality = QUALITY_MAP[opts.quality];
  const webpConfig: WebPConfig = { lossless: 0, quality };
  const frameDecimation = opts.frameDecimation ?? 1;
  const doDedup = opts.deduplicate ?? true;
  const dedupThreshold = opts.dedupThreshold ?? 8;

  logger.info('encoders', '  │  ├─ WebP: codec support check', { codec: demux.config.codec });

  const startTime = performance.now();

  // Build frame deduplication filter
  let prevRGBForDedup: Uint8Array | null = null;
  const filterFrame = doDedup
    ? (rgb: Uint8Array, fw: number, fh: number): boolean => {
        if (prevRGBForDedup !== null) {
          const result = isDuplicateFrameAdaptive(prevRGBForDedup, rgb, fw, fh, dedupThreshold);
          if (result.duplicate) {
            return false;
          }
        }
        prevRGBForDedup = rgb;
        return true;
      }
    : undefined;

  // Decode frames using common decoder pipeline (with HW accel + dedup)
  const {
    frames: rgbFrames,
    totalInputFrames,
    skippedByDecimation,
    skippedByFilter,
    sourceTotalMs,
    outputTotalMs,
  } = await decodeFrames(
    demux,
    {
      width: w,
      height: h,
      frameDecimation,
      hwAccel: 'prefer-hardware',
      filterFrame,
      onFrameDecoded: opts.onFrameDecoded,
    },
    signal
  );

  if (rgbFrames.length === 0) {
    throw new Error('No frames decoded for WebP encoding');
  }

  logger.info('encoders', 'WebP encoding started', {
    decodedFrames: totalInputFrames,
    keptFrames: rgbFrames.length,
    resolution: `${w}×${h}`,
    quality: webpConfig.quality,
    scale: opts.scale,
    frameDecimation,
    skippedByDedup: skippedByFilter,
  });

  // Report encoding progress start (decoding is 50%, encoding starts now)
  if (_onProgress) {
    _onProgress({
      phase: 'encoding',
      progress: 50,
      fps: 0,
      etaSeconds: null,
      memoryMB: 0,
      currentFrame: 0,
      totalFrames: rgbFrames.length,
    });
  }

  // Encode to WebP via wasm-webp
  // Apply minimum frame delays: first frame >= 100ms, others >= 50ms
  // This ensures frames are visible to human eyes (frames < 50ms are perceptually instant)
  const MIN_FIRST_FRAME_DELAY = 100;
  const MIN_FRAME_DELAY = 50;
  const frames = rgbFrames.map((f, idx) => {
    const isFirstFrame = idx === 0;
    const delay = isFirstFrame
      ? Math.max(MIN_FIRST_FRAME_DELAY, f.duration)
      : Math.max(MIN_FRAME_DELAY, f.duration);
    return {
      data: f.data,
      duration: delay,
      config: webpConfig,
    };
  });

  const result = await encodeAnimation(w, h, false, frames);
  if (!result || result.length === 0) {
    throw new Error(
      `wasm-webp encodeAnimation returned ${result ? 'empty' : 'null'} (frames: ${rgbFrames.length}, w: ${w}, h: ${h})`
    );
  }

  // Report encoding complete
  if (_onProgress) {
    _onProgress({
      phase: 'encoding',
      progress: 90,
      fps: 0,
      etaSeconds: null,
      memoryMB: 0,
      currentFrame: rgbFrames.length,
      totalFrames: rgbFrames.length,
    });
  }

  const totalElapsed = (performance.now() - startTime) / 1000;
  logger.info('encoders', 'WebP encoding complete', {
    decodedFrames: totalInputFrames,
    keptFrames: rgbFrames.length,
    totalFrames: demux.totalFrames,
    frameDecimation,
    outputBytes: result.length,
    fps: Math.round(rgbFrames.length / totalElapsed),
    duration: `${totalElapsed.toFixed(2)}s`,
    resolution: `${w}×${h}`,
    quality: webpConfig.quality,
    skippedByDedup: skippedByFilter,
    skippedByDecimation,
    sourceDurationMs: Math.round(sourceTotalMs * 1000),
    outputDurationMs: Math.round(outputTotalMs),
    timingErrorMs: Math.round(outputTotalMs - sourceTotalMs * 1000),
  });
  logger.info('encoders', '  │  └─ WebP: encode finished', {
    keptFrames: rgbFrames.length,
    outputBytes: result.length,
    duration: `${totalElapsed.toFixed(2)}s`,
    frameDecimation,
    skippedByDedup: skippedByFilter,
  });

  return result;
}
