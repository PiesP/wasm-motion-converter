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
} from '@t/conversion-types';
import {
  BYTES_PER_MB,
  DEFAULT_FPS,
  GIF_TARGET_FPS,
  MEMORY_CRITICAL_RATIO,
  PROGRESS_PHASE,
  PROGRESS_PHASE_RANGES,
  PROGRESS_THROTTLE_MS,
  WEBP_TARGET_FPS,
  WORKER_MAX_MEMORY_MB,
  WORKER_MIN_MEMORY_MB,
} from '@utils/constants';
import { scheduleTask } from '@utils/dom-utils';
import { logger } from '@utils/logger';
import { getMemoryUsageMB } from '@utils/memory-monitor';
import { createThrottledProgress } from '@utils/throttled-progress';
import { globalBufferPool } from './buffer-pool';
import {
  clearLastConversionProfileReport,
  setLastConversionProfileReport,
} from './conversion-profile-store';
import { buildEncodingProgress } from './conversion-progress';
import { decodeFrames } from './decoder-service';
import { demuxVideo } from './demuxer-service';
import { createDynamicDecimationController } from './dynamic-decimation-controller';
import { calcAutoDecimation } from './encoder-common';
import { calculateWebpWorkerCountForBudget, WebpFrameMemoryBudget } from './frame-memory';
import { clearCanvasCache, resolveVideoDimensions } from './frame-utils';
import { encodeGif } from './gif-encoder-service';
import { encodeWebpOffscreen } from './offscreen-webp-encoder';
import { resolveOutputLimits } from './output-limits';
import { createStreamingWebpEncoder, type StreamingWebpEncoder } from './parallel-webp-encoder';
import { encodeWebp } from './webp-encoder-service';
import { createWorkerPool, disposeWorkerPool, WebpWorkerPool } from './worker-pool';

/** Device/environment check — isolated to this module-level constant */
const isDev = import.meta.env.DEV;

function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
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
    inputBytes: request.inputBlob?.size ?? request.inputBuffer?.byteLength ?? 0,
  };

  logger.performance('Pipeline started', logCtx);
  logger.info('conversion', `▶ Pipeline route: MAINTHREAD_${format.toUpperCase()}`, logCtx);

  clearLastConversionProfileReport();

  // Clear buffer pool from any previous conversion
  globalBufferPool.clear();

  // Initialize profiler — in DEV, dynamically import the real profiler
  // (tree-shaken from production bundles). In prod, use null.
  const profilerClass = isDev
    ? (await import('./conversion-profiler')).ConversionProfiler
    : undefined;
  const profiler: import('./conversion-profiler').ConversionProfiler | null = profilerClass
    ? new profilerClass()
    : null;

  return _runPipelineInner(request, onProgress, signal, pipelineStart, profiler);
}

/** Inner pipeline logic — demux → decode → encode with throttled progress cleanup */
async function _runPipelineInner(
  request: ConversionRequest,
  onProgress: ProgressCallback,
  signal: AbortSignal | undefined,
  pipelineStart: number,
  profiler: import('./conversion-profiler').ConversionProfiler | null
): Promise<ArrayBuffer> {
  const throttled = createThrottledProgress(onProgress, PROGRESS_THROTTLE_MS);

  // UI progress ranges. Decode and encode overlap in the streaming transcode
  // stage, so these weights are presentation estimates rather than profiler
  // attribution of exclusive wall-clock time.
  const { DEMUX_MAX, ENCODE_MAX } = PROGRESS_PHASE;
  const { DECODE_RANGE } = PROGRESS_PHASE_RANGES;
  let demuxSession: Awaited<ReturnType<typeof demuxVideo>> | undefined;
  let workerPool: WebpWorkerPool | null = null;
  let streamingWebpEncoder: StreamingWebpEncoder | null = null;
  let webpFrameMemoryBudget: WebpFrameMemoryBudget | null = null;
  const terminateWorkerPool = (): void => {
    disposeWorkerPool(workerPool);
    workerPool = null;
  };
  signal?.addEventListener('abort', terminateWorkerPool, { once: true });

  try {
    const outputLimits = resolveOutputLimits(request.format, request);
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
    const configuredMaxMemoryMB = Number.isFinite(request.maxMemoryMB)
      ? request.maxMemoryMB
      : WORKER_MAX_MEMORY_MB;
    const maxMemoryMB = Math.min(
      WORKER_MAX_MEMORY_MB,
      Math.max(WORKER_MIN_MEMORY_MB, configuredMaxMemoryMB)
    );
    const retainedInputBytes = request.inputBuffer?.byteLength ?? 0;
    const assertMemoryBudget = (additionalBytes = 0): void => {
      const estimatedBytes =
        retainedInputBytes + globalBufferPool.totalRetainedMemory + additionalBytes;
      const estimatedMB = Math.ceil(estimatedBytes / BYTES_PER_MB);
      if (estimatedMB >= maxMemoryMB * MEMORY_CRITICAL_RATIO) {
        throw new Error(
          `Main-thread memory estimate reached ${estimatedMB}MB of ${maxMemoryMB}MB limit`
        );
      }
    };

    const demuxSpan = profiler?.begin('demuxing');
    const demuxProgressThrottled = throttled.callback;
    const demuxResult = await scheduleTask(
      () =>
        demuxVideo(
          request,
          videoMetadata() ?? undefined,
          (estimatedTotalFrames) => {
            if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
            demuxSpan?.update({ frames: estimatedTotalFrames });
            const memMB = sampleMemory();
            const elapsedMs = Math.round(performance.now() - pipelineStart);
            demuxProgressThrottled({
              phase: 'demuxing',
              progress: DEMUX_MAX,
              fps: 0,
              etaSeconds: null,
              memoryMB: memMB,
              currentFrame: estimatedTotalFrames,
              totalFrames: estimatedTotalFrames,
              elapsedMs,
            });
          },
          signal
        ),
      { priority: 'user-blocking' }
    );
    demuxSession = demuxResult;

    if (signal?.aborted) {
      logger.info('conversion', 'Conversion aborted after demux');
      throw new DOMException('Cancelled', 'AbortError');
    }

    const cfg = demuxResult.config as MediabunnyVideoDecoderConfig;
    const dims = resolveVideoDimensions(cfg);
    if (!dims) throw new Error('Unable to determine video dimensions');
    const { width: codedWidth, height: codedHeight } = dims;

    demuxSpan?.end({ frames: demuxResult.totalFrames });

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
    let observedDecodedFrames = 0;
    let observedEncodedFrames = 0;

    const decodeProgressCb = (frameIdx: number, _totalFrames: number) => {
      observedDecodedFrames = Math.max(observedDecodedFrames, frameIdx);
      transcodeSpan?.update({ decodedFrames: frameIdx });
      const now = performance.now();
      const deltaMs = now - fpsTracker.lastTime;
      const framesDelta = frameIdx - fpsTracker.lastFrame;
      // EWMA smoothing (α=0.3): smooths FPS transitions between decode↔encode phases.
      // Raw delta-based FPS jumps wildly when the phase changes because decode and
      // encode have fundamentally different throughput characteristics.
      const instantFps = deltaMs > 0 && framesDelta > 0 ? (framesDelta * 1000) / deltaMs : 0;
      fpsTracker.current =
        instantFps > 0 ? fpsTracker.current * 0.7 + instantFps * 0.3 : fpsTracker.current;
      fpsTracker.current = Math.round(fpsTracker.current * 10) / 10;
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

    const reportEncodingProgress = (
      progressFrame: number,
      currentFrame: number,
      etaFrame: number | null
    ): void => {
      observedEncodedFrames = Math.max(observedEncodedFrames, currentFrame);
      transcodeSpan?.update({ encodedFrames: currentFrame });
      throttled.callback(
        buildEncodingProgress({
          progressFrame,
          currentFrame,
          etaFrame,
          totalFrames: estimatedOutputFrames,
          fps: fpsTracker.current,
          memoryMB: sampleMemory(),
          elapsedMs: Math.round(performance.now() - pipelineStart),
        })
      );
    };

    const createEncodeProgressCb = (): ProgressCallback => {
      let encodedFrames = 0;
      return (p) => {
        encodedFrames = p.currentFrame ?? encodedFrames;
        reportEncodingProgress(encodedFrames, p.currentFrame ?? 0, p.currentFrame ?? null);
      };
    };

    const transcodeSpan = profiler?.begin('transcoding');
    const recordCompletedFrameCounts = (counts: {
      decodedFrames: number;
      encodedFrames: number;
    }): void => {
      observedDecodedFrames = counts.decodedFrames;
      observedEncodedFrames = counts.encodedFrames;
      transcodeSpan?.update(counts);
    };

    const sourceFps =
      Number.isFinite(demuxResult.framerate) && demuxResult.framerate > 0
        ? demuxResult.framerate
        : DEFAULT_FPS;

    if (request.format === 'gif') {
      const gifDecimation = calcAutoDecimation(
        sourceFps,
        GIF_TARGET_FPS[request.quality],
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
      output = toOwnedArrayBuffer(
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
                smartFrameSkip: request.smartFrameSkip,
                onEncodingComplete: recordCompletedFrameCounts,
                ...outputLimits,
                assertAdditionalMemoryBytes: assertMemoryBudget,
                onFrameDecoded: decodeProgressCb,
                onFrameEncoded: (encodedFrameCount: number, _totalFrames: number) => {
                  gifEncodeFrames = encodedFrameCount;
                  reportEncodingProgress(encodedFrameCount, encodedFrameCount, encodedFrameCount);
                },
              },
              signal
            ),
          { priority: 'user-visible' }
        )
      );
      encodeResult = {
        frames: gifEncodeFrames,
        outputBytes: output.byteLength,
      };
    } else {
      const webpDecimation = calcAutoDecimation(
        sourceFps,
        WEBP_TARGET_FPS[request.quality],
        request.forceDecimation
      );
      estimatedOutputFrames = Math.max(1, Math.ceil(demuxResult.totalFrames / webpDecimation));

      // Use the parallel Worker-based encoder when its complete resource model fits.
      // Falls back to main-thread OffscreenCanvas encoder, then wasm-webp.
      // Size the pool against the shared source/task/canvas budget before any
      // Worker is created. A zero capacity selects the serial fallback below.
      const w = Math.max(1, Math.floor(codedWidth * request.scale));
      const h = Math.max(1, Math.floor(codedHeight * request.scale));
      const desiredWorkerCount = WebpWorkerPool.getOptimalWorkerCount(w, h);
      const memorySafeWorkerCount = calculateWebpWorkerCountForBudget({
        codedWidth: demuxResult.config.codedWidth ?? codedWidth,
        codedHeight: demuxResult.config.codedHeight ?? codedHeight,
        displayWidth: demuxResult.config.displayAspectWidth ?? codedWidth,
        displayHeight: demuxResult.config.displayAspectHeight ?? codedHeight,
        targetWidth: w,
        targetHeight: h,
        requestedWorkers: desiredWorkerCount,
      });
      workerPool = memorySafeWorkerCount > 0 ? createWorkerPool(memorySafeWorkerCount) : null;
      if (signal?.aborted) {
        terminateWorkerPool();
        signal.throwIfAborted();
      }
      const pool = workerPool;

      // Verify actual capability, not just typeof — some browsers expose
      // OffscreenCanvas but fail on getContext('2d') or lack convertToBlob.
      let offscreenOk = false;
      if (typeof OffscreenCanvas !== 'undefined') {
        try {
          const testCanvas = new OffscreenCanvas(1, 1);
          const ctx = testCanvas.getContext('2d');
          offscreenOk =
            ctx !== null &&
            typeof (testCanvas as OffscreenCanvas & { convertToBlob?: unknown }).convertToBlob ===
              'function';
        } catch {
          // getContext may throw in some environments (e.g., GPU process crash)
        }
      }

      const useParallelEncoder =
        offscreenOk && typeof Worker !== 'undefined' && pool !== null && pool.activeWorkers > 0;

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

        // Decode outside the encoding pool and stream frames directly to its Workers.
        const decimationController = createDynamicDecimationController();

        const frameMemoryBudget = new WebpFrameMemoryBudget({
          codedWidth: demuxResult.config.codedWidth ?? codedWidth,
          codedHeight: demuxResult.config.codedHeight ?? codedHeight,
          displayWidth: demuxResult.config.displayAspectWidth ?? codedWidth,
          displayHeight: demuxResult.config.displayAspectHeight ?? codedHeight,
          targetWidth: w,
          targetHeight: h,
          workerCount: pool.activeWorkers,
        });
        webpFrameMemoryBudget = frameMemoryBudget;
        const streamingEncoder = createStreamingWebpEncoder(
          pool,
          w,
          h,
          request.quality,
          estimatedOutputFrames,
          (p) => {
            const currentFrame = p.currentFrame ?? 0;
            reportEncodingProgress(currentFrame, currentFrame, p.currentFrame ?? null);
          },
          outputLimits,
          signal,
          frameMemoryBudget
        );
        streamingWebpEncoder = streamingEncoder;

        // Accumulate durations from dynamically skipped frames (see offscreen-webp-encoder).
        let dynamicAccumulatedMs = 0;
        let tailAccumulatedMs = 0;

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
                pixelFormat: 'rgba',
                stagedCopyLookahead: true,
                frameMemoryBudget,
                processingFailureSignal: streamingEncoder.failureSignal,
                onFrameDecoded: (frameIdx, _total) => {
                  observedDecodedFrames = Math.max(observedDecodedFrames, frameIdx);
                  transcodeSpan?.update({ decodedFrames: frameIdx });
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
                  rgbaData: Uint8Array,
                  frameDurationMs: number,
                  frameNum: number,
                  memoryHandoff
                ) => {
                  if (signal?.aborted) {
                    globalBufferPool.release(rgbaData);
                    throw new DOMException('Cancelled', 'AbortError');
                  }
                  const shouldSkip = decimationController.shouldSkip(frameNum);
                  if (shouldSkip) {
                    dynamicAccumulatedMs += frameDurationMs;
                    globalBufferPool.release(rgbaData);
                    return;
                  }
                  const totalDuration = frameDurationMs + dynamicAccumulatedMs;
                  dynamicAccumulatedMs = 0;
                  await streamingEncoder.submit(rgbaData, totalDuration, memoryHandoff);
                  // buffer ownership transferred to worker via postMessage — do NOT release
                },
              },
              signal
            ).then((result) => {
              observedDecodedFrames = Math.max(observedDecodedFrames, result.totalInputFrames);
              transcodeSpan?.update({ decodedFrames: observedDecodedFrames });
              tailAccumulatedMs = result.tailAccumulatedMs;
            }),
          { priority: 'user-blocking' }
        );

        // Apply tail accumulated duration from decode (decimation leftovers)
        // plus dynamic decimation leftovers to the last frame.
        const totalTail = tailAccumulatedMs + dynamicAccumulatedMs;
        if (totalTail > 0) {
          streamingEncoder.padLastFrame(totalTail);
        }

        output = toOwnedArrayBuffer(
          await scheduleTask(() => streamingEncoder.finish(), { priority: 'user-visible' })
        );
        encodeResult = {
          frames: estimatedOutputFrames,
          outputBytes: output.byteLength,
        };
      } else if (offscreenOk) {
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

        const onEncodeProgress = createEncodeProgressCb();
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
                smartFrameSkip: request.smartFrameSkip,
                onEncodingComplete: recordCompletedFrameCounts,
                ...outputLimits,
                onFrameDecoded: decodeProgressCb,
              },
              onEncodeProgress,
              signal
            ),
          { priority: 'user-visible' }
        );
        output = toOwnedArrayBuffer(encoded);
        encodeResult = {
          frames: estimatedOutputFrames,
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

        const onEncodeProgress = createEncodeProgressCb();
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
                smartFrameSkip: request.smartFrameSkip,
                onEncodingComplete: recordCompletedFrameCounts,
                ...outputLimits,
                onFrameDecoded: decodeProgressCb,
              },
              onEncodeProgress,
              signal
            ),
          { priority: 'user-visible' }
        );
        output = toOwnedArrayBuffer(encoded);
        encodeResult = {
          frames: estimatedOutputFrames,
          outputBytes: output.byteLength,
        };
      }
    }

    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

    transcodeSpan?.end({
      decodedFrames: Math.max(observedDecodedFrames, observedEncodedFrames),
      encodedFrames: observedEncodedFrames,
      outputBytes: encodeResult?.outputBytes ?? 0,
    });

    // ── Finalization bookkeeping (UI progress remains "assembling") ──
    const finalizationSpan = profiler?.begin('finalizing');

    // Clear buffer pool after conversion
    globalBufferPool.clear();

    const memMB = sampleMemory();
    const totalElapsedMs = Math.round(performance.now() - pipelineStart);
    // Call progress directly instead of scheduling a fire-and-forget task (L3 fix).
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
    // Deliver the terminal state before cleanup cancels any trailing throttle timer.
    throttled.flush();

    finalizationSpan?.end();

    // ── Profile Report ──
    if (profiler) {
      const profileReport = profiler.finish();
      setLastConversionProfileReport(profileReport);
      scheduleTask(
        () => {
          const report = profileReport!;
          logger.performance('Pipeline profile', report);
          logger.info('conversion', `◀ Pipeline complete: ${report.summary}`, {
            format: request.format,
            quality: request.quality,
            scale: request.scale,
            totalFrames: demuxResult.totalFrames,
            outputBytes: output!.byteLength,
            duration: `${(totalElapsedMs / 1000).toFixed(1)}s`,
            peakMemoryMB: report.heapPeakMB,
            dominantStage: report.dominantStage,
            stageWallTimePct: report.stageWallTimePct,
          });
        },
        { priority: 'background' }
      );
    } else {
      logger.info('conversion', '◀ Pipeline complete', {
        format: request.format,
        quality: request.quality,
        scale: request.scale,
        totalFrames: demuxResult.totalFrames,
        outputBytes: output!.byteLength,
        duration: `${(totalElapsedMs / 1000).toFixed(1)}s`,
      });
    }

    return output!;
  } finally {
    signal?.removeEventListener('abort', terminateWorkerPool);
    demuxSession?.dispose?.();
    throttled.cleanup();
    terminateWorkerPool();
    streamingWebpEncoder?.dispose();
    webpFrameMemoryBudget?.dispose();
    clearCanvasCache();
    globalBufferPool.clear();
  }
}
