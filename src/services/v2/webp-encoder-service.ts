// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * WebP Encoder Service — Streaming Architecture
 *
 * Uses wasm-webp's single-frame encodeRGB API to encode frames one at a
 * time, then muxes the results into an animated WebP container.
 *
 * This replaces the previous batch encodeAnimation approach which held all
 * frames in memory simultaneously and failed at 2GB WASM memory limit for
 * 1920x1080 full-scale videos.
 *
 * Pipeline:
 *   1. decodeFrames → RGB frames (same as before)
 *   2. Per frame: encodeRGB() → VP8 bitstream extraction
 *   3. muxAnimatedWebP() → final animated WebP blob
 */

import type { ConversionQuality } from '@t/conversion-types';
import type { ProgressCallback } from '@t/v2-conversion-types';
import { logger } from '@utils/logger';
import { decodeFrames } from './decoder-service';
import type { DemuxResult } from './demuxer-service';
import { encodeStreamingWebP } from './streaming-webp-encoder';

export interface WebpEncodeOptions {
  width: number;
  height: number;
  quality: ConversionQuality;
  scale: number;
  /** Frame decimation: keep every Nth frame (1 = keep all) */
  frameDecimation?: number;
  /** Callback fired after each frame is decoded (for progress tracking) */
  onFrameDecoded?: (frameIndex: number, totalFrames: number) => void;
}

const QUALITY_MAP: Record<WebpEncodeOptions['quality'], number> = {
  low: 60,
  medium: 80,
  high: 92,
};

/**
 * Encode demuxed video frames to animated WebP using streaming.
 *
 * Pipeline:
 *   1. decodeFrames (common VideoDecoder pipeline + dedup) → RGB frames
 *   2. encodeStreamingWebP (per-frame encodeRGB + mux) → WebP output
 */
export async function encodeWebp(
  demux: DemuxResult,
  opts: WebpEncodeOptions,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const srcW = opts.width;
  const srcH = opts.height;
  const w = Math.floor(srcW * opts.scale);
  const h = Math.floor(srcH * opts.scale);
  const quality = QUALITY_MAP[opts.quality];
  const frameDecimation = opts.frameDecimation ?? 1;

  logger.info('encoders', '  │  ├─ WebP: codec support check', { codec: demux.config.codec });

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
      hwAccel: 'prefer-hardware',
      onFrameDecoded: opts.onFrameDecoded,
    },
    signal
  );

  // Note: outputTotalMs from decodeFrames is not used in streaming path.
  // Timing is computed from individual frame durations during muxing.

  if (rgbFrames.length === 0) {
    throw new Error('No frames decoded for WebP encoding');
  }

  logger.info('encoders', 'WebP encoding started', {
    decodedFrames: totalInputFrames,
    keptFrames: rgbFrames.length,
    resolution: `${w}×${h}`,
    quality,
    scale: opts.scale,
    frameDecimation,
    skippedByDecimation,
  });

  // Report encoding progress start
  if (onProgress) {
    onProgress({
      phase: 'encoding',
      progress: 50,
      fps: 0,
      etaSeconds: null,
      memoryMB: 0,
      currentFrame: 0,
      totalFrames: rgbFrames.length,
    });
  }

  // Convert decoded frames to streaming encoder format
  // Release RGB frame references immediately after mapping to reduce peak memory
  const streamingFrames = rgbFrames.map((f) => ({
    data: f.data,
    width: w,
    height: h,
    duration: f.duration,
  }));
  // Release the batch array — RGB buffers are now referenced by streamingFrames
  rgbFrames.length = 0;
  const totalStreamingFrames = streamingFrames.length;

  // Encode using streaming approach (one frame at a time)
  const result = await encodeStreamingWebP(streamingFrames, {
    width: w,
    height: h,
    quality,
    signal,
    onFrameEncoded: (frameIdx, total) => {
      if (!onProgress) return;
      // Map encoding progress to 50~90% range
      const encodePct = total > 0 ? Math.round((frameIdx / total) * 40) : 0;
      onProgress({
        phase: 'encoding',
        progress: 50 + Math.min(40, encodePct),
        fps: 0,
        etaSeconds: null,
        memoryMB: 0,
        currentFrame: frameIdx,
        totalFrames: total,
      });
    },
  });
  streamingFrames.length = 0;

  // Report encoding complete
  if (onProgress) {
    onProgress({
      phase: 'encoding',
      progress: 90,
      fps: 0,
      etaSeconds: null,
      memoryMB: 0,
      currentFrame: totalStreamingFrames,
      totalFrames: totalStreamingFrames,
    });
  }

  const totalElapsed = (performance.now() - startTime) / 1000;
  logger.info('encoders', 'WebP encoding complete', {
    decodedFrames: totalInputFrames,
    keptFrames: totalStreamingFrames,
    totalFrames: demux.totalFrames,
    frameDecimation,
    outputBytes: result.length,
    fps: Math.round(totalStreamingFrames / totalElapsed),
    duration: `${totalElapsed.toFixed(2)}s`,
    resolution: `${w}×${h}`,
    quality,
    skippedByDecimation,
    sourceDurationMs: Math.round(sourceTotalMs),
    outputDurationMs: 0,
    timingErrorMs: 0,
  });
  logger.info('encoders', '  │  └─ WebP: encode finished', {
    keptFrames: totalStreamingFrames,
    outputBytes: result.length,
    duration: `${totalElapsed.toFixed(2)}s`,
    frameDecimation,
    skippedByDecimation,
  });

  return result;
}
