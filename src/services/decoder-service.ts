// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Common VideoDecoder pipeline for GIF and WebP encoders.
 *
 * Extracts RGB frames from demuxed video chunks using VideoDecoder,
 * with hardware acceleration support, frame decimation, and abort handling.
 *
 * Supports two modes:
 * 1. Batch mode (WebP): collects all frames into an array (existing behavior)
 * 2. Streaming mode (GIF): calls onFrameAvailable per frame for immediate encoding
 *
 * Both encoders share the same demux output and frame extraction logic;
 * only the encoding step (gifenc vs wasm-webp) differs.
 */

import { getErrorMessage } from '@piesp/browser-core/error';
import { LruMap } from '@piesp/browser-core/util';
import type { SmartFrameSkipMode } from '@t/conversion-types';
import {
  DEFAULT_FPS,
  FPS_CLAMP_MAX,
  FRAME_PIPELINE_MEMORY_BUDGET_BYTES,
  MAX_DECODE_INPUT_CHUNKS,
  MAX_FRAME_PIXEL_COUNT,
  MIN_OUTPUT_FPS,
} from '@utils/constants';
import { logger } from '@utils/logger';
import {
  ADAPTIVE_NOISE_SAMPLE_COUNT,
  type AdaptiveMotionClass,
  calculateAdaptiveDecimation,
  calculateAdaptiveNoiseFloor,
  classifyAdaptiveMotion,
  isSignificantMotionIncrease,
  shouldSkipAdaptiveFrame,
} from './adaptive-frame-skip';
import { globalBufferPool } from './buffer-pool';
import { type DemuxResult, getEncodedChunkRetainedBytes } from './demuxer-service';
import {
  calculateFrameOutputConcurrency,
  calculateStagedFrameSourceCapacity,
  estimateActiveFrameBytes,
  estimateRuntimeDecodedSourceFrameBytes,
} from './frame-memory';
import {
  compute8x8Grayscale,
  computeMAD,
  copyFrameToRGB,
  createFrameProcessingContext,
  type FrameProcessingContext,
  getFrameDurationMs,
  getSkipThreshold,
} from './frame-utils';

export interface DecodeOptions {
  width: number;
  height: number;
  /** Frame decimation: keep every Nth frame (1 = keep all) */
  frameDecimation?: number | undefined;
  /** Hardware acceleration policy */
  hwAccel?: ('prefer-hardware' | 'prefer-software') | undefined;
  /** Callback fired after each frame is decoded (for progress tracking) */
  onFrameDecoded?: ((frameIndex: number, totalFrames: number) => void) | undefined;
  /**
   * Streaming callback: fired for each decoded frame with RGB data.
   * When provided, frames are NOT accumulated into an array — instead they
   * are passed to this callback for immediate processing (e.g. encoding).
   * The callback receives ownership of the RGB buffer (must release to pool).
   */
  onFrameAvailable?:
    | ((rgbData: Uint8Array, durationMs: number, frameNum: number) => Promise<void> | void)
    | undefined;
  /**
   * GPU-only callback: passes raw VideoFrame to encoder without reading
   * pixels into JS memory. Used by VP8 VideoEncoder path for zero-copy
   * GPU encoding. When provided, smart frame skip and adaptive mode are
   * disabled (dHash requires RGB pixel data).
   * The caller OWNS the VideoFrame and MUST call frame.close().
   */
  onVideoFrameAvailable?:
    | ((frame: VideoFrame, durationMs: number, frameNum: number) => Promise<void> | void)
    | undefined;
  /**
   * Explicit decode mode. When 'stream', frames are passed to onFrameAvailable
   * immediately. When 'batch', frames are collected into an array.
   * @default 'stream' when onFrameAvailable is provided, 'batch' otherwise
   */
  mode?: ('stream' | 'batch') | undefined;
  /**
   * Smart frame skip mode — enables similarity-based frame deduplication.
   * When enabled, consecutive similar frames are skipped and their durations
   * are accumulated into the next kept frame.
   * @default 'off'
   */
  smartFrameSkip?: SmartFrameSkipMode | undefined;
  /**
   * Signals a downstream processing failure (for example, an asynchronous
   * encoder worker rejection) so decoding can stop before pulling more chunks.
   * The signal reason should be the original Error.
   */
  processingFailureSignal?: AbortSignal | undefined;
  /** Allow one ordered RGB copy to overlap a slow downstream delivery. */
  stagedCopyLookahead?: boolean | undefined;
  /** Testable lower ceiling; production callers cannot raise the hard packet-work limit. */
  maxInputChunks?: number | undefined;
}

export interface DecodedFrame {
  /** RGB pixel data, length = width * height * 3 */
  data: Uint8Array;
  /** Frame display duration in milliseconds */
  duration: number;
}

export interface DecodeResult {
  frames: DecodedFrame[];
  totalInputFrames: number;
  /** Frames skipped by the fixed frame-decimation ratio. */
  skippedByDecimation: number;
  /** Frames skipped by similarity-based or adaptive smart frame skipping. */
  smartSkipped: number;
  /** Total source duration in milliseconds (from demux chunk durations) */
  sourceTotalMs: number;
  /** Total output duration in milliseconds (sum of all frame durations) */
  outputTotalMs: number;
  /**
   * Remaining accumulated duration after the last kept frame.
   * Only meaningful in streaming mode — batch mode already adds
   * this to the last frame (see !streaming branch below).
   * In streaming mode, frames skipped after the last kept frame
   * have their durations accumulated but never consumed, causing
   * the output to play faster than the source. Encoders should
   * add this tail duration to the output (e.g., as extra delay
   * on the last frame).
   */
  tailAccumulatedMs: number;
}

/**
 * Decode demuxed video chunks to RGB frames.
 *
 * Pipeline:
 *   1. Configure VideoDecoder (hwAccel with software fallback)
 *   2. Pull chunks from DemuxResult only as decoder/output capacity becomes available
 *   3. Per-frame: copyTo RGB → optional filter → accumulate skipped durations
 *   4a. Batch mode: collect into frames array
 *   4b. Stream mode: call onFrameAvailable callback per frame
 */
export async function decodeFrames(
  demux: DemuxResult,
  opts: DecodeOptions,
  signal?: AbortSignal
): Promise<DecodeResult> {
  const {
    width,
    height,
    frameDecimation = 1,
    hwAccel = 'prefer-software',
    onFrameDecoded,
    onFrameAvailable,
    onVideoFrameAvailable,
    mode,
    smartFrameSkip: effectiveSmartSkip = 'off',
    processingFailureSignal,
    stagedCopyLookahead = false,
    maxInputChunks,
  } = opts;
  const requestedInputChunkLimit = maxInputChunks;
  const inputChunkLimit =
    typeof requestedInputChunkLimit === 'number' &&
    Number.isSafeInteger(requestedInputChunkLimit) &&
    requestedInputChunkLimit > 0
      ? Math.min(requestedInputChunkLimit, MAX_DECODE_INPUT_CHUNKS)
      : MAX_DECODE_INPUT_CHUNKS;

  // ── Smart frame skip state (must be before parallel decode block) ──
  const skipThreshold = getSkipThreshold(effectiveSmartSkip);

  // Determine streaming mode: explicit 'stream' mode or infer from callback
  const streaming =
    mode === 'stream' ||
    (mode !== 'batch' &&
      (typeof onFrameAvailable === 'function' || typeof onVideoFrameAvailable === 'function'));

  if (
    streaming &&
    typeof onFrameAvailable !== 'function' &&
    typeof onVideoFrameAvailable !== 'function'
  ) {
    throw new Error('Streaming decode requires an onFrameAvailable callback');
  }
  const frameAvailable = onFrameAvailable;

  // Warn if onFrameAvailable is provided but mode is explicitly 'batch'
  if (mode === 'batch' && typeof onFrameAvailable === 'function') {
    logger.warn(
      'decoders',
      'onFrameAvailable provided but mode is "batch" — streaming callback will be ignored',
      {
        mode,
      }
    );
  }
  const rgbFrames: DecodedFrame[] = streaming ? [] : []; // Only used in batch mode
  const pendingConversions = new Set<Promise<void>>();

  // ── Parallel decode temporarily disabled (Phase 1: fix infinite loop in pendingConversions) ──
  // See .hermes/plans/refactor-critical-high-2026-07-14.md for details.
  // Re-enable after implementing bounded ordered queue with Set-based cleanup.

  // ── Smart frame skip state (continued) ──
  const isAdaptive = skipThreshold === -2;
  const sourceFps =
    Number.isFinite(demux.framerate) && demux.framerate > 0
      ? Math.min(demux.framerate, FPS_CLAMP_MAX)
      : DEFAULT_FPS;
  const fallbackFrameDurationMs = 1000 / sourceFps;
  let prevGray: Uint8Array | null = null;
  let consecutiveSkipMs = 0; // accumulated duration of skipped frames

  // ── Backpressure for pendingConversions (RES-H2) ──
  const hasConfiguredSourceDimensions =
    Number.isSafeInteger(demux.config.codedWidth) &&
    Number.isSafeInteger(demux.config.codedHeight) &&
    (demux.config.codedWidth ?? 0) > 0 &&
    (demux.config.codedHeight ?? 0) > 0;
  const configuredSourceWidth = hasConfiguredSourceDimensions
    ? (demux.config.codedWidth ?? width)
    : width;
  const configuredSourceHeight = hasConfiguredSourceDimensions
    ? (demux.config.codedHeight ?? height)
    : height;
  const configuredDisplayWidth =
    Number.isSafeInteger(demux.config.displayAspectWidth) &&
    (demux.config.displayAspectWidth ?? 0) > 0
      ? (demux.config.displayAspectWidth ?? configuredSourceWidth)
      : configuredSourceWidth;
  const configuredDisplayHeight =
    Number.isSafeInteger(demux.config.displayAspectHeight) &&
    (demux.config.displayAspectHeight ?? 0) > 0
      ? (demux.config.displayAspectHeight ?? configuredSourceHeight)
      : configuredSourceHeight;
  const usesStagedCpuStreaming = streaming && typeof onVideoFrameAvailable !== 'function';
  const MAX_DECODE_QUEUE = 8;
  const queuedSourceHeadroomCount = MAX_DECODE_QUEUE + 1;
  const maxPendingConversions = usesStagedCpuStreaming
    ? calculateStagedFrameSourceCapacity(
        configuredSourceWidth,
        configuredSourceHeight,
        configuredDisplayWidth,
        configuredDisplayHeight,
        width,
        height,
        10
      )
    : calculateFrameOutputConcurrency(
        configuredSourceWidth,
        configuredSourceHeight,
        width,
        height,
        10
      );
  if (maxPendingConversions === 0) {
    throw new Error(
      'Decoded frame output memory limit exceeded (single frame exceeds byte budget)'
    );
  }
  const outputOwnershipRequestedMaximum = Number.MAX_SAFE_INTEGER;
  const targetWorkingBytes = usesStagedCpuStreaming ? estimateActiveFrameBytes(width, height) : 0;
  const queuedSourceHeadroomBytes = usesStagedCpuStreaming
    ? estimateRuntimeDecodedSourceFrameBytes(
        configuredSourceWidth,
        configuredSourceHeight,
        configuredDisplayWidth,
        configuredDisplayHeight,
        null
      ) * queuedSourceHeadroomCount
    : 0;
  const twoTargetSourceCapacity = usesStagedCpuStreaming
    ? calculateStagedFrameSourceCapacity(
        configuredSourceWidth,
        configuredSourceHeight,
        configuredDisplayWidth,
        configuredDisplayHeight,
        width,
        height,
        Number.MAX_SAFE_INTEGER,
        2
      )
    : 0;
  let stagedLookaheadEnabled =
    stagedCopyLookahead && twoTargetSourceCapacity >= queuedSourceHeadroomCount;
  let retainedSourceFrameBytes = 0;
  let activeStagedTargetSlots = 0;
  let stagedTargetGateClosed = false;
  const stagedTargetWaiters: Array<{
    slotLimit: 1 | 2;
    resolve: (acquired: boolean) => void;
  }> = [];
  let activeOutputSlots = 0;

  const canAcquireStagedTarget = (slotLimit: 1 | 2): boolean =>
    usesStagedCpuStreaming &&
    !stagedTargetGateClosed &&
    activeStagedTargetSlots < slotLimit &&
    Math.max(
      retainedSourceFrameBytes,
      slotLimit === 2 && activeStagedTargetSlots === 1 ? queuedSourceHeadroomBytes : 0
    ) +
      (activeStagedTargetSlots + 1) * targetWorkingBytes <=
      FRAME_PIPELINE_MEMORY_BUDGET_BYTES;

  const drainStagedTargetWaiters = (): void => {
    while (stagedTargetWaiters.length > 0) {
      const waiter = stagedTargetWaiters[0];
      if (!waiter || !canAcquireStagedTarget(waiter.slotLimit)) return;
      stagedTargetWaiters.shift();
      activeStagedTargetSlots++;
      waiter.resolve(true);
    }
  };

  const acquireStagedTarget = async (slotLimit: 1 | 2): Promise<boolean> => {
    if (!usesStagedCpuStreaming || stagedTargetGateClosed) return false;
    if (canAcquireStagedTarget(slotLimit)) {
      activeStagedTargetSlots++;
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      stagedTargetWaiters.push({ resolve, slotLimit });
    });
  };

  const releaseStagedTarget = (): void => {
    activeStagedTargetSlots = Math.max(0, activeStagedTargetSlots - 1);
    drainStagedTargetWaiters();
  };

  const closeStagedTargetGate = (): void => {
    stagedTargetGateClosed = true;
    for (const waiter of stagedTargetWaiters.splice(0)) waiter.resolve(false);
  };

  const releaseOutputSlot = (): void => {
    activeOutputSlots = Math.max(0, activeOutputSlots - 1);
  };

  let decodeError: Error | null = null;
  let discardStagedOutputs = false;
  let firstConversionError: Error | null = null;
  let firstPipelineFailure: {
    error: Error;
    origin: 'cancellation' | 'decoder' | 'processing';
  } | null = null;
  let cancellationObserved = false;
  let conversionErrorCount = 0;
  const encodedChunkReservations = new Map<number, EncodedChunkReservation[]>();
  const encodedChunkBudgetBytes = demux.encodedChunkBudgetBytes;
  let retainedEncodedChunkBytes = 0;
  let inputFrameCount = 0;
  let inputChunkCount = 0;
  let keptFrameCount = 0;
  let accumulatedDuration = 0;
  let skippedByDecimation = 0;
  let smartSkippedCount = 0;
  // Noise floor estimation: collect frame diff stdDev from first N frames
  const noiseFloorSamples: number[] = [];
  let noiseFloor = 0; // will be set after sampling phase

  // ── Adaptive motion-classified decimation state ──
  // Running window of motion distances for scene analysis
  let adaptFrameCounter = 0;
  let lastAdaptiveKeptFrame = Number.NEGATIVE_INFINITY;
  const requestedDecimation =
    Number.isFinite(frameDecimation) && frameDecimation > 0
      ? Math.max(1, Math.round(frameDecimation))
      : 1;
  const canRunAdaptiveAnalysis =
    isAdaptive && streaming && typeof onVideoFrameAvailable !== 'function';
  const maxAdaptiveDecimation = Math.max(1, Math.floor(sourceFps / MIN_OUTPUT_FPS));
  let adaptLastMotionClass: AdaptiveMotionClass = 'normal';

  const normalizeFailure = (error: unknown): Error =>
    error instanceof Error || error instanceof DOMException
      ? error
      : new Error(getErrorMessage(error));

  const recordDecoderError = (error: unknown): void => {
    const normalized = normalizeFailure(error);
    decodeError ??= normalized;
    discardStagedOutputs = true;
    closeStagedTargetGate();
    firstPipelineFailure ??= { error: normalized, origin: 'decoder' };
  };

  const recordCancellation = (): void => {
    cancellationObserved = true;
    discardStagedOutputs = true;
    closeStagedTargetGate();
    firstPipelineFailure ??= {
      error: new DOMException('Cancelled', 'AbortError'),
      origin: 'cancellation',
    };
  };

  const recordConversionError = (error: unknown): void => {
    conversionErrorCount++;
    const normalized = normalizeFailure(error);
    firstConversionError ??= normalized;
    closeStagedTargetGate();
    firstPipelineFailure ??= { error: normalized, origin: 'processing' };
  };

  const hasProcessingFailure = (): boolean => {
    if (processingFailureSignal?.aborted && !firstConversionError) {
      recordConversionError(processingFailureSignal.reason);
    }
    return firstConversionError !== null;
  };

  const handleProcessingFailure = (): void => {
    recordConversionError(processingFailureSignal?.reason);
  };
  const handleCancellation = (): void => {
    recordCancellation();
  };
  let decoder: VideoDecoder | null = null;
  let chunkStream: AsyncGenerator<EncodedVideoChunk> | null = null;
  let demuxDisposed = false;
  let failureListenersRemoved = false;
  const getLatchedFailureError = (): Error | null => {
    const pipelineFailure = firstPipelineFailure as {
      error: Error;
      origin: 'cancellation' | 'decoder' | 'processing';
    } | null;
    if (pipelineFailure?.origin === 'processing') {
      logger.error('decoders', 'Frame conversion errors detected', {
        errorCount: conversionErrorCount,
        firstError: pipelineFailure.error.message,
      });
      return new Error(`Frame processing failed: ${pipelineFailure.error.message}`, {
        cause: pipelineFailure.error,
      });
    }
    return pipelineFailure?.error ?? null;
  };
  const cleanupDecoderLifecycle = async (primaryFailure: Error | null): Promise<Error | null> => {
    let cleanupFailure: Error | null = null;
    const captureCleanupFailure = (error: unknown): void => {
      cleanupFailure ??= normalizeFailure(error);
    };

    if (!failureListenersRemoved) {
      failureListenersRemoved = true;
      try {
        processingFailureSignal?.removeEventListener('abort', handleProcessingFailure);
      } catch (error) {
        captureCleanupFailure(error);
      }
      try {
        signal?.removeEventListener('abort', handleCancellation);
      } catch (error) {
        captureCleanupFailure(error);
      }
    }

    const activeChunkStream = chunkStream;
    chunkStream = null;
    if (activeChunkStream) {
      try {
        await activeChunkStream.return(undefined);
      } catch (error) {
        captureCleanupFailure(error);
      }
    }

    if (!demuxDisposed) {
      demuxDisposed = true;
      try {
        demux.dispose?.();
      } catch (error) {
        captureCleanupFailure(error);
      }
    }

    await Promise.allSettled([...pendingConversions]);

    const activeDecoder = decoder;
    decoder = null;
    if (activeDecoder) {
      try {
        if (activeDecoder.state !== 'closed') activeDecoder.close();
      } catch (error) {
        captureCleanupFailure(error);
      }
    }

    return primaryFailure ?? cleanupFailure;
  };

  if (processingFailureSignal?.aborted) {
    handleProcessingFailure();
  } else {
    processingFailureSignal?.addEventListener('abort', handleProcessingFailure, { once: true });
  }
  if (signal?.aborted) {
    handleCancellation();
  } else {
    signal?.addEventListener('abort', handleCancellation, { once: true });
  }

  // Check codec support (cached per codec+hw combo)
  let activeConfig: VideoDecoderConfig;
  try {
    activeConfig = await resolveDecoderConfig(demux.config, hwAccel);
  } catch (error) {
    recordDecoderError(error);
    const primaryFailure = getLatchedFailureError() ?? normalizeFailure(error);
    throw (await cleanupDecoderLifecycle(primaryFailure)) ?? primaryFailure;
  }

  // Create per-conversion frame processing context (duration carry + copy path cache)
  const frameCtx: FrameProcessingContext = createFrameProcessingContext();

  // Presentation decisions and encoder delivery remain ordered. WebP callers
  // may opt into one staged copy lookahead, bounded separately below.
  let orderedProcessingTail: Promise<void> = Promise.resolve();
  let stagedCopyTail: Promise<void> = Promise.resolve();

  logger.info('decoders', 'VideoDecoder configured', {
    codec: demux.config.codec,
    hwAccel: activeConfig.hardwareAcceleration,
    resolution: `${width}×${height}`,
    totalFrames: demux.totalFrames,
    frameDecimation,
    streaming,
  });

  interface EncodedChunkReservation {
    bytes: number;
    released: boolean;
    timestamp: number;
  }

  const releaseEncodedChunk = (reservation: EncodedChunkReservation): void => {
    if (reservation.released) return;
    reservation.released = true;
    retainedEncodedChunkBytes = Math.max(0, retainedEncodedChunkBytes - reservation.bytes);

    const timestampReservations = encodedChunkReservations.get(reservation.timestamp);
    if (!timestampReservations) return;
    const index = timestampReservations.indexOf(reservation);
    if (index >= 0) timestampReservations.splice(index, 1);
    if (timestampReservations.length === 0) {
      encodedChunkReservations.delete(reservation.timestamp);
    }
  };

  const releaseEncodedChunkForOutput = (timestamp: number): void => {
    const timestampReservations = encodedChunkReservations.get(timestamp);
    let reservation = timestampReservations?.[0];
    if (timestampReservations && reservation) {
      // Duplicate presentation timestamps do not identify which encoded input produced
      // this output. Release only the smallest candidate so retained bytes never fall
      // below the worst-case amount still owned by the codec.
      for (const candidate of timestampReservations) {
        if (candidate.bytes < reservation.bytes) reservation = candidate;
      }
    }
    if (reservation) releaseEncodedChunk(reservation);
  };

  const hasSafeFrameDimensions = (frame: VideoFrame): boolean => {
    const dimensions = [
      [frame.codedWidth, frame.codedHeight],
      [frame.displayWidth, frame.displayHeight],
    ] as const;
    return dimensions.every(
      ([frameWidth, frameHeight]) =>
        Number.isSafeInteger(frameWidth) &&
        Number.isSafeInteger(frameHeight) &&
        frameWidth > 0 &&
        frameHeight > 0 &&
        frameWidth <= MAX_FRAME_PIXEL_COUNT / frameHeight
    );
  };

  const reserveEncodedChunk = (chunk: EncodedVideoChunk): EncodedChunkReservation => {
    const bytes = getEncodedChunkRetainedBytes(chunk);
    if (
      encodedChunkBudgetBytes !== undefined &&
      retainedEncodedChunkBytes + bytes > encodedChunkBudgetBytes
    ) {
      throw new Error(
        `Demux memory limit exceeded while queueing encoded packets (${encodedChunkBudgetBytes} byte budget)`
      );
    }

    const reservation: EncodedChunkReservation = {
      bytes,
      released: false,
      timestamp: chunk.timestamp,
    };
    const timestampReservations = encodedChunkReservations.get(chunk.timestamp);
    if (timestampReservations) {
      timestampReservations.push(reservation);
    } else {
      encodedChunkReservations.set(chunk.timestamp, [reservation]);
    }
    retainedEncodedChunkBytes += bytes;
    return reservation;
  };

  const decoderInit: VideoDecoderInit = {
    output(frame: VideoFrame) {
      try {
        releaseEncodedChunkForOutput(frame.timestamp);
        if (!hasSafeFrameDimensions(frame)) {
          recordDecoderError(
            new Error('Decoded frame dimensions exceed the per-frame memory limit')
          );
          frame.close();
          return;
        }
        if (decodeError || hasProcessingFailure()) {
          frame.close();
          return;
        }
        if ((demux.trimStartUs ?? 0) > 0 && frame.timestamp < (demux.trimStartUs ?? 0)) {
          frame.close();
          return;
        }
        const { durationMs: frameDuration, ctx: nextFrameCtx } = getFrameDurationMs(
          frame,
          frameCtx,
          fallbackFrameDurationMs
        );
        // Mutable update — avoid Object.assign spread allocation per frame
        frameCtx.durationCarryUs = nextFrameCtx.durationCarryUs;
        frameCtx.copyPath = nextFrameCtx.copyPath;
        const frameNum = inputFrameCount++;

        // Frame decimation: skip every Nth frame
        if (
          !canRunAdaptiveAnalysis &&
          requestedDecimation > 1 &&
          frameNum % requestedDecimation !== 0
        ) {
          accumulatedDuration += frameDuration;
          frame.close();
          skippedByDecimation++;
          return;
        }

        let sourceReservationBytes = 0;
        let sourceReservationActive = false;
        let outputSlotActive = false;
        if (usesStagedCpuStreaming) {
          try {
            let runtimeAllocationBytes: number | null = null;
            if (frame.format != null && typeof frame.allocationSize === 'function') {
              try {
                runtimeAllocationBytes = frame.allocationSize();
              } catch {
                // Unknown runtime layout uses the conservative 8-Bpp fallback below.
              }
            }
            sourceReservationBytes = estimateRuntimeDecodedSourceFrameBytes(
              frame.codedWidth,
              frame.codedHeight,
              frame.displayWidth,
              frame.displayHeight,
              runtimeAllocationBytes
            );
          } catch (error) {
            recordDecoderError(error);
            frame.close();
            return;
          }
          if (
            retainedSourceFrameBytes +
              sourceReservationBytes +
              Math.max(activeStagedTargetSlots, 1) * targetWorkingBytes >
            FRAME_PIPELINE_MEMORY_BUDGET_BYTES
          ) {
            const maxSourceFrames = Math.floor(
              (FRAME_PIPELINE_MEMORY_BUDGET_BYTES -
                Math.max(activeStagedTargetSlots, 1) * targetWorkingBytes) /
                sourceReservationBytes
            );
            recordDecoderError(
              new Error(
                `Decoded frame output memory limit exceeded (${maxSourceFrames} source frame limit)`
              )
            );
            frame.close();
            return;
          }
          retainedSourceFrameBytes += sourceReservationBytes;
          sourceReservationActive = true;
        } else {
          const maxOutputSlots = Math.min(
            calculateFrameOutputConcurrency(
              frame.codedWidth,
              frame.codedHeight,
              width,
              height,
              outputOwnershipRequestedMaximum
            ),
            calculateFrameOutputConcurrency(
              frame.displayWidth,
              frame.displayHeight,
              width,
              height,
              outputOwnershipRequestedMaximum
            )
          );
          if (activeOutputSlots >= maxOutputSlots) {
            recordDecoderError(
              new Error(
                `Decoded frame output memory limit exceeded (${maxOutputSlots} frame slot limit)`
              )
            );
            frame.close();
            return;
          }
          activeOutputSlots++;
          outputSlotActive = true;
        }

        const totalDuration = frameDuration + accumulatedDuration;
        accumulatedDuration = 0;

        // Carry-over from smart frame skip: when consecutive similar frames
        // are skipped, their durations are accumulated in consecutiveSkipMs.
        // When a frame is finally kept, those accumulated durations must be
        // added to totalDuration to preserve total playback time.
        // Without this, smart-skipped frame durations are permanently lost.
        let smartCarryoverMs = 0;

        const previousProcessing = orderedProcessingTail;
        let releaseProcessing!: () => void;
        orderedProcessingTail = new Promise<void>((resolve) => {
          releaseProcessing = resolve;
        });
        const previousStagedCopy = stagedCopyTail;
        const stagedTargetSlotLimit: 1 | 2 = stagedLookaheadEnabled ? 2 : 1;
        let resolveStagedCopy!: () => void;
        if (usesStagedCpuStreaming) {
          stagedCopyTail = new Promise<void>((resolve) => {
            resolveStagedCopy = resolve;
          });
        }

        const conversion = (async () => {
          let enteredOrderedProcessing = false;
          let sourceFrameClosed = false;
          let sourceFrameTransferred = false;
          let stagedTargetActive = false;
          let stagedCopyReleased = false;
          const releaseStagedCopy = (): void => {
            if (!usesStagedCpuStreaming || stagedCopyReleased) return;
            stagedCopyReleased = true;
            resolveStagedCopy();
          };
          const releaseSourceReservation = (): void => {
            if (!sourceReservationActive) return;
            sourceReservationActive = false;
            retainedSourceFrameBytes = Math.max(
              0,
              retainedSourceFrameBytes - sourceReservationBytes
            );
            drainStagedTargetWaiters();
          };
          const closeSourceFrame = (): void => {
            if (sourceFrameClosed) return;
            sourceFrameClosed = true;
            frame.close();
          };
          try {
            // ── GPU-only path: pass VideoFrame directly to encoder ──
            // Skips copyFrameToRGB (GPU→CPU read) and all grayscale-based processing.
            // Used by VP8 VideoEncoder path for zero-copy GPU encoding.
            // Smart frame skip and adaptive mode are disabled (require RGB data).
            if (typeof onVideoFrameAvailable === 'function') {
              await previousProcessing;
              enteredOrderedProcessing = true;
              if (signal?.aborted || decodeError || hasProcessingFailure()) return;
              // Transfer accumulated frame durations (decimation + smart skip carryover)
              const totalDur = totalDuration + smartCarryoverMs;
              smartCarryoverMs = 0;
              keptFrameCount++;
              sourceFrameTransferred = true;
              await onVideoFrameAvailable(frame, totalDur, frameNum);
              // Caller owns frame and MUST call frame.close()
              return;
            }

            if (usesStagedCpuStreaming) {
              await previousStagedCopy;
              if (signal?.aborted || discardStagedOutputs || hasProcessingFailure()) return;
              stagedTargetActive = await acquireStagedTarget(stagedTargetSlotLimit);
              if (
                !stagedTargetActive ||
                signal?.aborted ||
                discardStagedOutputs ||
                hasProcessingFailure()
              ) {
                return;
              }
            } else if (signal?.aborted || hasProcessingFailure()) {
              return;
            }

            let rgbData: Uint8Array;
            try {
              rgbData = await copyFrameToRGB(frame, width, height, frameCtx);
            } finally {
              if (usesStagedCpuStreaming) {
                closeSourceFrame();
                releaseSourceReservation();
              }
            }
            await previousProcessing;
            enteredOrderedProcessing = true;
            if (signal?.aborted || discardStagedOutputs || hasProcessingFailure()) {
              globalBufferPool.release(rgbData);
              return;
            }

            const shouldMeasureMotion = streaming && (skipThreshold >= 0 || isAdaptive);
            const gray = shouldMeasureMotion ? compute8x8Grayscale(rgbData, width, height) : null;
            const frameDistance =
              gray !== null && prevGray !== null ? computeMAD(gray, prevGray) : null;

            if (frameDistance !== null && noiseFloorSamples.length < ADAPTIVE_NOISE_SAMPLE_COUNT) {
              noiseFloorSamples.push(frameDistance);
              if (noiseFloorSamples.length === ADAPTIVE_NOISE_SAMPLE_COUNT) {
                noiseFloor = calculateAdaptiveNoiseFloor(noiseFloorSamples);
              }
            }

            // ── Smart frame skip: similarity-based deduplication ──
            if (streaming && skipThreshold >= 0 && gray !== null) {
              if (frameDistance !== null) {
                // Skip if similar AND consecutive skip time < 500ms
                // Use max of user threshold and noise-adapted floor
                const effectiveThreshold = Math.max(skipThreshold, noiseFloor);
                if (frameDistance <= effectiveThreshold && consecutiveSkipMs < 500) {
                  // Skip this frame: accumulate duration, release buffer, return
                  consecutiveSkipMs += totalDuration;
                  smartSkippedCount++;
                  globalBufferPool.release(rgbData);
                  return;
                }
              }

              prevGray = gray;
              // Transfer accumulated consecutive skip durations to this frame
              smartCarryoverMs = consecutiveSkipMs;
              consecutiveSkipMs = 0;
            }

            // ── Adaptive motion-classified decimation ──
            // Instead of fixed decimation, classify each frame's motion level
            // and apply variable decimation: static scenes get aggressive skip,
            // while fast motion uses the preset/memory decimation floor. Uses 8×8
            // grayscale + MAD for comparison.
            //
            // NOTE: This block is NEVER entered when onVideoFrameAvailable is active
            // (GPU-only path) because that path skips copyFrameToRGB entirely, meaning
            // no rgbData/grayscale/MAD is available. See the GPU-only early return
            // earlier in this function (onVideoFrameAvailable check).
            //
            // NOTE: The first frame is always classified as adaptLastMotionClass
            // (initially 'normal') because prevGray is null until at least two frames
            // have been processed. This initial misclassification is expected and has
            // negligible impact — only one frame's decimation is affected.
            if (canRunAdaptiveAnalysis && gray !== null) {
              let motionClass: AdaptiveMotionClass = adaptLastMotionClass;

              if (
                frameDistance !== null &&
                noiseFloorSamples.length >= ADAPTIVE_NOISE_SAMPLE_COUNT
              ) {
                // Classify motion level using noise-floor-adapted thresholds.
                // Lower-noise videos get tighter thresholds (more aggressive skip),
                // noisier videos get wider thresholds (conservative skip).
                motionClass = classifyAdaptiveMotion(frameDistance, noiseFloor);

                // Scene change detection: align the adaptive cadence so the new
                // scene remains visible, but never reset it before the requested
                // preset or memory floor allows another frame.
                if (
                  isSignificantMotionIncrease(motionClass, adaptLastMotionClass) &&
                  frameNum - lastAdaptiveKeptFrame >= requestedDecimation
                ) {
                  adaptFrameCounter = 0; // force keep on significant motion increase
                }
                adaptLastMotionClass = motionClass;
              }

              prevGray = gray;

              const decimation = calculateAdaptiveDecimation(
                motionClass,
                requestedDecimation,
                maxAdaptiveDecimation
              );
              const shouldSkip = shouldSkipAdaptiveFrame({
                frameNum,
                lastKeptFrame: lastAdaptiveKeptFrame,
                requestedDecimation,
                frameCounter: adaptFrameCounter,
                decimation,
                consecutiveSkipMs,
              });

              adaptFrameCounter++;

              if (shouldSkip) {
                consecutiveSkipMs += totalDuration;
                smartSkippedCount++;
                globalBufferPool.release(rgbData);
                return;
              }

              // Frame kept: reset counters, transfer accumulated duration
              lastAdaptiveKeptFrame = frameNum;
              smartCarryoverMs = consecutiveSkipMs;
              consecutiveSkipMs = 0;
            }

            if (streaming) {
              // Streaming mode: pass frame to callback for immediate processing.
              // Include smart-skip carryover to preserve total playback time.
              keptFrameCount++;
              if (!frameAvailable) {
                throw new Error('Streaming decode requires an onFrameAvailable callback');
              }
              let delivery: Promise<void> | void;
              try {
                delivery = frameAvailable(rgbData, totalDuration + smartCarryoverMs, frameNum);
              } finally {
                releaseStagedCopy();
              }
              await delivery;
              smartCarryoverMs = 0;
              // Note: onFrameAvailable is responsible for releasing rgbData
            } else {
              // Batch mode: collect into array (existing behavior for WebP)
              rgbFrames.push({ data: rgbData, duration: totalDuration });
            }

            // Report decoding progress — throttle to every 10 frames.
            // The modulo check has negligible overhead (~1ns per frame) and
            // avoids excessive callback invocations that would flood the
            // progress store and trigger unnecessary SolidJS re-renders.
            // At 60fps source, this fires ~6 times/second — smooth enough
            // for the UI progress bar without overwhelming the reactive system.
            if (
              onFrameDecoded &&
              (streaming
                ? inputFrameCount % 10 === 0
                : rgbFrames.length % 10 === 0 || rgbFrames.length === 1)
            ) {
              onFrameDecoded(streaming ? keptFrameCount : rgbFrames.length, demux.totalFrames);
            }
          } catch (error) {
            recordConversionError(error);
          } finally {
            if (!enteredOrderedProcessing) {
              await previousProcessing;
            }
            releaseStagedCopy();
            if (stagedTargetActive) releaseStagedTarget();
            releaseProcessing();
            releaseSourceReservation();
            if (outputSlotActive) releaseOutputSlot();
            if (!sourceFrameTransferred) closeSourceFrame();
          }
        })();

        // Track pending conversion for backpressure and final flush.
        // Use a self-cleaning Set: each promise removes itself on completion,
        // so pendingConversions.size always reflects actual in-flight work.
        // The inner catch records errors before releasing the ordered turn;
        // this outer catch is a final guard for cleanup-path failures.
        conversion
          .catch((err: unknown) => {
            recordConversionError(err);
          })
          .finally(() => {
            pendingConversions.delete(conversion);
          });
        pendingConversions.add(conversion);
      } catch (err) {
        // Ensure frame is always closed if error occurs before async IIFE
        frame.close();
        throw err;
      }
    },
    error(e: Error) {
      logger.warn('decoders', 'decoder-error', {
        codec: demux.config.codec,
        error: e.message,
      });
      recordDecoderError(e);
    },
  };

  try {
    decoder = new VideoDecoder(decoderInit);
    decoder.configure(activeConfig);
  } catch (error) {
    recordDecoderError(error);
    const primaryFailure = getLatchedFailureError() ?? normalizeFailure(error);
    throw (await cleanupDecoderLifecycle(primaryFailure)) ?? primaryFailure;
  }
  const activeDecoder = decoder;

  let streamedSourceDurationUs = 0;
  chunkStream = (async function* iterateChunks(): AsyncGenerator<EncodedVideoChunk> {
    yield* demux.chunks;
  })();
  const activeChunkStream = chunkStream;
  let primaryFailure: Error | null = null;
  let decodeResult: DecodeResult | null = null;

  try {
    // Pull and feed chunks with backpressure — prevent both MediaBunny and the
    // VideoDecoder queue from growing unbounded. Backpressure is checked before
    // requesting the next chunk, so the producer cannot run ahead.
    // VideoDecoder internally queues decoded frames; if we feed chunks faster than
    // they can be decoded, memory grows and GC pressure increases.
    // We pause when queue size exceeds a threshold and resume when it drains.
    while (true) {
      if (signal?.aborted) {
        recordCancellation();
        break;
      }
      if (decodeError || hasProcessingFailure()) break;

      // Backpressure: wait if decode queue is full.
      // Use setTimeout(0) as primary yield mechanism because
      // requestAnimationFrame pauses in background tabs, causing deadlock
      // when the decoder still queues frames but rAF never fires.
      while (
        activeDecoder.decodeQueueSize > MAX_DECODE_QUEUE &&
        !signal?.aborted &&
        !decodeError &&
        !hasProcessingFailure()
      ) {
        await new Promise<void>((resolve) => {
          setTimeout(() => resolve(), 0);
        });
      }

      // Backpressure on output processing (RES-H2): wait if too many
      // frame conversion promises are in flight. This prevents unbounded
      // memory growth when decoded frames accumulate faster than they
      // can be processed (e.g., copyToRGB + encoding).
      if (pendingConversions.size >= maxPendingConversions) {
        await Promise.race([...pendingConversions]);
      }

      if (signal?.aborted) {
        recordCancellation();
        break;
      }
      if (decodeError || hasProcessingFailure()) break;

      const nextChunk = await activeChunkStream.next();
      if (nextChunk.done) break;
      if (inputChunkCount >= inputChunkLimit) {
        throw new Error(`Decoder input packet limit exceeded (${inputChunkLimit} packet limit)`);
      }
      inputChunkCount++;
      if (hasProcessingFailure()) break;

      streamedSourceDurationUs += Math.max(0, nextChunk.value.duration ?? 0);

      const reservation = reserveEncodedChunk(nextChunk.value);
      try {
        activeDecoder.decode(nextChunk.value);
      } catch (error) {
        releaseEncodedChunk(reservation);
        recordDecoderError(error);
        break;
      }
    }

    // A fatal pipeline outcome makes queued codec work unusable. Reset it while
    // still draining every conversion promise below for VideoFrame cleanup.
    if (decodeError || cancellationObserved || hasProcessingFailure()) {
      try {
        activeDecoder.reset();
      } catch {
        // Preserve the failure already recorded by the shared latch.
      }
    } else {
      try {
        stagedLookaheadEnabled = false;
        await Promise.allSettled([...pendingConversions]);
        await activeDecoder.flush();
      } catch (e) {
        recordDecoderError(e);
      }
    }
    // Always await pending conversions before closing decoder to avoid VideoFrame leak.
    // Use Promise.allSettled so that even if some conversions fail (e.g., due to abort),
    // we still drain all pending work and close frames properly.
    await Promise.allSettled([...pendingConversions]);

    // Any frame or downstream encoding failure makes the output incomplete.
    // Preserve the first cause after every already-created frame is closed.
    const pipelineFailure = getLatchedFailureError();
    if (pipelineFailure) throw pipelineFailure;

    // Add any remaining accumulated duration to the last frame (batch mode only)
    if (!streaming && accumulatedDuration > 0 && rgbFrames.length > 0) {
      const last = rgbFrames[rgbFrames.length - 1];
      if (last) last.duration += accumulatedDuration;
    }

    // Compute timing summary
    const sourceTotalMs =
      streamedSourceDurationUs > 0 ? streamedSourceDurationUs / 1000 : demux.sourceTotalMs;
    // Streaming mode: encoder handles frame timing internally, so outputTotalMs is not
    // tracked here. GIF/WebP encoders compute their own timing from frame durations.
    // Non-streaming: sum of all RGB frame durations.
    const outputTotalMs = streaming ? 0 : rgbFrames.reduce((sum, f) => sum + f.duration, 0);

    logger.info('decoders', 'Decoding complete', {
      totalInputFrames: inputFrameCount,
      outputFrames: streaming ? keptFrameCount : rgbFrames.length,
      skippedByDecimation,
      smartSkipped: smartSkippedCount,
      smartSkipMode: effectiveSmartSkip,
      noiseFloor: Math.round(noiseFloor * 100) / 100,
      resolution: `${width}×${height}`,
      streaming,
    });

    decodeResult = {
      frames: rgbFrames,
      totalInputFrames: inputFrameCount,
      skippedByDecimation,
      smartSkipped: smartSkippedCount,
      sourceTotalMs,
      outputTotalMs,
      tailAccumulatedMs: streaming ? accumulatedDuration + consecutiveSkipMs : 0,
    };
  } catch (error) {
    primaryFailure = normalizeFailure(error);
  }
  const cleanupFailure = await cleanupDecoderLifecycle(primaryFailure);
  if (cleanupFailure) throw cleanupFailure;
  return decodeResult as DecodeResult;
}

// ─── Codec support cache ──────────────────────────────────────────
// isConfigSupported() is synchronous in some browsers but the spec says
// it returns a Promise. Cache results to avoid redundant calls when
// multiple conversions use the same codec.

interface CachedConfig {
  config: VideoDecoderConfig;
  hwSupported: boolean;
}

const CONFIG_CACHE_MAX_SIZE = 20;

const configCache = new LruMap<string, CachedConfig>(CONFIG_CACHE_MAX_SIZE);

function configCacheKey(cfg: VideoDecoderConfig): string {
  return `${cfg.codec}-${cfg.codedWidth}x${cfg.codedHeight}-${cfg.hardwareAcceleration ?? 'default'}`;
}

async function resolveDecoderConfig(
  baseConfig: VideoDecoderConfig,
  hwAccel: 'prefer-hardware' | 'prefer-software'
): Promise<VideoDecoderConfig> {
  const key = configCacheKey(baseConfig);
  let cached = configCache.get(key);

  if (!cached) {
    const support = await VideoDecoder.isConfigSupported(baseConfig);
    if (!support.supported) {
      throw new Error(`Unsupported codec configuration: ${baseConfig.codec}`);
    }
    // Check HW support with a HW-specific config
    const hwConfig = { ...baseConfig, hardwareAcceleration: 'prefer-hardware' as const };
    const hwSupport = await VideoDecoder.isConfigSupported(hwConfig);
    cached = { config: baseConfig, hwSupported: hwSupport.supported === true };
    configCache.set(key, cached);
  }

  if (hwAccel === 'prefer-hardware' && cached.hwSupported) {
    return { ...baseConfig, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: false };
  }
  return { ...baseConfig, hardwareAcceleration: 'prefer-software', optimizeForLatency: false };
}
