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
  FRAME_PIPELINE_MEMORY_BUDGET_BYTES,
  GIF_TARGET_FPS,
  MEMORY_CRITICAL_RATIO,
  PROGRESS_PHASE,
  PROGRESS_PHASE_RANGES,
  PROGRESS_THROTTLE_MS,
  WEBP_QUALITY_PERCENT,
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
import { type EncoderFrameCounts, resolveCadencePolicy } from './encoder-common';
import { calculateWebpWorkerCountForBudget, WebpFrameMemoryBudget } from './frame-memory';
import {
  clearCanvasCache,
  MOTION_SIGNATURE_PEAK_BYTES,
  resolveVideoDimensions,
} from './frame-utils';
import { encodeGif } from './gif-encoder-service';
import { encodeWebpOffscreen } from './offscreen-webp-encoder';
import { resolveOutputLimits } from './output-limits';
import { createStreamingWebpEncoder, type StreamingWebpEncoder } from './parallel-webp-encoder';
import { probeCanvasWebpCapability } from './webp-capability';
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

/** GIF uses an exact owned buffer; WebP keeps the completed immutable Blob. */
export type MainThreadConversionOutput = ArrayBuffer | Blob;

export async function runConversionPipeline(
  request: ConversionRequest,
  onProgress: ProgressCallback,
  signal?: AbortSignal
): Promise<MainThreadConversionOutput> {
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
): Promise<MainThreadConversionOutput> {
  const throttled = createThrottledProgress(onProgress, PROGRESS_THROTTLE_MS);
  const profileOperation = profiler?.recordOperation;
  const profileCopyPath = profiler?.recordCopyPath;

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
    let lastMemMB: number | null = null;
    const sampleMemory = (): number | null => {
      const now = performance.now();
      if (now - lastMemSampleTime >= 1000) {
        lastMemSampleTime = now;
        lastMemMB = getMemoryUsageMB();
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
    const sampleAccountedMemoryMB = (additionalBytes = 0): number =>
      Math.ceil(
        (retainedInputBytes + globalBufferPool.totalRetainedMemory + additionalBytes) / BYTES_PER_MB
      );
    const decimationMemoryCheck = () => ({
      usagePercentage: Math.min(100, (sampleAccountedMemoryMB() / maxMemoryMB) * 100),
    });
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
    const dims = resolveVideoDimensions({ ...cfg, rotation: demuxResult.rotation });
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
    let output: MainThreadConversionOutput | undefined;
    let encodeResult: { outputBytes: number } | null = null;

    // Track frame times for FPS calculation
    // The decoder reports bounded native counts independently of frame selection;
    // compute rate from observed count advancement over the elapsed interval.
    const fpsTracker = { current: 0, lastTime: performance.now(), lastFrame: 0 };

    // estimatedOutputFrames is computed after decimationRatio is determined
    let estimatedOutputFrames = 1;
    let observedCounts: EncoderFrameCounts = { decodedFrames: 0, encodedFrames: 0 };

    const decodeProgressCb = (frameIdx: number, _totalFrames: number) => {
      observedCounts.decodedFrames = Math.max(observedCounts.decodedFrames, frameIdx);
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
        demuxResult.totalFrames > 0
          ? Math.round((frameIdx / demuxResult.totalFrames) * DECODE_RANGE)
          : 0;
      throttled.callback({
        phase: 'decoding',
        progress: DEMUX_MAX + Math.min(DECODE_RANGE, decodePct),
        fps: fpsTracker.current,
        etaSeconds:
          fpsTracker.current > 0 && demuxResult.totalFrames > frameIdx
            ? Math.ceil((demuxResult.totalFrames - frameIdx) / fpsTracker.current)
            : null,
        memoryMB: sampleMemory(),
        accountedMemoryMB: sampleAccountedMemoryMB(),
        currentFrame: frameIdx,
        decodedFrames: frameIdx,
        totalFrames: demuxResult.totalFrames,
        elapsedMs: Math.round(now - pipelineStart),
      });
    };

    const encodingFpsTracker = { current: 0, lastTime: performance.now(), lastFrame: 0 };
    const reportEncodingProgress = (
      progressFrame: number,
      currentFrame: number,
      etaFrame: number | null
    ): void => {
      const now = performance.now();
      const elapsed = now - encodingFpsTracker.lastTime;
      const completed = currentFrame - encodingFpsTracker.lastFrame;
      if (elapsed > 0 && completed > 0) {
        const instantaneous = (completed * 1000) / elapsed;
        encodingFpsTracker.current =
          encodingFpsTracker.current === 0
            ? instantaneous
            : encodingFpsTracker.current * 0.7 + instantaneous * 0.3;
        encodingFpsTracker.lastTime = now;
        encodingFpsTracker.lastFrame = currentFrame;
      }
      observedCounts.encodedFrames = Math.max(observedCounts.encodedFrames, currentFrame);
      transcodeSpan?.update({ encodedFrames: currentFrame });
      throttled.callback(
        buildEncodingProgress({
          progressFrame,
          currentFrame,
          etaFrame,
          totalFrames: estimatedOutputFrames,
          fps: Math.round(encodingFpsTracker.current * 10) / 10,
          memoryMB: sampleMemory(),
          accountedMemoryMB: sampleAccountedMemoryMB(),
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
    const recordCompletedFrameCounts = (counts: EncoderFrameCounts): void => {
      observedCounts = counts;
      transcodeSpan?.update(counts);
    };

    const sourceFps =
      Number.isFinite(demuxResult.framerate) && demuxResult.framerate > 0
        ? demuxResult.framerate
        : DEFAULT_FPS;

    if (request.format === 'gif') {
      profiler?.setEncoderRoute('gif-main');
      const gifCadence = resolveCadencePolicy(
        sourceFps,
        GIF_TARGET_FPS[request.quality],
        request.forceDecimation,
        request.memoryPressureCadenceRatio
      );
      const gifDecimation = gifCadence.frameDecimation;
      estimatedOutputFrames = Math.max(
        1,
        Math.ceil(
          demuxResult.totalFrames / Math.max(gifDecimation, gifCadence.pressureCadenceRatio ?? 1)
        )
      );

      logger.info('conversion', '  ├─ Branch: GIF encoder (streaming decode→encode)', {
        codec: demuxResult.config.codec,
        codedWidth: demuxResult.config.codedWidth,
        codedHeight: demuxResult.config.codedHeight,
        totalFrames: demuxResult.totalFrames,
        sourceFps: Math.round(sourceFps),
        gifDecimation,
      });

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
                minimumSourceFrameGap: gifCadence.minimumSourceFrameGap,
                pressureCadenceRatio: gifCadence.pressureCadenceRatio,
                smartFrameSkip: request.smartFrameSkip,
                decimationMemoryCheck,
                onEncodingComplete: recordCompletedFrameCounts,
                profileOperation,
                profileCopyPath,
                ...outputLimits,
                assertAdditionalMemoryBytes: assertMemoryBudget,
                onFrameDecoded: decodeProgressCb,
                onFrameEncoded: (encodedFrameCount: number, _totalFrames: number) => {
                  reportEncodingProgress(encodedFrameCount, encodedFrameCount, encodedFrameCount);
                },
              },
              signal
            ),
          { priority: 'user-visible' }
        )
      );
      encodeResult = {
        outputBytes: output.byteLength,
      };
    } else {
      const webpCadence = resolveCadencePolicy(
        sourceFps,
        WEBP_TARGET_FPS[request.quality],
        request.forceDecimation,
        request.memoryPressureCadenceRatio
      );
      const webpDecimation = webpCadence.frameDecimation;
      estimatedOutputFrames = Math.max(
        1,
        Math.ceil(
          demuxResult.totalFrames / Math.max(webpDecimation, webpCadence.pressureCadenceRatio ?? 1)
        )
      );

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
        analysisBytes:
          request.smartFrameSkip && request.smartFrameSkip !== 'off'
            ? MOTION_SIGNATURE_PEAK_BYTES
            : 0,
      });
      const offscreenOk = await probeCanvasWebpCapability(
        WEBP_QUALITY_PERCENT[request.quality] / 100
      );
      workerPool =
        offscreenOk && typeof Worker !== 'undefined' && memorySafeWorkerCount > 0
          ? createWorkerPool(memorySafeWorkerCount)
          : null;
      if (signal?.aborted) {
        terminateWorkerPool();
        signal.throwIfAborted();
      }
      const pool = workerPool;

      const useParallelEncoder =
        offscreenOk && typeof Worker !== 'undefined' && pool !== null && pool.activeWorkers > 0;

      if (useParallelEncoder) {
        profiler?.setEncoderRoute('webp-parallel-canvas');
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
        const decimationController = createDynamicDecimationController(() => ({
          usagePercentage: Math.min(
            100,
            (frameMemoryBudget.usage.totalBytes / FRAME_PIPELINE_MEMORY_BUDGET_BYTES) * 100
          ),
        }));

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
          frameMemoryBudget,
          profileOperation
        );
        streamingWebpEncoder = streamingEncoder;

        // Original presentation boundaries preserve holds across dynamic skips.
        let presentationEndUs: number | undefined;

        await scheduleTask(
          () =>
            decodeFrames(
              demuxResult,
              {
                width: w,
                height: h,
                frameDecimation: webpDecimation,
                minimumSourceFrameGap: webpCadence.minimumSourceFrameGap,
                pressureCadenceRatio: webpCadence.pressureCadenceRatio,
                hwAccel: 'prefer-hardware',
                smartFrameSkip: request.smartFrameSkip,
                pixelFormat: 'rgba',
                profileOperation,
                profileCopyPath,
                stagedCopyLookahead: true,
                frameMemoryBudget,
                processingFailureSignal: streamingEncoder.failureSignal,
                onFrameDecoded: decodeProgressCb,
                onFrameAvailable: async (
                  rgbaData: Uint8Array,
                  frameDurationMs: number,
                  frameNum: number,
                  memoryHandoff,
                  timing
                ) => {
                  if (signal?.aborted) {
                    globalBufferPool.release(rgbaData);
                    throw new DOMException('Cancelled', 'AbortError');
                  }
                  const shouldSkip = decimationController.shouldSkip(frameNum);
                  if (shouldSkip) {
                    globalBufferPool.release(rgbaData);
                    return;
                  }
                  await streamingEncoder.submit(rgbaData, frameDurationMs, memoryHandoff, timing);
                  // buffer ownership transferred to worker via postMessage — do NOT release
                },
              },
              signal
            ).then((result) => {
              observedCounts = {
                consumedChunks: result.consumedChunks,
                decodedFrames: result.decodedFrames,
                selectedFrames: result.selectedFrames,
                encodedFrames: observedCounts.encodedFrames,
              };
              transcodeSpan?.update(observedCounts);
              presentationEndUs = result.presentationEndUs;
            }),
          { priority: 'user-blocking' }
        );

        output = await scheduleTask(() => streamingEncoder.finish(presentationEndUs), {
          priority: 'user-visible',
        });
        recordCompletedFrameCounts({
          ...observedCounts,
          encodedFrames: streamingEncoder.encodedFrames,
          emittedFrames: streamingEncoder.emittedFrames,
        });
        encodeResult = {
          outputBytes: output.size,
        };
      } else if (offscreenOk) {
        profiler?.setEncoderRoute('webp-serial-canvas');
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
                minimumSourceFrameGap: webpCadence.minimumSourceFrameGap,
                pressureCadenceRatio: webpCadence.pressureCadenceRatio,
                smartFrameSkip: request.smartFrameSkip,
                decimationMemoryCheck,
                onEncodingComplete: recordCompletedFrameCounts,
                profileOperation,
                profileCopyPath,
                ...outputLimits,
                onFrameDecoded: decodeProgressCb,
              },
              onEncodeProgress,
              signal
            ),
          { priority: 'user-visible' }
        );
        output = encoded;
        encodeResult = {
          outputBytes: output.size,
        };
      } else {
        profiler?.setEncoderRoute('webp-wasm');
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
                minimumSourceFrameGap: webpCadence.minimumSourceFrameGap,
                pressureCadenceRatio: webpCadence.pressureCadenceRatio,
                smartFrameSkip: request.smartFrameSkip,
                decimationMemoryCheck,
                onEncodingComplete: recordCompletedFrameCounts,
                profileOperation,
                profileCopyPath,
                ...outputLimits,
                onFrameDecoded: decodeProgressCb,
              },
              onEncodeProgress,
              signal
            ),
          { priority: 'user-visible' }
        );
        output = encoded;
        encodeResult = {
          outputBytes: output.size,
        };
      }
    }

    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

    transcodeSpan?.end({
      ...observedCounts,
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
      ...observedCounts,
      currentFrame: observedCounts.decodedFrames,
      totalFrames: observedCounts.decodedFrames,
      outputFrames: observedCounts.emittedFrames,
      elapsedMs: totalElapsedMs,
    });
    throttled.callback({
      phase: 'assembling',
      progress: 100,
      fps: 0,
      etaSeconds: 0,
      memoryMB: memMB,
      ...observedCounts,
      currentFrame: observedCounts.decodedFrames,
      totalFrames: observedCounts.decodedFrames,
      outputFrames: observedCounts.emittedFrames,
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
            outputBytes: output instanceof Blob ? output.size : output!.byteLength,
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
        outputBytes: output instanceof Blob ? output.size : output!.byteLength,
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
