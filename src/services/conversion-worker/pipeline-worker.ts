// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Pipeline Worker — runs the full conversion pipeline inside a Web Worker.
 *
 * This module is the entry point for worker-side conversion logic.
 * It reuses the existing decoder-service, encoder-service, and frame-utils
 * but replaces requestAnimationFrame with setTimeout(0) and handles the
 * fact that performance.memory is unavailable in Workers.
 */

import { globalBufferPool } from '@services/buffer-pool';
import { demuxVideo } from '@services/demuxer-service';
import { calcAutoDecimation } from '@services/encoder-common';
import { resolveVideoDimensions } from '@services/frame-utils';
import { encodeGif } from '@services/gif-encoder-service';
import { encodeWebp } from '@services/webp-encoder-service';
import type { VideoMetadata } from '@t/conversion-types';
import {
  BYTES_PER_MB,
  DEFAULT_FPS,
  GIF_TARGET_FPS,
  MEMORY_CRITICAL_RATIO,
  PROGRESS_PHASE,
  PROGRESS_PHASE_RANGES,
  WEBP_TARGET_FPS,
  WORKER_MAX_MEMORY_LIMIT_MB,
  WORKER_MAX_MEMORY_MB,
  WORKER_MIN_MEMORY_MB,
} from '@utils/constants';
import type { ConversionProfileReport } from '../conversion-profiler';
import { buildConversionRequest } from './build-conversion-request';
import type { SerializedConversionOptions, SerializedDecoderConfig, WorkerResponse } from './types';
import { createWorkerLogRelay } from './worker-log-relay';

// Aligned progress ranges matching main-thread conversion-pipeline.ts
// demux: 0~3%   decode: 3~73%   encode: 73~93%   assembly: 93~100%
const { DEMUX_MAX, DECODE_MAX, ENCODE_MAX } = PROGRESS_PHASE;
const { DECODE_RANGE, ENCODE_RANGE } = PROGRESS_PHASE_RANGES;

interface WorkerProgressState {
  lastPostTime: number;
  fpsTracker: { current: number; lastTime: number; lastFrame: number };
}

function createWorkerProgressTracker(): WorkerProgressState {
  return {
    lastPostTime: 0,
    fpsTracker: { current: 0, lastTime: performance.now(), lastFrame: 0 },
  };
}

/**
 * Clamps maxMemoryMB to valid bounds.
 * Ensures the value is within [WORKER_MIN_MEMORY_MB, WORKER_MAX_MEMORY_LIMIT_MB].
 */
function clampMaxMemoryMB(value: number): number {
  if (!Number.isFinite(value)) return WORKER_MAX_MEMORY_MB;
  return Math.min(WORKER_MAX_MEMORY_LIMIT_MB, Math.max(WORKER_MIN_MEMORY_MB, value));
}

// ─── Main Worker Pipeline ────────────────────────────────────────────────

/**
 * Runs the full conversion pipeline in a worker.
 * This mirrors the main-thread conversion-pipeline.ts but adapted for worker context.
 */
export async function runWorkerPipeline(
  inputBuffer: ArrayBuffer,
  options: SerializedConversionOptions,
  postMessage: (msg: WorkerResponse, transferables?: Transferable[]) => void,
  requestId: string,
  signal?: AbortSignal,
  config?: SerializedDecoderConfig,
  duration?: number,
  framerate?: number
): Promise<{ outputBuffer: ArrayBuffer; profile?: ConversionProfileReport }> {
  const pipelineStart = performance.now();
  const profilerClass = import.meta.env.DEV
    ? (await import('../conversion-profiler')).ConversionProfiler
    : undefined;
  const profiler = profilerClass ? new profilerClass() : null;

  // Build a ConversionRequest for the existing pipeline code.
  // Use maxMemoryMB from options (if provided) so the worker can receive
  // dynamic memory limits from the main thread.
  const maxMemoryMB =
    options.maxMemoryMB != null
      ? clampMaxMemoryMB(options.maxMemoryMB)
      : clampMaxMemoryMB(WORKER_MAX_MEMORY_MB);

  const request = buildConversionRequest(inputBuffer, options, maxMemoryMB);

  const progressState = createWorkerProgressTracker();
  const relayLog = createWorkerLogRelay(postMessage, requestId);

  relayLog(
    'info',
    'conversion',
    `▶ Worker pipeline started: ${options.format} ${options.quality} ${options.scale}x`
  );

  let output: ArrayBuffer | undefined;

  // ── Memory sampling and guard (H3 fix) ──
  // Workers do not expose performance.memory. Include the transferred input,
  // pooled frame buffers, and any known output buffer in a conservative estimate.
  const sampleMemoryMB = (additionalBytes = 0): number => {
    const estimatedBytes =
      inputBuffer.byteLength + globalBufferPool.totalRetainedMemory + additionalBytes;
    return Math.ceil(estimatedBytes / BYTES_PER_MB);
  };
  const assertMemoryBudget = (additionalBytes = 0): number => {
    const memoryMB = sampleMemoryMB(additionalBytes);
    if (memoryMB >= maxMemoryMB * MEMORY_CRITICAL_RATIO) {
      throw new Error(`Worker memory estimate reached ${memoryMB}MB of ${maxMemoryMB}MB limit`);
    }
    return memoryMB;
  };

  let demuxSession: Awaited<ReturnType<typeof demuxVideo>> | undefined;

  try {
    assertMemoryBudget();

    // ── Pre-computed metadata (avoids redundant extractVideoMetadata in worker) ──
    // When the main thread has already extracted metadata during file selection,
    // reuse it here to skip the expensive extractVideoMetadata → Input.create →
    // getVideoTracks → getDecoderConfig → computeDuration chain inside demuxVideo.
    const preComputedMetadata: VideoMetadata | undefined = config
      ? {
          width: config.codedWidth,
          height: config.codedHeight,
          duration: duration ?? 0,
          codec: config.codec,
          framerate: framerate ?? DEFAULT_FPS,
          bitrate: 0,
          config: {
            codec: config.codec,
            codedWidth: config.codedWidth,
            codedHeight: config.codedHeight,
            ...(config.displayAspectWidth !== undefined
              ? { displayAspectWidth: config.displayAspectWidth }
              : {}),
            ...(config.displayAspectHeight !== undefined
              ? { displayAspectHeight: config.displayAspectHeight }
              : {}),
            ...(config.hardwareAcceleration
              ? { hardwareAcceleration: config.hardwareAcceleration as HardwareAcceleration }
              : {}),
            ...(config.description ? { description: config.description } : {}),
          } as VideoDecoderConfig,
        }
      : undefined;

    // ── Demux Phase ────────────────────────────────────────────
    const demuxSpan = profiler?.begin('demuxing');
    const demuxResult = await demuxVideo(
      request,
      preComputedMetadata,
      (estimatedTotalFrames) => {
        demuxSpan?.update({ frames: estimatedTotalFrames });
        const now = performance.now();
        if (now - progressState.lastPostTime >= 100) {
          progressState.lastPostTime = now;
          const memoryMB = assertMemoryBudget();
          postMessage({
            type: 'progress',
            requestId,
            phase: 'demuxing',
            percent: DEMUX_MAX,
            fps: 0,
            etaSeconds: 0,
            memoryMB,
            currentFrame: estimatedTotalFrames,
            totalFrames: estimatedTotalFrames,
          });
        }
      },
      signal
    );
    demuxSession = demuxResult;
    demuxSpan?.end({ frames: demuxResult.totalFrames });

    const cfg = demuxResult.config;
    const dims = resolveVideoDimensions(cfg);
    if (!dims) {
      throw new Error('Unable to determine video dimensions');
    }
    const { width: codedWidth, height: codedHeight } = dims;

    // ── Decode + Encode Phase ──────────────────────────────────────

    const sourceFps =
      Number.isFinite(demuxResult.framerate) && demuxResult.framerate > 0
        ? demuxResult.framerate
        : DEFAULT_FPS;

    // estimatedOutputFrames is computed after decimation is determined
    let estimatedOutputFrames = 1;
    let observedDecodedFrames = 0;
    let observedEncodedFrames = 0;

    const decodeProgressCb = (frameIdx: number, _totalFrames: number) => {
      observedDecodedFrames = Math.max(observedDecodedFrames, frameIdx);
      transcodeSpan?.update({ decodedFrames: frameIdx });
      const now = performance.now();
      const deltaMs = now - progressState.fpsTracker.lastTime;
      const framesDelta = frameIdx - progressState.fpsTracker.lastFrame;
      progressState.fpsTracker.current =
        deltaMs > 0 && framesDelta > 0 ? Math.round(((framesDelta * 1000) / deltaMs) * 10) / 10 : 0;
      progressState.fpsTracker.lastTime = now;
      progressState.fpsTracker.lastFrame = frameIdx;

      // Throttle progress posts to ~100ms
      if (now - progressState.lastPostTime >= 100) {
        progressState.lastPostTime = now;
        const memoryMB = assertMemoryBudget();
        const decodePct =
          estimatedOutputFrames > 0
            ? Math.round((frameIdx / estimatedOutputFrames) * DECODE_RANGE)
            : 0;
        postMessage({
          type: 'progress',
          requestId,
          phase: 'decoding',
          percent: DEMUX_MAX + Math.min(DECODE_RANGE, decodePct),
          fps: progressState.fpsTracker.current,
          etaSeconds:
            progressState.fpsTracker.current > 0
              ? Math.round((estimatedOutputFrames - frameIdx) / progressState.fpsTracker.current)
              : 0,
          memoryMB,
          currentFrame: frameIdx,
          totalFrames: estimatedOutputFrames,
          outputFrames: estimatedOutputFrames,
        });
      }
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

    if (options.format === 'gif') {
      const gifDecimation = calcAutoDecimation(
        sourceFps,
        GIF_TARGET_FPS[options.quality],
        options.forceDecimation
      );
      estimatedOutputFrames = Math.max(1, Math.ceil(demuxResult.totalFrames / gifDecimation));

      relayLog('info', 'encoders', '├─ GIF encoder (streaming decode→encode)', {
        codec: demuxResult.config.codec,
        codedWidth,
        codedHeight,
        totalFrames: demuxResult.totalFrames,
        sourceFps: Math.round(sourceFps),
        gifDecimation,
      });

      const gifResult = await encodeGif(
        demuxResult,
        {
          width: codedWidth,
          height: codedHeight,
          quality: options.quality,
          scale: options.scale,
          frameDecimation: gifDecimation,
          smartFrameSkip: options.smartFrameSkip,
          onEncodingComplete: recordCompletedFrameCounts,
          maxFrames: request.maxFrames,
          maxOutputBytes: request.maxOutputBytes,
          assertAdditionalMemoryBytes: assertMemoryBudget,
          onFrameDecoded: decodeProgressCb,
          onFrameEncoded: (encodedFrameCount: number, _totalFrames: number) => {
            observedEncodedFrames = Math.max(observedEncodedFrames, encodedFrameCount);
            transcodeSpan?.update({ encodedFrames: encodedFrameCount });
            const now = performance.now();
            if (now - progressState.lastPostTime >= 100) {
              progressState.lastPostTime = now;
              const memoryMB = assertMemoryBudget();
              const encodePct =
                estimatedOutputFrames > 0
                  ? Math.round((encodedFrameCount / estimatedOutputFrames) * ENCODE_RANGE)
                  : 0;
              postMessage({
                type: 'progress',
                requestId,
                phase: 'encoding',
                percent: DECODE_MAX + Math.min(ENCODE_RANGE, encodePct),
                fps: progressState.fpsTracker.current,
                etaSeconds:
                  progressState.fpsTracker.current > 0
                    ? Math.round(
                        (estimatedOutputFrames - encodedFrameCount) /
                          progressState.fpsTracker.current
                      )
                    : 0,
                memoryMB,
                currentFrame: encodedFrameCount,
                totalFrames: estimatedOutputFrames,
                outputFrames: estimatedOutputFrames,
              });
            }
          },
        },
        signal
      );
      output = gifResult.buffer as ArrayBuffer;
    } else {
      const webpDecimation = calcAutoDecimation(
        sourceFps,
        WEBP_TARGET_FPS[options.quality],
        options.forceDecimation
      );
      estimatedOutputFrames = Math.max(1, Math.ceil(demuxResult.totalFrames / webpDecimation));

      // ── wasm-webp encodeRGB path (primary, most compatible) ──
      // Uses encodeWebp from webp-encoder-service which invokes
      // wasm-webp's encodeRGB for each frame, then muxes via
      // StreamingWebpMuxer. Proven reliable across all quality/scale
      // combinations.
      //
      // NOTE: OffscreenCanvas path (encodeWebpOffscreen) is available
      // as fallback but disabled by default due to VP8 coded-size vs
      // ANMF canvas mismatch on certain quality settings.
      if (!output) {
        relayLog('info', 'encoders', '├─ WebP encoder (wasm-webp encodeRGB + mux)', {
          codec: demuxResult.config.codec,
          codedWidth,
          codedHeight,
          totalFrames: demuxResult.totalFrames,
          sourceFps: Math.round(sourceFps),
          webpDecimation,
        });

        const webpResult = await encodeWebp(
          demuxResult,
          {
            width: codedWidth,
            height: codedHeight,
            quality: options.quality,
            scale: options.scale,
            frameDecimation: webpDecimation,
            smartFrameSkip: options.smartFrameSkip,
            onEncodingComplete: recordCompletedFrameCounts,
            maxFrames: request.maxFrames,
            maxOutputBytes: request.maxOutputBytes,
            onFrameDecoded: decodeProgressCb,
          },
          (p) => {
            observedEncodedFrames = Math.max(observedEncodedFrames, p.currentFrame ?? 0);
            transcodeSpan?.update({ encodedFrames: p.currentFrame ?? 0 });
            const now = performance.now();
            if (now - progressState.lastPostTime >= 100) {
              progressState.lastPostTime = now;
              const memoryMB = assertMemoryBudget();
              const encodePct =
                estimatedOutputFrames > 0
                  ? Math.round(((p.currentFrame ?? 0) / estimatedOutputFrames) * ENCODE_RANGE)
                  : 0;
              postMessage({
                type: 'progress',
                requestId,
                phase: 'encoding',
                percent: Math.min(ENCODE_MAX, DECODE_MAX + encodePct),
                fps: progressState.fpsTracker.current,
                etaSeconds:
                  progressState.fpsTracker.current > 0 && p.currentFrame != null
                    ? Math.round(
                        (estimatedOutputFrames - p.currentFrame) / progressState.fpsTracker.current
                      )
                    : 0,
                memoryMB,
                currentFrame: p.currentFrame ?? 0,
                totalFrames: estimatedOutputFrames,
                outputFrames: estimatedOutputFrames,
              });
            }
          },
          signal
        );
        output = webpResult.buffer as ArrayBuffer;
      }
    }

    transcodeSpan?.end({
      decodedFrames: Math.max(observedDecodedFrames, observedEncodedFrames),
      encodedFrames: observedEncodedFrames,
      outputBytes: output?.byteLength ?? 0,
    });

    // ── Finalization bookkeeping (UI progress remains "assembling") ──
    const finalizationSpan = profiler?.begin('finalizing');
    globalBufferPool.clear();

    // Guard: ensure output was produced (M10 fix).
    if (!output) {
      throw new Error('Worker pipeline completed without producing output');
    }

    const totalElapsedMs = Math.round(performance.now() - pipelineStart);
    const memoryMB = assertMemoryBudget(output.byteLength);
    postMessage({
      type: 'progress',
      requestId,
      phase: 'assembling',
      percent: 100,
      fps: 0,
      etaSeconds: 0,
      memoryMB,
      currentFrame: demuxResult.totalFrames,
      totalFrames: demuxResult.totalFrames,
      outputFrames: estimatedOutputFrames,
      elapsedMs: totalElapsedMs,
    });

    finalizationSpan?.end();
    const profile = profiler?.finish();

    return { outputBuffer: output, ...(profile ? { profile } : {}) };
  } finally {
    demuxSession?.dispose?.();
    // Ensure buffer pool is cleared on any error path (matching main thread)
    globalBufferPool.clear();
  }
}
