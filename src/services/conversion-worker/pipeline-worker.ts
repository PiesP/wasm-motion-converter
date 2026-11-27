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
import { ConversionMemoryLimitError } from '@services/conversion-memory-limit-error';
import type { ConversionProfileReport } from '@services/conversion-profiler';
import { demuxVideo } from '@services/demuxer-service';
import { type EncoderFrameCounts, resolveCadencePolicy } from '@services/encoder-common';
import { clearCanvasCache, resolveVideoDimensions } from '@services/frame-utils';
import { encodeGif, encodeGifParts, type GifOutputPart } from '@services/gif-encoder-service';
import type { OwnedInputIndexSnapshot } from '@services/owned-input-index-cache';
import {
  discardOwnedVp8Module,
  getOwnedVp8ModuleBytes,
  waitForOwnedVp8Load,
} from '@services/owned-vp8-module-state';
import { encodeWebpOwned } from '@services/webp-encoder-service';
import {
  BYTES_PER_MB,
  DEFAULT_FPS,
  DEMUX_MEMORY_BUDGET_BYTES,
  GIF_TARGET_FPS,
  MEMORY_CRITICAL_RATIO,
  PROGRESS_PHASE,
  PROGRESS_PHASE_RANGES,
  WEBP_TARGET_FPS,
  WORKER_MAX_MEMORY_MB,
  WORKER_MIN_MEMORY_MB,
} from '@utils/constants';

import { buildConversionRequest } from './build-conversion-request';
import type {
  GifPartsSummary,
  SerializedConversionOptions,
  SerializedDecoderConfig,
  WorkerResponse,
} from './types';
import { createWorkerLogRelay } from './worker-log-relay';

// Decode and encode overlap in this streaming route. Their bounded weighted
// completion fractions share 3~93%; final assembly owns the terminal 100%.
const { DEMUX_MAX, ENCODE_MAX } = PROGRESS_PHASE;
const { DECODE_RANGE, ENCODE_RANGE } = PROGRESS_PHASE_RANGES;

interface WorkerRateTracker {
  current: number;
  lastTime: number;
  lastCount: number;
}

interface WorkerProgressState {
  lastPostTime: number;
  lastPercent: number;
  decodeRate: WorkerRateTracker;
  encodeRate: WorkerRateTracker;
}

type ObservedFrameCounts = Partial<Record<keyof EncoderFrameCounts, number>>;

function createWorkerProgressTracker(): WorkerProgressState {
  const now = performance.now();
  return {
    lastPostTime: Number.NEGATIVE_INFINITY,
    lastPercent: 0,
    decodeRate: { current: 0, lastTime: now, lastCount: 0 },
    encodeRate: { current: 0, lastTime: now, lastCount: 0 },
  };
}

function observeRate(rate: WorkerRateTracker, count: number, now: number): void {
  const elapsedMs = now - rate.lastTime;
  const advanced = count - rate.lastCount;
  if (elapsedMs < 100 || advanced <= 0) return;
  rate.current = Math.round(((advanced * 1000) / elapsedMs) * 10) / 10;
  rate.lastTime = now;
  rate.lastCount = count;
}

function estimateEta(count: number | undefined, total: number, fps: number): number | null {
  if (count === undefined || total <= count || fps <= 0) return null;
  return Math.max(0, Math.ceil((total - count) / fps));
}

/**
 * Clamps maxMemoryMB to valid bounds.
 * Ensures the value is within [WORKER_MIN_MEMORY_MB, WORKER_MAX_MEMORY_MB].
 */
function clampMaxMemoryMB(value: number): number {
  if (!Number.isFinite(value)) return WORKER_MAX_MEMORY_MB;
  return Math.min(WORKER_MAX_MEMORY_MB, Math.max(WORKER_MIN_MEMORY_MB, value));
}

// ─── Main Worker Pipeline ────────────────────────────────────────────────

/**
 * Runs the full conversion pipeline in a worker.
 * This mirrors the main-thread conversion-pipeline.ts but adapted for worker context.
 */
type WorkerBufferResult = { outputBuffer: ArrayBuffer; profile?: ConversionProfileReport };
type WorkerSavePart = (part: GifOutputPart) => Promise<void>;

export function runWorkerPipeline(
  input: ArrayBuffer | Blob,
  options: SerializedConversionOptions,
  postMessage: (msg: WorkerResponse, transferables?: Transferable[]) => void,
  requestId: string,
  signal: AbortSignal | undefined,
  config: SerializedDecoderConfig | undefined,
  duration: number | undefined,
  framerate: number | undefined,
  indexSnapshot: OwnedInputIndexSnapshot | undefined,
  savePart: WorkerSavePart
): Promise<GifPartsSummary>;
export function runWorkerPipeline(
  input: ArrayBuffer | Blob,
  options: SerializedConversionOptions,
  postMessage: (msg: WorkerResponse, transferables?: Transferable[]) => void,
  requestId: string,
  signal?: AbortSignal,
  config?: SerializedDecoderConfig,
  duration?: number,
  framerate?: number,
  indexSnapshot?: OwnedInputIndexSnapshot
): Promise<WorkerBufferResult>;
export async function runWorkerPipeline(
  input: ArrayBuffer | Blob,
  options: SerializedConversionOptions,
  postMessage: (msg: WorkerResponse, transferables?: Transferable[]) => void,
  requestId: string,
  signal?: AbortSignal,
  config?: SerializedDecoderConfig,
  duration?: number,
  framerate?: number,
  indexSnapshot?: OwnedInputIndexSnapshot,
  savePart?: WorkerSavePart
): Promise<WorkerBufferResult | GifPartsSummary> {
  const pipelineStart = performance.now();
  const previousLoad = waitForOwnedVp8Load(signal);
  if (previousLoad) await previousLoad;
  signal?.throwIfAborted();
  if (options.format === 'gif') discardOwnedVp8Module();
  const profilerClass = import.meta.env.DEV
    ? (await import('@services/conversion-profiler')).ConversionProfiler
    : undefined;
  const profiler = profilerClass ? new profilerClass() : null;
  const profileOperation = profiler?.recordOperation;
  const profileCopyPath = profiler?.recordCopyPath;

  // Build a ConversionRequest for the existing pipeline code.
  // Use maxMemoryMB from options (if provided) so the worker can receive
  // dynamic memory limits from the main thread.
  const maxMemoryMB =
    options.maxMemoryMB != null
      ? clampMaxMemoryMB(options.maxMemoryMB)
      : clampMaxMemoryMB(WORKER_MAX_MEMORY_MB);

  const inputBuffer = input instanceof ArrayBuffer ? input : undefined;
  const inputBlob = input instanceof Blob ? input : undefined;
  const request = buildConversionRequest(
    inputBuffer,
    options,
    maxMemoryMB,
    inputBlob,
    'input.webm',
    config,
    duration,
    framerate,
    indexSnapshot
  );

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
  const retainedIndexBytes = 2 * (request.indexSnapshot?.bytes.byteLength ?? 0);
  const sampleMemoryMB = (additionalBytes = 0): number => {
    const estimatedBytes =
      (inputBuffer?.byteLength ?? 0) +
      retainedIndexBytes +
      globalBufferPool.totalRetainedMemory +
      getOwnedVp8ModuleBytes() +
      additionalBytes;
    return Math.ceil(estimatedBytes / BYTES_PER_MB);
  };
  const assertMemoryBudget = (additionalBytes = 0): number => {
    const memoryMB = sampleMemoryMB(additionalBytes);
    if (memoryMB >= maxMemoryMB * MEMORY_CRITICAL_RATIO) {
      throw new ConversionMemoryLimitError(
        `Worker memory estimate reached ${memoryMB}MB of ${maxMemoryMB}MB limit`
      );
    }
    return memoryMB;
  };

  // This accounts for owned buffers; it is a lower bound, not a heap reading.
  const decimationMemoryCheck = () => ({
    usagePercentage: Math.min(100, (sampleMemoryMB() / maxMemoryMB) * 100),
  });
  let sourceTotalFrames = 0;
  let estimatedOutputFrames = 0;
  let observedCounts: ObservedFrameCounts = {};

  const postProgress = (
    requestedPhase: 'demuxing' | 'decoding' | 'encoding' | 'assembling',
    force = false,
    additionalBytes = 0
  ): void => {
    const now = performance.now();
    if (!force && now - progressState.lastPostTime < 100) return;

    const accountedMemoryMB = assertMemoryBudget(additionalBytes);
    const decodedFraction =
      sourceTotalFrames > 0 && observedCounts.decodedFrames !== undefined
        ? Math.min(1, observedCounts.decodedFrames / sourceTotalFrames)
        : 0;
    const encodedFraction =
      estimatedOutputFrames > 0 && observedCounts.encodedFrames !== undefined
        ? Math.min(1, observedCounts.encodedFrames / estimatedOutputFrames)
        : 0;
    const weightedPercent = Math.min(
      ENCODE_MAX,
      DEMUX_MAX + Math.round(decodedFraction * DECODE_RANGE + encodedFraction * ENCODE_RANGE)
    );
    const percent =
      requestedPhase === 'assembling'
        ? 100
        : Math.max(
            progressState.lastPercent,
            requestedPhase === 'demuxing' ? DEMUX_MAX : weightedPercent
          );
    const phase =
      requestedPhase === 'assembling' || requestedPhase === 'demuxing'
        ? requestedPhase
        : observedCounts.encodedFrames === undefined
          ? 'decoding'
          : 'encoding';
    const rate = phase === 'decoding' ? progressState.decodeRate : progressState.encodeRate;
    const currentFrame =
      phase === 'encoding' ? observedCounts.encodedFrames : observedCounts.decodedFrames;
    const totalFrames = phase === 'encoding' ? estimatedOutputFrames : sourceTotalFrames;
    const etaSeconds =
      phase === 'assembling'
        ? 0
        : phase === 'demuxing'
          ? null
          : estimateEta(currentFrame, totalFrames, rate.current);

    progressState.lastPostTime = now;
    progressState.lastPercent = percent;
    postMessage({
      type: 'progress',
      requestId,
      phase,
      percent,
      fps: phase === 'assembling' || phase === 'demuxing' ? 0 : rate.current,
      etaSeconds,
      memoryMB: null,
      accountedMemoryMB,
      ...observedCounts,
      ...(currentFrame !== undefined ? { currentFrame } : {}),
      ...(totalFrames > 0 ? { totalFrames } : {}),
      ...(observedCounts.emittedFrames !== undefined
        ? { outputFrames: observedCounts.emittedFrames }
        : {}),
      ...(phase === 'assembling' ? { elapsedMs: Math.round(now - pipelineStart) } : {}),
    });
  };

  const toExactOutputBuffer = (bytes: Uint8Array): ArrayBuffer => {
    if (
      bytes.buffer instanceof ArrayBuffer &&
      bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength
    ) {
      assertMemoryBudget(bytes.byteLength);
      return bytes.buffer;
    }

    // A subarray can retain unrelated output capacity or borrowed WASM memory.
    // Account for both live views before taking an exact transferable copy.
    assertMemoryBudget(bytes.buffer.byteLength + bytes.byteLength);
    const copyStart = profileOperation ? performance.now() : null;
    const exact = bytes.slice().buffer;
    if (copyStart !== null) {
      profileOperation?.('outputCopy', Math.max(0, performance.now() - copyStart));
    }
    return exact;
  };

  let demuxSession: Awaited<ReturnType<typeof demuxVideo>> | undefined;

  try {
    if (
      getOwnedVp8ModuleBytes() > 0 &&
      sampleMemoryMB(Math.max(0, DEMUX_MEMORY_BUDGET_BYTES - retainedIndexBytes)) >=
        maxMemoryMB * MEMORY_CRITICAL_RATIO
    )
      discardOwnedVp8Module();
    assertMemoryBudget();

    // ── Demux Phase ────────────────────────────────────────────
    const demuxSpan = profiler?.begin('demuxing');
    const demuxResult = await demuxVideo(
      request,
      request.preComputedMetadata,
      (_estimatedTotalFrames) => {
        // Media metadata is an estimate, not a count of consumed chunks.
        postProgress('demuxing');
      },
      signal
    );
    demuxSession = demuxResult;
    sourceTotalFrames = demuxResult.totalFrames;
    demuxSpan?.end();

    const cfg = demuxResult.config;
    const dims = resolveVideoDimensions({ ...cfg, rotation: demuxResult.rotation });
    if (!dims) {
      throw new Error('Unable to determine video dimensions');
    }
    const { width: codedWidth, height: codedHeight } = dims;

    // ── Decode + Encode Phase ──────────────────────────────────────

    const sourceFps =
      Number.isFinite(demuxResult.framerate) && demuxResult.framerate > 0
        ? demuxResult.framerate
        : DEFAULT_FPS;

    const transcodeSpan = profiler?.begin('transcoding');
    const decodeProgressCb = (decodedFrames: number, _totalFrames: number): void => {
      observedCounts.decodedFrames = decodedFrames;
      transcodeSpan?.update({ decodedFrames });
      observeRate(progressState.decodeRate, decodedFrames, performance.now());
      postProgress('decoding');
    };
    const encodedProgressCb = (encodedFrames: number): void => {
      observedCounts.encodedFrames = encodedFrames;
      transcodeSpan?.update({ encodedFrames });
      observeRate(progressState.encodeRate, encodedFrames, performance.now());
      postProgress('encoding');
    };
    const recordCompletedFrameCounts = (counts: EncoderFrameCounts): void => {
      observedCounts = {
        decodedFrames: counts.decodedFrames,
        encodedFrames: counts.encodedFrames,
        ...(counts.consumedChunks !== undefined ? { consumedChunks: counts.consumedChunks } : {}),
        ...(counts.selectedFrames !== undefined ? { selectedFrames: counts.selectedFrames } : {}),
        ...(counts.emittedFrames !== undefined ? { emittedFrames: counts.emittedFrames } : {}),
        ...(counts.gifRetainedMappedFrames !== undefined
          ? { gifRetainedMappedFrames: counts.gifRetainedMappedFrames }
          : {}),
        ...(counts.gifRetainedImageDataWrites !== undefined
          ? { gifRetainedImageDataWrites: counts.gifRetainedImageDataWrites }
          : {}),
        ...(counts.gifRetainedWasmCapacityBytes !== undefined
          ? { gifRetainedWasmCapacityBytes: counts.gifRetainedWasmCapacityBytes }
          : {}),
        ...(counts.ownedVp8Frames !== undefined ? { ownedVp8Frames: counts.ownedVp8Frames } : {}),
        ...(counts.ownedVp8Steps !== undefined ? { ownedVp8Steps: counts.ownedVp8Steps } : {}),
        ...(counts.ownedVp8HostTaskYields !== undefined
          ? { ownedVp8HostTaskYields: counts.ownedVp8HostTaskYields }
          : {}),
        ...(counts.ownedVp8PeakActualLinearCapacityBytes !== undefined
          ? { ownedVp8PeakActualLinearCapacityBytes: counts.ownedVp8PeakActualLinearCapacityBytes }
          : {}),
        ...(counts.ownedVp8PeakReservedLinearCapacityBytes !== undefined
          ? {
              ownedVp8PeakReservedLinearCapacityBytes:
                counts.ownedVp8PeakReservedLinearCapacityBytes,
            }
          : {}),
      };
      transcodeSpan?.update(observedCounts);
    };

    if (options.format === 'gif') {
      const gifCadence = resolveCadencePolicy(
        sourceFps,
        GIF_TARGET_FPS[options.quality],
        options.forceDecimation,
        options.memoryPressureCadenceRatio
      );
      const gifDecimation = gifCadence.frameDecimation;
      estimatedOutputFrames = Math.max(
        1,
        Math.ceil(
          demuxResult.totalFrames / Math.max(gifDecimation, gifCadence.pressureCadenceRatio ?? 1)
        )
      );
      profiler?.setEncoderRoute('gif-worker');

      relayLog('info', 'encoders', '├─ GIF encoder (streaming decode→encode)', {
        codec: demuxResult.config.codec,
        codedWidth,
        codedHeight,
        totalFrames: demuxResult.totalFrames,
        sourceFps: Math.round(sourceFps),
        gifDecimation,
      });

      const gifOptions = {
        width: codedWidth,
        height: codedHeight,
        quality: options.quality,
        scale: options.scale,
        frameDecimation: gifDecimation,
        minimumSourceFrameGap: gifCadence.minimumSourceFrameGap,
        pressureCadenceRatio: gifCadence.pressureCadenceRatio,
        smartFrameSkip: options.smartFrameSkip,
        playCount: request.playCount,
        decimationMemoryCheck,
        onEncodingComplete: recordCompletedFrameCounts,
        profileOperation,
        profileCopyPath,
        maxFrames: request.maxFrames,
        maxOutputBytes: request.maxOutputBytes,
        assertAdditionalMemoryBytes: assertMemoryBudget,
        onFrameDecoded: decodeProgressCb,
        onFrameEncoded: encodedProgressCb,
      };
      if (savePart) {
        const summary = await encodeGifParts(demuxResult, gifOptions, savePart, signal);
        signal?.throwIfAborted();
        transcodeSpan?.end(observedCounts);
        postProgress('assembling', true);
        return summary;
      }
      const gifResult = await encodeGif(demuxResult, gifOptions, signal);
      output = toExactOutputBuffer(gifResult);
    } else {
      const webpCadence = resolveCadencePolicy(
        sourceFps,
        WEBP_TARGET_FPS[options.quality],
        options.forceDecimation,
        options.memoryPressureCadenceRatio
      );
      const webpDecimation = webpCadence.frameDecimation;
      estimatedOutputFrames = Math.max(
        1,
        Math.ceil(
          demuxResult.totalFrames / Math.max(webpDecimation, webpCadence.pressureCadenceRatio ?? 1)
        )
      );
      profiler?.setEncoderRoute('webp-owned-vp8');

      // This Worker helper uses conversion-owned WASM VP8. The UI WebP request
      // uses the main pipeline's probed parallel/serial Canvas selection first.
      if (!output) {
        relayLog('info', 'encoders', '├─ WebP encoder (owned VP8 + mux)', {
          codec: demuxResult.config.codec,
          codedWidth,
          codedHeight,
          totalFrames: demuxResult.totalFrames,
          sourceFps: Math.round(sourceFps),
          webpDecimation,
        });

        const webpResult = await encodeWebpOwned(
          demuxResult,
          {
            width: codedWidth,
            height: codedHeight,
            quality: options.quality,
            scale: options.scale,
            frameDecimation: webpDecimation,
            minimumSourceFrameGap: webpCadence.minimumSourceFrameGap,
            pressureCadenceRatio: webpCadence.pressureCadenceRatio,
            smartFrameSkip: options.smartFrameSkip,
            playCount: request.playCount,
            decimationMemoryCheck,
            assertOwnedVp8AdditionalMemoryBytes: assertMemoryBudget,
            onEncodingComplete: recordCompletedFrameCounts,
            profileOperation,
            profileCopyPath,
            maxFrames: request.maxFrames,
            maxOutputBytes: request.maxOutputBytes,
            onFrameDecoded: decodeProgressCb,
            onFrameEncoded: encodedProgressCb,
          },
          // Record encoder and mux frame counts through onEncodingComplete.
          // Progress alone can report a mux count after presentation holds are split.
          () => undefined,
          signal
        );
        output = toExactOutputBuffer(webpResult);
      }
    }

    transcodeSpan?.end({
      ...observedCounts,
      outputBytes: output?.byteLength ?? 0,
    });

    // ── Finalization bookkeeping (UI progress remains "assembling") ──
    const finalizationSpan = profiler?.begin('finalizing');
    globalBufferPool.clear();

    // Guard: ensure output was produced (M10 fix).
    if (!output) {
      throw new Error('Worker pipeline completed without producing output');
    }

    postProgress('assembling', true, output.byteLength);

    finalizationSpan?.end();
    const profile = profiler?.finish();

    return { outputBuffer: output, ...(profile ? { profile } : {}) };
  } finally {
    demuxSession?.dispose?.();
    // Ensure buffer pool is cleared on any error path (matching main thread)
    clearCanvasCache();
    globalBufferPool.clear();
  }
}
