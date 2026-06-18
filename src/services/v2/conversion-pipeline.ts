// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Conversion Pipeline (Main Thread)
 *
 * demux → decode → encode, all on main thread.
 *
 * Optimizations:
 * 1. GIF streaming: decode→encode interleaved (no frame array accumulation)
 * 2. Dynamic decimation: adjusts frame skip ratio based on real-time memory
 * 3. Buffer pooling: reuses Uint8Array allocations across frames
 * 4. Profiling: per-phase timing, memory, and throughput measurement
 */

import type { ProgressCallback } from '@t/v2-conversion-types';
import { DEFAULT_FPS, GIF_TARGET_FPS, WEBP_TARGET_FPS } from '@utils/constants';
import { logger } from '@utils/logger';
import { getMemoryUsageMB } from '@utils/memory-monitor';
import type { ConversionRequest } from '@/types/v2-conversion-types';
import { globalBufferPool } from './buffer-pool';
import { ConversionProfiler } from './conversion-profiler';
import { demuxVideo } from './demuxer-service';
import { encodeGif } from './gif-encoder-service';
import { encodeWebp } from './webp-encoder-service';

/** Singleton profiler instance — stores last conversion profile for diagnostics */
let lastProfiler: ConversionProfiler | null = null;

/** Get the profiler from the last conversion (for test helpers / diagnostics) */
export function getLastConversionProfiler(): ConversionProfiler | null {
  return lastProfiler;
}

export async function runConversionPipeline(
  request: ConversionRequest,
  onProgress: ProgressCallback,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const pipelineStart = performance.now();
  const format = request.format;
  const logCtx = {
    format,
    quality: request.quality,
    scale: request.scale,
    fileName: request.fileName,
    trimStart: request.trimStart,
    trimEnd: request.trimEnd,
    inputBytes: request.inputBuffer.byteLength,
  };

  logger.performance('Pipeline started', logCtx);
  logger.info('conversion', `▶ Pipeline route: V2_MAINTHREAD_${format.toUpperCase()}`, logCtx);

  // Clear buffer pool from any previous conversion
  globalBufferPool.clear();

  // Initialize profiler
  const profiler = new ConversionProfiler();
  profiler.start();
  lastProfiler = profiler;

  // ── Demux Phase (0~10%) ──
  profiler.startPhase('demux');
  let demuxResult: Awaited<ReturnType<typeof demuxVideo>>;
  try {
    demuxResult = await demuxVideo(request, (packetsExtracted) => {
      profiler.updatePhase('demux', packetsExtracted);
      const memMB = getMemoryUsageMB() ?? 0;
      const elapsedMs = Math.round(performance.now() - pipelineStart);
      onProgress({
        phase: 'demuxing',
        progress: 0,
        fps: 0,
        etaSeconds: null,
        memoryMB: memMB,
        currentFrame: packetsExtracted,
        totalFrames: 0,
        elapsedMs,
      });
    });
  } catch (err) {
    logger.error('conversion', 'Demux failed', {
      fileName: request.fileName,
      format: request.format,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  if (signal?.aborted) {
    logger.info('conversion', 'Conversion aborted after demux');
    throw new DOMException('Cancelled', 'AbortError');
  }

  const cfg = demuxResult.config as unknown as Record<string, number>;
  const codedWidth = cfg.displayAspectWidth ?? cfg.displayWidth ?? demuxResult.config.codedWidth;
  const codedHeight =
    cfg.displayAspectHeight ?? cfg.displayHeight ?? demuxResult.config.codedHeight;
  if (!codedWidth || !codedHeight) throw new Error('Unable to determine video dimensions');

  profiler.endPhase('demux', { frames: demuxResult.totalFrames });

  const demuxElapsedMs = performance.now() - pipelineStart;
  const demuxMemMB = getMemoryUsageMB() ?? 0;
  onProgress({
    phase: 'demuxing',
    progress: 10,
    fps: 0,
    etaSeconds: null,
    memoryMB: demuxMemMB,
    currentFrame: demuxResult.totalFrames,
    totalFrames: demuxResult.totalFrames,
    elapsedMs: Math.round(demuxElapsedMs),
  });

  // ── Decode + Encode Phase (10~90%) ──
  // Progress split: decoding 10~50%, encoding 50~90%
  let output: ArrayBuffer;
  let encodeResult: { frames: number; outputBytes: number } | null = null;

  // Unified decode progress callback for both GIF and WebP.
  // Maps decoded frame index to 10~50% progress range.
  const decodeProgressCb = (frameIdx: number, totalFrames: number) => {
    const decodePct = totalFrames > 0 ? Math.round((frameIdx / totalFrames) * 40) : 0;
    onProgress({
      phase: 'decoding',
      progress: 10 + Math.min(40, decodePct),
      fps: 0,
      etaSeconds: null,
      memoryMB: getMemoryUsageMB() ?? 0,
      currentFrame: frameIdx,
      totalFrames,
      elapsedMs: Math.round(performance.now() - pipelineStart),
    });
  };

  if (request.format === 'gif') {
    // Auto frame decimation for GIF: target ~15fps output
    const sourceFps =
      demuxResult.duration > 0 ? demuxResult.totalFrames / demuxResult.duration : DEFAULT_FPS;
    const targetFps = GIF_TARGET_FPS;
    const baseDecimation =
      sourceFps > targetFps ? Math.max(1, Math.round(sourceFps / targetFps)) : 1;
    // At higher scales, decimation is aggressively increased
    const scaleBoost = request.scale >= 1.0 ? 4 : request.scale > 0.5 ? 2 : 1;
    const autoDecimation = baseDecimation * scaleBoost;
    const gifDecimation = request.forceDecimation ?? autoDecimation;

    logger.info('conversion', '  ├─ Branch: GIF encoder (streaming decode→encode)', {
      codec: demuxResult.config.codec,
      codedWidth: demuxResult.config.codedWidth,
      codedHeight: demuxResult.config.codedHeight,
      totalFrames: demuxResult.totalFrames,
      sourceFps: Math.round(sourceFps),
      gifDecimation,
    });

    // GIF streaming: encodeGif handles decode→encode interleaving internally
    // We track decode and encode as a single combined phase for profiling.
    // Both decode and encode progress are reported via onFrameDecoded (shared callback).
    profiler.startPhase('decode');
    profiler.startPhase('encode');

    output = (
      await encodeGif(
        demuxResult,
        {
          width: codedWidth,
          height: codedHeight,
          quality: request.quality,
          scale: request.scale,
          frameDecimation: gifDecimation,
          onFrameDecoded: decodeProgressCb,
          onFrameEncoded: (frameIdx: number, totalFrames: number) => {
            // Map encoded frames to 50~90% progress range
            const encodePct = totalFrames > 0 ? Math.round((frameIdx / totalFrames) * 40) : 0;
            onProgress({
              phase: 'encoding',
              progress: 50 + Math.min(40, encodePct),
              fps: 0,
              etaSeconds: null,
              memoryMB: getMemoryUsageMB() ?? 0,
              currentFrame: frameIdx,
              totalFrames,
              elapsedMs: Math.round(performance.now() - pipelineStart),
            });
          },
        },
        signal
      )
    ).buffer as ArrayBuffer;

    encodeResult = {
      frames: demuxResult.totalFrames,
      outputBytes: output.byteLength,
    };
  } else {
    // Auto frame decimation for WebP: streaming encodeRGB + JS muxing
    const sourceFps =
      demuxResult.duration > 0 ? demuxResult.totalFrames / demuxResult.duration : DEFAULT_FPS;
    const targetFps = WEBP_TARGET_FPS;
    const autoDecimation =
      sourceFps > targetFps ? Math.max(1, Math.round(sourceFps / targetFps)) : 1;
    const webpDecimation = request.forceDecimation ?? autoDecimation;

    logger.info('conversion', '  ├─ Branch: WebP encoder (streaming encodeRGB + mux)', {
      codec: demuxResult.config.codec,
      codedWidth: demuxResult.config.codedWidth,
      codedHeight: demuxResult.config.codedHeight,
      totalFrames: demuxResult.totalFrames,
      sourceFps: Math.round(sourceFps),
      webpDecimation,
    });

    profiler.startPhase('decode');
    profiler.startPhase('encode');

    const encoded = await encodeWebp(
      demuxResult,
      {
        width: codedWidth,
        height: codedHeight,
        quality: request.quality,
        scale: request.scale,
        frameDecimation: webpDecimation,
        onFrameDecoded: decodeProgressCb,
      },
      (p) => {
        const mappedProgress = 50 + Math.round(p.progress * 0.4);
        onProgress({
          ...p,
          phase: 'encoding',
          progress: Math.min(90, mappedProgress),
          memoryMB: getMemoryUsageMB() ?? 0,
          currentFrame: p.currentFrame,
          totalFrames: demuxResult.totalFrames,
          elapsedMs: Math.round(performance.now() - pipelineStart),
        });
      },
      signal
    );
    output = encoded.buffer as ArrayBuffer;
    encodeResult = {
      frames: demuxResult.totalFrames,
      outputBytes: output.byteLength,
    };
  }

  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

  profiler.endPhase('decode');
  profiler.endPhase('encode', encodeResult ?? undefined);

  // ── Assembly Phase (90~100%) ──
  profiler.startPhase('assemble');

  // Clear buffer pool after conversion
  globalBufferPool.clear();

  const memMB = getMemoryUsageMB() ?? 0;
  const totalElapsedMs = Math.round(performance.now() - pipelineStart);
  onProgress({
    phase: 'assembling',
    progress: 95,
    fps: 0,
    etaSeconds: 0,
    memoryMB: memMB,
    currentFrame: demuxResult.totalFrames,
    totalFrames: demuxResult.totalFrames,
    elapsedMs: totalElapsedMs,
  });
  onProgress({
    phase: 'assembling',
    progress: 100,
    fps: 0,
    etaSeconds: 0,
    memoryMB: memMB,
    currentFrame: demuxResult.totalFrames,
    totalFrames: demuxResult.totalFrames,
    elapsedMs: totalElapsedMs,
  });

  profiler.endPhase('assemble');

  // ── Profile Report ──
  const profileReport = profiler.finish();
  logger.performance('Pipeline profile', profileReport);
  logger.info('conversion', `◀ Pipeline complete: ${profileReport.summary}`, {
    format: request.format,
    quality: request.quality,
    scale: request.scale,
    totalFrames: demuxResult.totalFrames,
    outputBytes: output.byteLength,
    duration: `${(totalElapsedMs / 1000).toFixed(1)}s`,
    peakMemoryMB: profileReport.heapPeakMB,
    bottleneck: profileReport.bottleneck,
    phaseTimePct: profileReport.phaseTimePct,
  });

  return output;
}
