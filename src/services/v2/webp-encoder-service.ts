// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { logger } from '@utils/logger';
import type { WebPConfig } from 'wasm-webp';
import { encodeAnimation } from 'wasm-webp';
import type { ConversionProgress } from '@/types/v2-conversion-types';
import type { DemuxResult } from './demuxer-service';
import { copyFrameToRGB, getFrameDurationMs, isDuplicateFrameAdaptive } from './frame-utils';

export interface WebpEncodeOptions {
  width: number;
  height: number;
  quality: 'low' | 'medium' | 'high';
  scale: number;
}

const QUALITY_MAP: Record<WebpEncodeOptions['quality'], number> = {
  low: 50,
  medium: 75,
  high: 95,
};

export type WebpProgressCallback = (progress: ConversionProgress) => void;

/**
 * Encode demuxed video frames to WebP.
 *
 * Memory optimization:
 * - VideoDecoder output callbacks convert frames to RGB immediately
 * - VideoFrame objects are closed right after conversion (no GPU buffer accumulation)
 * - Frame decimation keeps total RGB data under ~500MB
 * - Peak memory: O(maxFramesByMemory × bytesPerFrame) instead of O(totalFrames × frameSize)
 */
export async function encodeWebp(
  demux: DemuxResult,
  opts: WebpEncodeOptions,
  onProgress?: WebpProgressCallback,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const srcW = opts.width;
  const srcH = opts.height;
  const w = Math.floor(srcW * opts.scale);
  const h = Math.floor(srcH * opts.scale);
  const quality = QUALITY_MAP[opts.quality];
  const webpConfig: WebPConfig = { lossless: 0, quality };
  const needsResize = w !== srcW || h !== srcH;

  // Check codec support + H2: hardware acceleration
  const support = await VideoDecoder.isConfigSupported(demux.config);
  if (!support.supported) {
    throw new Error(`Codec not supported: ${demux.config.codec}`);
  }

  // Calculate frame decimation to stay within 500MB RGB data limit
  const bytesPerFrame = w * h * 3;
  const maxFramesByMemory = Math.floor(500_000_000 / bytesPerFrame);
  const frameStep =
    demux.totalFrames > maxFramesByMemory ? Math.ceil(demux.totalFrames / maxFramesByMemory) : 1;

  if (frameStep > 1) {
    logger.info('encoders', 'WebP frame decimation active', {
      totalFrames: demux.totalFrames,
      keptFrames: Math.ceil(demux.totalFrames / frameStep),
      frameStep,
      bytesPerFrame,
      maxFramesByMemory,
    });
  }

  logger.info('encoders', 'WebP encoding started', {
    totalFrames: demux.totalFrames,
    resolution: `${w}×${h}`,
    quality: webpConfig.quality,
    scale: opts.scale,
    frameStep,
  });

  // Collect RGB frames with immediate VideoFrame disposal + deduplication
  const rgbFrames: { data: Uint8Array; duration: number }[] = [];
  const pendingConversions: Promise<void>[] = [];
  let decodeError: Error | null = null;
  let frameCount = 0;
  let accumulatedDuration = 0;
  let prevRGB: Uint8Array | null = null;
  let skippedByDedup = 0;
  const startTime = performance.now();

  const decoder = new VideoDecoder({
    output(frame: VideoFrame) {
      const frameDuration = getFrameDurationMs(frame);

      if (frameCount % frameStep !== 0) {
        // Skip this frame but accumulate its duration
        accumulatedDuration += frameDuration;
        frame.close();
        frameCount++;
        return;
      }

      // Include accumulated duration from skipped frames
      // Preserve original timing — no capping (unlike GIF which has frame delay limits)
      const totalDuration = frameDuration + accumulatedDuration;
      accumulatedDuration = 0;

      const conversion = (async () => {
        try {
          // H3: Use optimized copyFrameToRGB with resize support
          const rgbData = await copyFrameToRGB(frame, w, h, needsResize);

          // F1: Frame deduplication — skip similar frames (dHash + histogram adaptive)
          if (prevRGB !== null) {
            const result = isDuplicateFrameAdaptive(prevRGB, rgbData, w, h, 8);
            if (result.duplicate) {
              accumulatedDuration += totalDuration;
              skippedByDedup++;
              return;
            }
          }

          rgbFrames.push({ data: rgbData, duration: totalDuration });
          prevRGB = rgbData;
        } finally {
          frame.close();
        }
      })();
      pendingConversions.push(conversion);
      frameCount++;

      // Intermediate progress every ~5% of frames
      const reportInterval = Math.max(1, Math.floor(demux.totalFrames / 20));
      if (onProgress && frameCount % reportInterval === 0) {
        const elapsed = (performance.now() - startTime) / 1000;
        onProgress({
          phase: 'encoding',
          progress: Math.round((frameCount / demux.totalFrames) * 100),
          fps: Math.round(frameCount / elapsed),
          etaSeconds: null,
          memoryMB: 0,
          currentFrame: frameCount,
          totalFrames: demux.totalFrames,
          elapsedMs: Math.round(performance.now() - startTime),
        });
      }
    },
    error(e: Error) {
      logger.error('encoders', 'WebP VideoDecoder error', {
        codec: demux.config.codec,
        error: e.message,
      });
      decodeError = e;
    },
  });

  // H2: Hardware-accelerated decoding (with fallback)
  const hwConfig = { ...demux.config, hardwareAcceleration: 'prefer-hardware' as const };
  const swConfig = { ...demux.config, hardwareAcceleration: 'prefer-software' as const };
  const hwSupport = await VideoDecoder.isConfigSupported(hwConfig);
  decoder.configure(hwSupport.supported ? hwConfig : swConfig);

  for (const chunk of demux.chunks) {
    if (signal?.aborted) {
      if (decoder.state !== 'closed') decoder.close();
      throw new DOMException('Cancelled', 'AbortError');
    }
    if (decodeError) break;
    decoder.decode(chunk);
  }

  try {
    if (decoder.state !== 'closed') await decoder.flush();
  } catch (e) {
    if (!decodeError) decodeError = e instanceof Error ? e : new Error(String(e));
  }
  if (decoder.state !== 'closed') decoder.close();

  if (decodeError) throw decodeError;

  await Promise.all(pendingConversions);

  if (rgbFrames.length === 0) {
    throw new Error('No frames decoded for WebP encoding');
  }

  // Add any remaining accumulated duration to the last frame
  if (accumulatedDuration > 0 && rgbFrames.length > 0) {
    const last = rgbFrames[rgbFrames.length - 1];
    if (last) last.duration += accumulatedDuration;
  }

  // T3: Verify total output duration matches source
  const sourceTotalMs = demux.chunks.reduce((sum, ch) => sum + (ch.duration ?? 0), 0) / 1000;
  const outputTotalMs = rgbFrames.reduce((sum, f) => sum + f.duration, 0);

  // Report progress
  if (onProgress) {
    const elapsed = (performance.now() - startTime) / 1000;
    onProgress({
      phase: 'encoding',
      progress: 100,
      fps: Math.round(rgbFrames.length / elapsed),
      etaSeconds: 0,
      memoryMB: 0,
      currentFrame: rgbFrames.length,
      totalFrames: demux.totalFrames,
      elapsedMs: Math.round(performance.now() - startTime),
    });
  }

  // Encode to WebP via wasm-webp
  const frames = rgbFrames.map((f) => ({
    data: f.data,
    duration: f.duration,
    config: webpConfig,
  }));

  const result = await encodeAnimation(w, h, false, frames);
  if (!result || result.length === 0) {
    throw new Error(
      `wasm-webp encodeAnimation returned ${result ? 'empty' : 'null'} (frames: ${rgbFrames.length}, w: ${w}, h: ${h})`
    );
  }

  const totalElapsed = (performance.now() - startTime) / 1000;
  logger.info('encoders', 'WebP encoding complete', {
    decodedFrames: frameCount,
    keptFrames: rgbFrames.length,
    totalFrames: demux.totalFrames,
    frameStep,
    outputBytes: result.length,
    fps: Math.round(rgbFrames.length / totalElapsed),
    duration: `${totalElapsed.toFixed(2)}s`,
    resolution: `${w}×${h}`,
    quality: webpConfig.quality,
    skippedByDedup,
    sourceDurationMs: Math.round(sourceTotalMs),
    outputDurationMs: Math.round(outputTotalMs),
    timingErrorMs: Math.round(outputTotalMs - sourceTotalMs),
  });

  return result;
}
