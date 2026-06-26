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
 * 5. Resource cleanup: profiler removed from active map on completion/failure
 */

import type {
  ConversionProgress,
  ConversionRequest,
  MediabunnyVideoDecoderConfig,
  ProgressCallback,
  ProgressPhase,
} from '@t/conversion-types';
import { DEFAULT_FPS, GIF_TARGET_FPS, WEBP_TARGET_FPS } from '@utils/constants';
import { logger } from '@utils/logger';
import { getMemoryUsageMB } from '@utils/memory-monitor';
import { globalBufferPool } from './buffer-pool';
import type { ConversionProfileReport } from './conversion-profiler';
import { demuxVideo } from './demuxer-service';
import { calcAutoDecimation } from './encoder-common';
import { encodeGif } from './gif-encoder-service';
import { encodeWebp } from './webp-encoder-service';

/**
 * Profiler interface — implemented by ConversionProfiler in DEV,
 * no-op in production. The real class is dynamically imported in DEV
 * so it tree-shakes out of production bundles.
 */
interface Profiler {
  start(): void;
  startPhase(phase: ProgressPhase): void;
  updatePhase(phase: ProgressPhase, framesProcessed: number): void;
  endPhase(phase: ProgressPhase, opts?: { frames?: number; outputBytes?: number }): void;
  finish(): ConversionProfileReport;
  getReport(): ConversionProfileReport;
  getLastReport(): ConversionProfileReport | null;
}

let _noopReport: ConversionProfileReport | null = null;

function getNoopReport(): ConversionProfileReport {
  if (!_noopReport) {
    _noopReport = {
      totalDurationMs: 0,
      heapStartMB: 0,
      heapEndMB: 0,
      heapPeakMB: 0,
      phases: [],
      phaseTimePct: { demuxing: 0, decoding: 0, encoding: 0, assembling: 0 },
      bottleneck: 'demuxing',
      summary: '[profiler disabled in production]',
    };
  }
  return _noopReport;
}

const createNoopProfiler = (): Profiler => ({
  start() {},
  startPhase() {},
  updatePhase() {},
  endPhase() {},
  finish() {
    return getNoopReport();
  },
  getReport() {
    return getNoopReport();
  },
  getLastReport() {
    return null;
  },
});

/**
 * Cached dynamic import for the real profiler (DEV only).
 * Null in production — the import.meta.env.DEV guard ensures
 * this is dead-code eliminated from prod bundles.
 */
let profilerModule: typeof import('./conversion-profiler') | null = null;

async function importProfiler(): Promise<void> {
  if (import.meta.env.DEV && !profilerModule) {
    profilerModule = await import('./conversion-profiler');
  }
}

function createRealProfiler(): Profiler {
  return new profilerModule!.ConversionProfiler();
}

/** Active profilers keyed by run ID — supports concurrent conversions */
const activeProfilers = new Map<string, Profiler>();

/** Get the most recent profiler (for test helpers / diagnostics) */
export function getLastConversionProfiler(): Profiler | null {
  const lastKey = [...activeProfilers.keys()].pop();
  return lastKey ? activeProfilers.get(lastKey)! : null;
}

/**
 * Throttled progress wrapper — prevents UI re-render spam by enforcing a
 * minimum interval between onProgress calls. Without throttling, the encode
 * progress callbacks fire on every frame (30+/sec), causing excessive SolidJS
 * signal writes and re-renders during conversion.
 */
function createThrottledProgress(
  onProgress: ProgressCallback,
  minIntervalMs = 100
): { callback: ProgressCallback; cleanup: () => void } {
  let lastCallTime = 0;
  let pendingCall: (() => void) | null = null;
  let scheduled = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    scheduled = false;
    timerId = null;
    if (pendingCall) {
      pendingCall();
      pendingCall = null;
    }
  };

  const cleanup = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    scheduled = false;
    pendingCall = null;
  };

  const callback = (update: ConversionProgress) => {
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
        timerId = setTimeout(flush, minIntervalMs - elapsed);
      }
    }
  };

  return { callback, cleanup };
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

  // Initialize profiler — in DEV, dynamically import the real profiler
  // (tree-shaken from production bundles). In prod, use no-op.
  if (import.meta.env.DEV) {
    await importProfiler();
  }
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const profiler =
    import.meta.env.DEV && profilerModule ? createRealProfiler() : createNoopProfiler();
  profiler.start();
  activeProfilers.set(runId, profiler);
  // Clean up old profilers (keep last 5)
  if (activeProfilers.size > 5) {
    const oldestKey = activeProfilers.keys().next().value!;
    activeProfilers.delete(oldestKey);
  }

  // Ensure profiler is removed from active map on completion or failure
  let output: ArrayBuffer;
  try {
    output = await _runPipelineInner(request, onProgress, signal, pipelineStart, profiler);
  } finally {
    activeProfilers.delete(runId);
  }

  return output;
}

/** Inner pipeline logic — separated so finally block can always clean up */
async function _runPipelineInner(
  request: ConversionRequest,
  onProgress: ProgressCallback,
  signal: AbortSignal | undefined,
  pipelineStart: number,
  profiler: Profiler
): Promise<ArrayBuffer> {
  const throttled = createThrottledProgress(onProgress, 100);

  try {
    return await _runPipelineInnerBody(
      request,
      throttled.callback,
      signal,
      pipelineStart,
      profiler,
      throttled.callback
    );
  } finally {
    throttled.cleanup();
    globalBufferPool.clear();
  }
}

/** Inner pipeline body — separated so try/finally can always clean up throttled progress */
async function _runPipelineInnerBody(
  request: ConversionRequest,
  onProgress: ProgressCallback,
  signal: AbortSignal | undefined,
  pipelineStart: number,
  profiler: Profiler,
  throttledProgress: ProgressCallback
): Promise<ArrayBuffer> {
  // ── Throttled memory sampling (PERF-H1) ──
  // getMemoryUsageMB() reads performance.memory which is expensive.
  // Sample at most once per second instead of every progress callback.
  let lastMemSampleTime = 0;
  let lastMemMB = 0;
  const sampleMemory = (): number => {
    const now = performance.now();
    if (now - lastMemSampleTime >= 1000) {
      lastMemSampleTime = now;
      lastMemMB = getMemoryUsageMB() ?? 0;
    }
    return lastMemMB;
  };

  profiler.startPhase('demuxing');
  let demuxResult: Awaited<ReturnType<typeof demuxVideo>>;
  const demuxStartMs = performance.now();
  const demuxProgressThrottled = throttledProgress;
  try {
    demuxResult = await demuxVideo(request, (packetsExtracted) => {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      profiler.updatePhase('demuxing', packetsExtracted);
      const memMB = sampleMemory();
      const elapsedMs = Math.round(performance.now() - pipelineStart);
      const demuxElapsed = performance.now() - demuxStartMs;
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

  const cfg = demuxResult.config as MediabunnyVideoDecoderConfig;
  const codedWidth = cfg.displayAspectWidth ?? cfg.displayWidth ?? demuxResult.config.codedWidth;
  const codedHeight =
    cfg.displayAspectHeight ?? cfg.displayHeight ?? demuxResult.config.codedHeight;
  if (!codedWidth || !codedHeight) throw new Error('Unable to determine video dimensions');

  profiler.endPhase('demuxing', { frames: demuxResult.totalFrames });

  const demuxElapsedMs = performance.now() - pipelineStart;
  const demuxMemMB = sampleMemory();
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
  let output: ArrayBuffer;
  let encodeResult: { frames: number; outputBytes: number } | null = null;

  // Track frame times for FPS calculation
  // Progress callback fires every ~10 frames (throttled in decoder-service),
  // so we count actual frames and compute FPS over the interval.
  const fpsTracker = { current: 0, lastTime: performance.now(), lastFrame: 0 };

  const decodeProgressCb = (frameIdx: number, totalFrames: number) => {
    const now = performance.now();
    const deltaMs = now - fpsTracker.lastTime;
    const framesDelta = frameIdx - fpsTracker.lastFrame;
    fpsTracker.current =
      deltaMs > 0 && framesDelta > 0 ? Math.round(((framesDelta * 1000) / deltaMs) * 10) / 10 : 0;
    fpsTracker.lastTime = now;
    fpsTracker.lastFrame = frameIdx;
    const decodePct = totalFrames > 0 ? Math.round((frameIdx / totalFrames) * 40) : 0;
    throttledProgress({
      phase: 'decoding',
      progress: 10 + Math.min(40, decodePct),
      fps: fpsTracker.current,
      etaSeconds: null,
      memoryMB: sampleMemory(),
      currentFrame: frameIdx,
      totalFrames,
      elapsedMs: Math.round(now - pipelineStart),
    });
  };

  profiler.startPhase('decoding');
  profiler.startPhase('encoding');

  const sourceFps =
    demuxResult.duration > 0 ? demuxResult.totalFrames / demuxResult.duration : DEFAULT_FPS;

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

    let gifEncodeFrames = 0;
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
            gifEncodeFrames = frameIdx;
            const encodePct = totalFrames > 0 ? Math.round((frameIdx / totalFrames) * 40) : 0;
            throttledProgress({
              phase: 'encoding',
              progress: 50 + Math.min(40, encodePct),
              fps: fpsTracker.current,
              etaSeconds: null,
              memoryMB: sampleMemory(),
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
      frames: gifEncodeFrames,
      outputBytes: output.byteLength,
    };
  } else {
    const webpDecimation = calcAutoDecimation(
      sourceFps,
      WEBP_TARGET_FPS[request.quality],
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
          fps: fpsTracker.current,
          etaSeconds: null,
          memoryMB: sampleMemory(),
          currentFrame: p.currentFrame ?? 0,
          totalFrames: demuxResult.totalFrames,
          elapsedMs: Math.round(performance.now() - pipelineStart),
        });
      },
      signal
    );
    output = encoded.buffer as ArrayBuffer;
    encodeResult = {
      frames: 0,
      outputBytes: output.byteLength,
    };
  }

  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

  profiler.endPhase('decoding');
  profiler.endPhase('encoding', encodeResult);

  // ── Assembly Phase (90~100%) ──
  profiler.startPhase('assembling');

  // Clear buffer pool after conversion
  globalBufferPool.clear();

  const memMB = sampleMemory();
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

  profiler.endPhase('assembling');

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
