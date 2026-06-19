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

import type { ConversionRequest, ProgressCallback } from '@t/conversion-types';
import { DEFAULT_FPS, GIF_TARGET_FPS, WEBP_TARGET_FPS } from '@utils/constants';
import { logger } from '@utils/logger';
import { getMemoryUsageMB } from '@utils/memory-monitor';
import { globalBufferPool } from './buffer-pool';
import { ConversionProfiler } from './conversion-profiler';
import { demuxVideo } from './demuxer-service';
import { calcAutoDecimation } from './encoder-common';
import { encodeGif } from './gif-encoder-service';
import { encodeWebp } from './webp-encoder-service';

/**
 * Throttled progress wrapper — prevents UI re-render spam by enforcing a
 * minimum interval between onProgress calls. Without throttling, the encode
 * progress callbacks fire on every frame (30+/sec), causing excessive SolidJS
 * signal writes and re-renders during conversion.
 */
function createThrottledProgress(
  onProgress: ProgressCallback,
  minIntervalMs = 100
): ProgressCallback {
  let lastCallTime = 0;
  let pendingCall: (() => void) | null = null;
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    if (pendingCall) {
      pendingCall();
      pendingCall = null;
    }
  };

  return (update) => {
    const now = performance.now();
    const elapsed = now - lastCallTime;

    if (elapsed >= minIntervalMs) {
      lastCallTime = now;
      onProgress(update);
    } else {
      // Schedule a trailing call so the final state is not lost
      pendingCall = () => {
        lastCallTime = performance.now();
        onProgress(update);
      };
      if (!scheduled) {
        scheduled = true;
        setTimeout(flush, minIntervalMs - elapsed);
      }
    }
  };
}

/** Active profilers keyed by run ID — supports concurrent conversions */
const activeProfilers = new Map<string, ConversionProfiler>();

/** Get the profiler for a specific run, or the most recent one */
export function getProfilerForRun(runId: string): ConversionProfiler | null {
  return activeProfilers.get(runId) ?? null;
}

/** Get the most recent profiler (for test helpers / diagnostics) */
export function getLastConversionProfiler(): ConversionProfiler | null {
  const lastKey = [...activeProfilers.keys()].pop();
  return lastKey ? activeProfilers.get(lastKey)! : null;
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
  logger.info('conversion', `▶ Pipeline route: MAINTHREAD_${format.toUpperCase()}`, logCtx);

  // Clear buffer pool from any previous conversion
  globalBufferPool.clear();

  // Initialize profiler
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const profiler = new ConversionProfiler();
  profiler.start();
  activeProfilers.set(runId, profiler);
  // Clean up old profilers (keep last 5)
  if (activeProfilers.size > 5) {
    const oldestKey = activeProfilers.keys().next().value!;
    activeProfilers.delete(oldestKey);
  }

  // Throttle progress callbacks to prevent UI re-render spam.
  // Without throttling, per-frame callbacks (30+/sec) cause excessive
  // SolidJS signal writes and jank during conversion.
  const throttledProgress = createThrottledProgress(onProgress, 100);

  // ── Demux Phase (0~10%) ──
  // Map demux progress to 0~10% range. Since total frames are unknown until
  // demux completes, we ramp progress based on elapsed time relative to the
  // overall pipeline start, capped at 10%. This avoids a "stuck at 0%" UX.
  profiler.startPhase('demux');
  let demuxResult: Awaited<ReturnType<typeof demuxVideo>>;
  const demuxStartMs = performance.now();
  const demuxProgressThrottled = createThrottledProgress(onProgress, 200);
  try {
    demuxResult = await demuxVideo(request, (packetsExtracted) => {
      profiler.updatePhase('demux', packetsExtracted);
      const memMB = getMemoryUsageMB() ?? 0;
      const elapsedMs = Math.round(performance.now() - pipelineStart);
      // Ramp demux progress: assume demux takes ~10% of total time.
      // Use a soft ramp: 1 - e^(-3t/T) where T is an estimated total time.
      // Since we don't know T yet, use packet count as a proxy: each packet
      // nudges progress up, asymptotically approaching 10%.
      const demuxElapsed = performance.now() - demuxStartMs;
      // Estimate: ~60ms per packet is typical. Scale progress toward 10%.
      const estimatedTotalPackets = Math.max(packetsExtracted, Math.ceil(demuxElapsed / 60));
      const demuxPct = Math.min(10, Math.round((packetsExtracted / estimatedTotalPackets) * 10));
      demuxProgressThrottled({
        phase: 'demuxing',
        progress: demuxPct,
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
  // Throttled to 100ms to prevent per-frame re-render spam.
  const decodeProgressCb = (frameIdx: number, totalFrames: number) => {
    const decodePct = totalFrames > 0 ? Math.round((frameIdx / totalFrames) * 40) : 0;
    throttledProgress({
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

  // ── Encode Phase (10~90%) ──
  // Both GIF and WebP use streaming decode→encode with the same progress model:
  //   decode progress → 10~50%, encode progress → 50~90%
  profiler.startPhase('decode');
  profiler.startPhase('encode');

  const sourceFps =
    demuxResult.duration > 0 ? demuxResult.totalFrames / demuxResult.duration : DEFAULT_FPS;

  // Track decimation for output frame count display
  let decimationRatio = 1;

  if (request.format === 'gif') {
    const gifDecimation = calcAutoDecimation(
      sourceFps,
      GIF_TARGET_FPS,
      request.scale,
      request.forceDecimation
    );
    decimationRatio = gifDecimation;

    logger.info('conversion', '  ├─ Branch: GIF encoder (streaming decode→encode)', {
      codec: demuxResult.config.codec,
      codedWidth: demuxResult.config.codedWidth,
      codedHeight: demuxResult.config.codedHeight,
      totalFrames: demuxResult.totalFrames,
      sourceFps: Math.round(sourceFps),
      gifDecimation,
    });

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
            const encodePct = totalFrames > 0 ? Math.round((frameIdx / totalFrames) * 40) : 0;
            throttledProgress({
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
  } else {
    const webpDecimation = calcAutoDecimation(
      sourceFps,
      WEBP_TARGET_FPS,
      request.scale,
      request.forceDecimation
    );
    decimationRatio = webpDecimation;

    logger.info('conversion', '  ├─ Branch: WebP encoder (streaming encodeRGB + mux)', {
      codec: demuxResult.config.codec,
      codedWidth: demuxResult.config.codedWidth,
      codedHeight: demuxResult.config.codedHeight,
      totalFrames: demuxResult.totalFrames,
      sourceFps: Math.round(sourceFps),
      webpDecimation,
    });

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
      (p: { progress: number; currentFrame?: number }) => {
        const mappedProgress = 50 + Math.round(p.progress * 0.4);
        throttledProgress({
          phase: 'encoding',
          progress: Math.min(90, mappedProgress),
          fps: 0,
          etaSeconds: null,
          memoryMB: getMemoryUsageMB() ?? 0,
          currentFrame: p.currentFrame ?? 0,
          totalFrames: demuxResult.totalFrames,
          elapsedMs: Math.round(performance.now() - pipelineStart),
        });
      },
      signal
    );
    output = encoded.buffer as ArrayBuffer;
  }

  // Note: encodeResult.frames is set by the encoder functions themselves
  // via profiler.endPhase('encode', ...). We just record output size here.
  encodeResult = {
    frames: 0, // Will be overwritten by profiler.endPhase below
    outputBytes: output.byteLength,
  };

  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

  profiler.endPhase('decode');
  profiler.endPhase('encode', encodeResult ?? undefined);

  // ── Assembly Phase (90~100%) ──
  profiler.startPhase('assemble');

  // Clear buffer pool after conversion
  globalBufferPool.clear();

  const memMB = getMemoryUsageMB() ?? 0;
  const totalElapsedMs = Math.round(performance.now() - pipelineStart);
  const outputFrames = Math.max(1, Math.round(demuxResult.totalFrames / decimationRatio));
  onProgress({
    phase: 'assembling',
    progress: 95,
    fps: 0,
    etaSeconds: 0,
    memoryMB: memMB,
    currentFrame: demuxResult.totalFrames,
    totalFrames: demuxResult.totalFrames,
    outputFrames,
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
    outputFrames,
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
