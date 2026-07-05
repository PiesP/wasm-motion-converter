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

// Reactive store signals — read pre-computed metadata from the file-selection
// phase to avoid re-extracting it inside demuxVideo.
import { videoMetadata } from '@stores/conversion-store';
import type {
  ConversionRequest,
  MediabunnyVideoDecoderConfig,
  ProgressCallback,
  ProgressPhase,
} from '@t/conversion-types';
import { DEFAULT_FPS, GIF_TARGET_FPS, WEBP_TARGET_FPS } from '@utils/constants';
import { scheduleTask } from '@utils/dom-utils';
import { logger } from '@utils/logger';
import { getMemoryUsageMB } from '@utils/memory-monitor';
import { createThrottledProgress } from '@utils/throttled-progress';
import { globalBufferPool } from './buffer-pool';
import type { ConversionProfileReport } from './conversion-profiler';
import { decodeFrames } from './decoder-service';
import { demuxVideo } from './demuxer-service';
import { createDynamicDecimationController } from './dynamic-decimation-controller';
import { calcAutoDecimation } from './encoder-common';
import { resolveVideoDimensions } from './frame-utils';
import { encodeGif } from './gif-encoder-service';
import { encodeWebpOffscreen } from './offscreen-webp-encoder';
import { createStreamingWebpEncoder } from './parallel-webp-encoder';
import { encodeWebpVp8 } from './vp8-encoder-service';
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

const createNoopProfiler = (): Profiler => ({
  start() {},
  startPhase() {},
  updatePhase() {},
  endPhase() {},
  finish() {
    return {
      totalDurationMs: 0,
      heapStartMB: 0,
      heapEndMB: 0,
      heapPeakMB: 0,
      phases: [],
      phaseTimePct: { demuxing: 0, decoding: 0, encoding: 0, assembling: 0 },
      bottleneck: 'demuxing',
      summary: '[profiler disabled in production]',
    };
  },
  getReport() {
    return this.finish();
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

/**
 * Evict stale profilers from previous failed/aborted runs.
 * Without this, profilers for crashed runs accumulate indefinitely because
 * the cleanup below only runs after a *successful* conversion. This function
 * is called on both success and failure paths to prevent unbounded growth.
 */
function evictStaleProfilers(): void {
  if (activeProfilers.size <= 5) return;

  for (const [key, p] of activeProfilers) {
    // getLastReport() is non-null only after finish() has been called
    if (p.getLastReport() !== null) {
      activeProfilers.delete(key);
    }
  }
  // Hard cap: if still over limit (all profilers are active), evict oldest
  while (activeProfilers.size > 10) {
    const oldestKey = activeProfilers.keys().next().value;
    if (oldestKey === undefined) break;
    activeProfilers.delete(oldestKey);
  }
}

/** Get the most recent profiler (for test helpers / diagnostics) */
export function getLastConversionProfiler(): Profiler | null {
  const lastKey = [...activeProfilers.keys()].pop();
  return lastKey ? activeProfilers.get(lastKey)! : null;
}

// Incrementing counter for non-security run identifiers.
// crypto.randomUUID() is unnecessary for profiling session IDs;
// a simple counter is sufficient and avoids crypto entropy overhead.
let nextRunId = 0;

/**
 * Reset pipeline module-level state for testing purposes.
 * Clears the profiler module cache, run ID counter, and active profilers map
 * so the next conversion starts from a clean slate.
 */
export function resetPipelineState(): void {
  profilerModule = null;
  nextRunId = 0;
  activeProfilers.clear();
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
  const runId = `run-${nextRunId++}`;
  const profiler =
    import.meta.env.DEV && profilerModule ? createRealProfiler() : createNoopProfiler();
  profiler.start();
  activeProfilers.set(runId, profiler);

  // Ensure profiler is removed from active map on completion or failure
  let output: ArrayBuffer;
  try {
    output = await _runPipelineInner(request, onProgress, signal, pipelineStart, profiler);
  } catch (err) {
    // Evict stale profilers on failure too — prevents unbounded growth
    // when conversions keep failing (the old code only cleaned up after success)
    evictStaleProfilers();
    throw err;
  } finally {
    activeProfilers.delete(runId);
  }

  // Proactive cleanup: evict stale profilers from previous failed/aborted runs.
  evictStaleProfilers();

  return output;
}

/** Inner pipeline logic — demux → decode → encode with throttled progress cleanup */
async function _runPipelineInner(
  request: ConversionRequest,
  onProgress: ProgressCallback,
  signal: AbortSignal | undefined,
  pipelineStart: number,
  profiler: Profiler
): Promise<ArrayBuffer> {
  const throttled = createThrottledProgress(onProgress, 100);

  // Phase-weighted progress ranges (empirical from ConversionProfiler measurements):
  //   demux:   0 ~ 3%   (typically <1% of total time)
  //   decode:  3 ~ 73%  (typically ~70% of total time — dominant bottleneck)
  //   encode: 73 ~ 93%  (typically ~20% of total time)
  //   finish: 93 ~ 100% (file finalization)
  const DEMUX_MAX = 3;
  const DECODE_MAX = 73;
  const ENCODE_MAX = 93;
  const DECODE_RANGE = DECODE_MAX - DEMUX_MAX; // 70
  const ENCODE_RANGE = ENCODE_MAX - DECODE_MAX; // 20

  try {
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
    const demuxProgressThrottled = throttled.callback;
    try {
      demuxResult = await scheduleTask(
        () =>
          demuxVideo(
            request,
            videoMetadata() ?? undefined,
            (packetsExtracted, estimatedTotalFrames) => {
              if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
              profiler.updatePhase('demuxing', packetsExtracted);
              const memMB = sampleMemory();
              const elapsedMs = Math.round(performance.now() - pipelineStart);
              const demuxPct = Math.min(
                DEMUX_MAX,
                Math.round((packetsExtracted / estimatedTotalFrames) * DEMUX_MAX)
              );
              demuxProgressThrottled({
                phase: 'demuxing',
                progress: demuxPct,
                fps: 0,
                etaSeconds: null,
                memoryMB: memMB,
                currentFrame: packetsExtracted,
                totalFrames: estimatedTotalFrames,
                elapsedMs,
              });
            }
          ),
        { priority: 'user-blocking' }
      );
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
    const dims = resolveVideoDimensions(cfg);
    if (!dims) throw new Error('Unable to determine video dimensions');
    const { width: codedWidth, height: codedHeight } = dims;

    profiler.endPhase('demuxing', { frames: demuxResult.totalFrames });

    const demuxElapsedMs = performance.now() - pipelineStart;
    const demuxMemMB = sampleMemory();
    onProgress({
      phase: 'demuxing',
      progress: DEMUX_MAX,
      fps: 0,
      etaSeconds: null,
      memoryMB: demuxMemMB,
      currentFrame: demuxResult.totalFrames,
      totalFrames: demuxResult.totalFrames,
      elapsedMs: Math.round(demuxElapsedMs),
    });

    // ── Decode + Encode Phase (10~90%) ──
    let output: ArrayBuffer | undefined;
    let encodeResult: { frames: number; outputBytes: number } | null = null;

    // Track frame times for FPS calculation
    // Progress callback fires every ~10 frames (throttled in decoder-service),
    // so we count actual frames and compute FPS over the interval.
    const fpsTracker = { current: 0, lastTime: performance.now(), lastFrame: 0 };

    // estimatedOutputFrames is computed after decimationRatio is determined
    let estimatedOutputFrames = 1;

    /**
     * Build a ConversionProgress object with standard fields and computed elapsedMs.
     */
    const buildProgressData = (
      phase: ProgressPhase,
      progress: number,
      fps: number,
      etaSeconds: number | null,
      memoryMB: number,
      currentFrame: number,
      totalFrames: number
    ): Parameters<typeof throttled.callback>[0] => ({
      phase,
      progress,
      fps,
      etaSeconds,
      memoryMB,
      currentFrame,
      totalFrames,
      elapsedMs: Math.round(performance.now() - pipelineStart),
    });

    const decodeProgressCb = (frameIdx: number, _totalFrames: number) => {
      const now = performance.now();
      const deltaMs = now - fpsTracker.lastTime;
      const framesDelta = frameIdx - fpsTracker.lastFrame;
      fpsTracker.current =
        deltaMs > 0 && framesDelta > 0 ? Math.round(((framesDelta * 1000) / deltaMs) * 10) / 10 : 0;
      fpsTracker.lastTime = now;
      fpsTracker.lastFrame = frameIdx;
      const decodePct =
        estimatedOutputFrames > 0
          ? Math.round((frameIdx / estimatedOutputFrames) * DECODE_RANGE)
          : 0;
      throttled.callback({
        phase: 'decoding',
        progress: DEMUX_MAX + Math.min(DECODE_RANGE, decodePct),
        fps: fpsTracker.current,
        etaSeconds:
          fpsTracker.current > 0
            ? Math.round((estimatedOutputFrames - frameIdx) / fpsTracker.current)
            : null,
        memoryMB: sampleMemory(),
        currentFrame: frameIdx,
        totalFrames: estimatedOutputFrames,
        elapsedMs: Math.round(now - pipelineStart),
      });
    };

    profiler.startPhase('decoding');
    profiler.startPhase('encoding');

    const sourceFps =
      Number.isFinite(demuxResult.framerate) && demuxResult.framerate > 0
        ? demuxResult.framerate
        : DEFAULT_FPS;

    if (request.format === 'gif') {
      const gifDecimation = calcAutoDecimation(
        sourceFps,
        GIF_TARGET_FPS,
        request.scale,
        request.forceDecimation
      );
      estimatedOutputFrames = Math.max(1, Math.ceil(demuxResult.totalFrames / gifDecimation));

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
        await scheduleTask(
          () =>
            encodeGif(
              demuxResult,
              {
                width: codedWidth,
                height: codedHeight,
                quality: request.quality,
                scale: request.scale,
                frameDecimation: gifDecimation,
                onFrameDecoded: decodeProgressCb,
                onFrameEncoded: (frameIdx: number, _totalFrames: number) => {
                  gifEncodeFrames = frameIdx;
                  const encodePct =
                    estimatedOutputFrames > 0
                      ? Math.round((frameIdx / estimatedOutputFrames) * ENCODE_RANGE)
                      : 0;
                  throttled.callback(
                    buildProgressData(
                      'encoding',
                      DECODE_MAX + Math.min(ENCODE_RANGE, encodePct),
                      fpsTracker.current,
                      fpsTracker.current > 0
                        ? Math.round((estimatedOutputFrames - frameIdx) / fpsTracker.current)
                        : null,
                      sampleMemory(),
                      frameIdx,
                      estimatedOutputFrames
                    )
                  );
                },
              },
              signal
            ),
          { priority: 'user-visible' }
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
      estimatedOutputFrames = Math.max(1, Math.ceil(demuxResult.totalFrames / webpDecimation));

      // ── VP8 VideoEncoder path (GPU-only, fastest) ──
      // DISABLED (2026-07-06): Chromium's VP8 EncodedVideoChunk output is not
      // compatible with WebP ANMF muxing. The data includes a non-standard
      // 3-byte prefix and version=2 bitstream that all VP8/WebP decoders reject.
      // Re-enable when Chromium fixes the VP8 raw bitstream output format.
      // See: .hermes/plans/ for full research notes.
      const useVp8Encoder = false;
      /*
      const useVp8Encoder =
        typeof VideoEncoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
      */

      if (useVp8Encoder) {
        logger.info('conversion', '  ├─ Branch: WebP encoder (VideoEncoder VP8, GPU-only)', {
          codec: demuxResult.config.codec,
          codedWidth: demuxResult.config.codedWidth,
          codedHeight: demuxResult.config.codedHeight,
          totalFrames: demuxResult.totalFrames,
          sourceFps: Math.round(sourceFps),
          webpDecimation,
        });

        let encodedFrames = 0;
        try {
          const encoded = await scheduleTask(
            () =>
              encodeWebpVp8(
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
                  encodedFrames = p.currentFrame ?? encodedFrames;
                  const encodePct =
                    estimatedOutputFrames > 0
                      ? Math.round((encodedFrames / estimatedOutputFrames) * ENCODE_RANGE)
                      : 0;
                  throttled.callback(
                    buildProgressData(
                      'encoding',
                      Math.min(ENCODE_MAX, DECODE_MAX + encodePct),
                      fpsTracker.current,
                      fpsTracker.current > 0 && p.currentFrame != null
                        ? Math.round((estimatedOutputFrames - p.currentFrame) / fpsTracker.current)
                        : null,
                      sampleMemory(),
                      p.currentFrame ?? 0,
                      estimatedOutputFrames
                    )
                  );
                },
                signal
              ),
            { priority: 'user-visible' }
          );
          output = encoded.buffer as ArrayBuffer;
          encodeResult = {
            frames: encodedFrames,
            outputBytes: output.byteLength,
          };
        } catch (err) {
          logger.warn('conversion', 'VP8 encoder failed, falling back to OffscreenCanvas', {
            error: err instanceof Error ? err.message : String(err),
          });
          // Fall through to OffscreenCanvas paths below
        }
      }

      // If VP8 encoder did not produce output, try parallel Worker or OffscreenCanvas.
      if (!encodeResult) {
        // Use parallel Worker-based encoder when available (distributes frame
        // encoding across multiple CPU cores for 2-3x speedup).
        // Falls back to main-thread OffscreenCanvas encoder, then wasm-webp.
        const useParallelEncoder =
          typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined';

        if (useParallelEncoder) {
          logger.info(
            'conversion',
            '  ├─ Branch: WebP encoder (parallel Worker pool + OffscreenCanvas)',
            {
              codec: demuxResult.config.codec,
              codedWidth: demuxResult.config.codedWidth,
              codedHeight: demuxResult.config.codedHeight,
              totalFrames: demuxResult.totalFrames,
              sourceFps: Math.round(sourceFps),
              webpDecimation,
            }
          );

          // Decode on main thread, stream frames directly to worker pool.
          // Uses createStreamingWebpEncoder to avoid accumulating all frames
          // in an array (reduces peak memory by ~50% for large videos).
          const w = Math.max(1, Math.floor(codedWidth * request.scale));
          const h = Math.max(1, Math.floor(codedHeight * request.scale));
          const decimationController = createDynamicDecimationController();

          const streamingEncoder = createStreamingWebpEncoder(
            w,
            h,
            request.quality,
            estimatedOutputFrames,
            (p) => {
              const encodeProgress =
                DECODE_MAX + Math.round(((p.progress - DECODE_MAX) * ENCODE_RANGE) / ENCODE_RANGE);
              throttled.callback(
                buildProgressData(
                  'encoding',
                  Math.min(ENCODE_MAX, encodeProgress),
                  fpsTracker.current,
                  fpsTracker.current > 0 && p.currentFrame != null
                    ? Math.round((estimatedOutputFrames - p.currentFrame) / fpsTracker.current)
                    : null,
                  sampleMemory(),
                  p.currentFrame ?? 0,
                  estimatedOutputFrames
                )
              );
            }
          );

          // Accumulate durations from dynamically skipped frames (see offscreen-webp-encoder).
          let dynamicAccumulatedMs = 0;

          await scheduleTask(
            () =>
              decodeFrames(
                demuxResult,
                {
                  width: w,
                  height: h,
                  frameDecimation: webpDecimation,
                  hwAccel: 'prefer-hardware',
                  smartFrameSkip: request.smartFrameSkip,
                  onFrameDecoded: (frameIdx, _total) => {
                    const decodePct =
                      estimatedOutputFrames > 0
                        ? Math.round((frameIdx / estimatedOutputFrames) * DECODE_RANGE)
                        : 0;
                    throttled.callback({
                      phase: 'decoding',
                      progress: DEMUX_MAX + Math.min(DECODE_RANGE, decodePct),
                      fps: fpsTracker.current,
                      etaSeconds:
                        fpsTracker.current > 0
                          ? Math.round((estimatedOutputFrames - frameIdx) / fpsTracker.current)
                          : null,
                      memoryMB: sampleMemory(),
                      currentFrame: frameIdx,
                      totalFrames: estimatedOutputFrames,
                      elapsedMs: Math.round(performance.now() - pipelineStart),
                    });
                  },
                  onFrameAvailable: async (
                    rgbData: Uint8Array,
                    frameDurationMs: number,
                    frameNum: number
                  ) => {
                    if (signal?.aborted) {
                      globalBufferPool.release(rgbData);
                      throw new DOMException('Cancelled', 'AbortError');
                    }
                    const shouldSkip = decimationController.shouldSkip(frameNum);
                    if (shouldSkip) {
                      dynamicAccumulatedMs += frameDurationMs;
                      globalBufferPool.release(rgbData);
                      return;
                    }
                    const totalDuration = frameDurationMs + dynamicAccumulatedMs;
                    dynamicAccumulatedMs = 0;
                    streamingEncoder.submit(rgbData, totalDuration);
                    globalBufferPool.release(rgbData);
                  },
                },
                signal
              ),
            { priority: 'user-blocking' }
          );

          output = (
            await scheduleTask(() => streamingEncoder.finish(), { priority: 'user-visible' })
          ).buffer as ArrayBuffer;
          encodeResult = {
            frames: estimatedOutputFrames,
            outputBytes: output.byteLength,
          };
        } else if (typeof OffscreenCanvas !== 'undefined') {
          logger.info(
            'conversion',
            '  ├─ Branch: WebP encoder (OffscreenCanvas convertToBlob + mux)',
            {
              codec: demuxResult.config.codec,
              codedWidth: demuxResult.config.codedWidth,
              codedHeight: demuxResult.config.codedHeight,
              totalFrames: demuxResult.totalFrames,
              sourceFps: Math.round(sourceFps),
              webpDecimation,
            }
          );

          let encodedFrames = 0;
          const encoded = await scheduleTask(
            () =>
              encodeWebpOffscreen(
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
                  encodedFrames = p.currentFrame ?? encodedFrames;
                  const encodePct =
                    estimatedOutputFrames > 0
                      ? Math.round((encodedFrames / estimatedOutputFrames) * ENCODE_RANGE)
                      : 0;
                  throttled.callback(
                    buildProgressData(
                      'encoding',
                      Math.min(ENCODE_MAX, DECODE_MAX + encodePct),
                      fpsTracker.current,
                      fpsTracker.current > 0 && p.currentFrame != null
                        ? Math.round((estimatedOutputFrames - p.currentFrame) / fpsTracker.current)
                        : null,
                      sampleMemory(),
                      p.currentFrame ?? 0,
                      estimatedOutputFrames
                    )
                  );
                },
                signal
              ),
            { priority: 'user-visible' }
          );
          output = encoded.buffer as ArrayBuffer;
          encodeResult = {
            frames: encodedFrames,
            outputBytes: output.byteLength,
          };
        } else {
          logger.info('conversion', '  ├─ Branch: WebP encoder (streaming encodeRGB + mux)', {
            codec: demuxResult.config.codec,
            codedWidth: demuxResult.config.codedWidth,
            codedHeight: demuxResult.config.codedHeight,
            totalFrames: demuxResult.totalFrames,
            sourceFps: Math.round(sourceFps),
            webpDecimation,
          });

          let encodedFrames = 0;
          const encoded = await scheduleTask(
            () =>
              encodeWebp(
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
                  encodedFrames = p.currentFrame ?? encodedFrames;
                  const encodePct =
                    estimatedOutputFrames > 0
                      ? Math.round((encodedFrames / estimatedOutputFrames) * ENCODE_RANGE)
                      : 0;
                  throttled.callback(
                    buildProgressData(
                      'encoding',
                      Math.min(ENCODE_MAX, DECODE_MAX + encodePct),
                      fpsTracker.current,
                      fpsTracker.current > 0 && p.currentFrame != null
                        ? Math.round((estimatedOutputFrames - p.currentFrame) / fpsTracker.current)
                        : null,
                      sampleMemory(),
                      p.currentFrame ?? 0,
                      estimatedOutputFrames
                    )
                  );
                },
                signal
              ),
            { priority: 'user-visible' }
          );
          output = encoded.buffer as ArrayBuffer;
          encodeResult = {
            frames: encodedFrames,
            outputBytes: output.byteLength,
          };
        }
      } // end if (!output) fallback
    }

    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

    profiler.endPhase('decoding');
    profiler.endPhase('encoding', encodeResult);

    // ── Assembly Phase (93~100%) ──
    profiler.startPhase('assembling');

    // Clear buffer pool after conversion
    globalBufferPool.clear();

    const memMB = sampleMemory();
    const totalElapsedMs = Math.round(performance.now() - pipelineStart);
    scheduleTask(
      () => {
        throttled.callback({
          phase: 'assembling',
          progress: ENCODE_MAX,
          fps: 0,
          etaSeconds: 0,
          memoryMB: memMB,
          currentFrame: demuxResult.totalFrames,
          totalFrames: demuxResult.totalFrames,
          outputFrames: estimatedOutputFrames,
          elapsedMs: totalElapsedMs,
        });
        throttled.callback({
          phase: 'assembling',
          progress: 100,
          fps: 0,
          etaSeconds: 0,
          memoryMB: memMB,
          currentFrame: demuxResult.totalFrames,
          totalFrames: demuxResult.totalFrames,
          outputFrames: estimatedOutputFrames,
          elapsedMs: totalElapsedMs,
        });
      },
      { priority: 'background' }
    );

    profiler.endPhase('assembling');

    // ── Profile Report ──
    const profileReport = profiler.finish();
    scheduleTask(
      () => {
        logger.performance('Pipeline profile', profileReport);
        logger.info('conversion', `◀ Pipeline complete: ${profileReport.summary}`, {
          format: request.format,
          quality: request.quality,
          scale: request.scale,
          totalFrames: demuxResult.totalFrames,
          outputBytes: output!.byteLength,
          duration: `${(totalElapsedMs / 1000).toFixed(1)}s`,
          peakMemoryMB: profileReport.heapPeakMB,
          bottleneck: profileReport.bottleneck,
          phaseTimePct: profileReport.phaseTimePct,
        });
      },
      { priority: 'background' }
    );

    return output!;
  } finally {
    throttled.cleanup();
    globalBufferPool.clear();
  }
}
