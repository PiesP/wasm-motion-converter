// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Common VideoDecoder pipeline for GIF and WebP encoders.
 *
 * Extracts RGB or opaque RGBA frames from demuxed video chunks using VideoDecoder,
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
  STALL_DETECTION_TIMEOUT_MS,
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
import type { ProfileCopyPathRecorder, ProfileOperationRecorder } from './conversion-profiler';
import { type DemuxResult, getEncodedChunkRetainedBytes } from './demuxer-service';
import {
  type CpuPixelFormat,
  calculateFrameOutputConcurrency,
  calculateStagedFrameSourceCapacity,
  estimateActiveFrameBytes,
  estimateDecodedSourceFrameBytes,
  estimateRuntimeDecodedSourceFrameBytes,
  type FrameMemoryHandoff,
  type FrameMemoryReservation,
  type WebpFrameMemoryBudget,
} from './frame-memory';
import {
  compareMotionSignatures,
  computeMotionSignature,
  copyFrameToPixels,
  createFrameProcessingContext,
  type FrameProcessingContext,
  getSkipThreshold,
  MOTION_SIGNATURE_PEAK_BYTES,
  type MotionSignature,
} from './frame-utils';
import { createPresentationSampler, type PresentationInterval } from './presentation-timing';

export type { PresentationInterval } from './presentation-timing';

export interface DecodeOptions {
  width: number;
  height: number;
  /** Source/target FPS ratio; integer values also enforce a source-frame floor. */
  frameDecimation?: number | undefined;
  /** CPU pixel layout delivered to onFrameAvailable. */
  pixelFormat?: CpuPixelFormat | undefined;
  /** Hardware acceleration policy */
  hwAccel?: ('prefer-hardware' | 'prefer-software') | undefined;
  /** Throttled visible-decoded count, with an exact final observation on success. */
  onFrameDecoded?: ((frameIndex: number, totalFrames: number) => void) | undefined;
  /** Development-only observer for operation wall time; operation totals can overlap. */
  profileOperation?: ProfileOperationRecorder | undefined;
  /** Development-only observer for the frame-copy strategy chosen for each frame. */
  profileCopyPath?: ProfileCopyPathRecorder | undefined;
  /**
   * Streaming callback: fired for each decoded frame with the requested CPU pixels.
   * When provided, frames are NOT accumulated into an array — instead they
   * are passed to this callback for immediate processing (e.g. encoding).
   * The callback receives ownership of the pixel buffer (must release to pool).
   */
  onFrameAvailable?:
    | ((
        pixelData: Uint8Array,
        durationMs: number,
        frameNum: number,
        memoryHandoff: FrameMemoryHandoff | undefined,
        presentation: PresentationInterval
      ) => Promise<void> | void)
    | undefined;
  /**
   * GPU-only callback: passes raw VideoFrame to encoder without reading
   * pixels into JS memory. Used by VP8 VideoEncoder path for zero-copy
   * GPU encoding. When provided, smart frame skip and adaptive mode are
   * disabled (dHash requires CPU pixel data).
   * The caller OWNS the VideoFrame and MUST call frame.close().
   */
  onVideoFrameAvailable?:
    | ((
        frame: VideoFrame,
        durationMs: number,
        frameNum: number,
        presentation: PresentationInterval
      ) => Promise<void> | void)
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
   * are represented by the retained frames' presentation intervals.
   * @default 'off'
   */
  smartFrameSkip?: SmartFrameSkipMode | undefined;
  /**
   * Signals a downstream processing failure (for example, an asynchronous
   * encoder worker rejection) so decoding can stop before pulling more chunks.
   * The signal reason should be the original Error.
   */
  processingFailureSignal?: AbortSignal | undefined;
  /** Allow one ordered CPU pixel copy to overlap a slow downstream delivery. */
  stagedCopyLookahead?: boolean | undefined;
  /** Shared WebP source/task/result reservation ledger for the parallel path. */
  frameMemoryBudget?: WebpFrameMemoryBudget | undefined;
  /** Testable lower ceiling; production callers cannot raise the hard packet-work limit. */
  maxInputChunks?: number | undefined;
}

export interface DecodedFrame {
  /** CPU pixel data in the DecodeOptions pixel format. */
  data: Uint8Array;
  /** Frame display duration in milliseconds */
  duration: number;
}

export interface DecodeResult {
  frames: DecodedFrame[];
  totalInputFrames: number;
  /** Number of compressed packets fed to VideoDecoder. */
  consumedChunks: number;
  /** Number of visible decoded frames before selection. */
  decodedFrames: number;
  /** Number of frames passed to the encoder or returned in the batch. */
  selectedFrames: number;
  /** Visible native output frames discarded for an already seen timestamp. */
  duplicateTimestamps: number;
  /** End of the visible presentation interval, relative to its first frame. */
  presentationEndUs: number;
  /** Frames skipped by the fixed frame-decimation ratio. */
  skippedByDecimation: number;
  /** Frames skipped by similarity-based or adaptive smart frame skipping. */
  smartSkipped: number;
  /** Total source duration in milliseconds (from demux chunk durations) */
  sourceTotalMs: number;
  /** Total output duration in milliseconds (sum of all frame durations) */
  outputTotalMs: number;
  /**
   * Legacy field. Timestamp-aware callers use presentationEndUs to close the
   * final retained hold, including any skipped trailing source frames.
   */
  tailAccumulatedMs: number;
}

/**
 * Decode demuxed video chunks to CPU pixel frames.
 *
 * Pipeline:
 *   1. Configure VideoDecoder (hwAccel with software fallback)
 *   2. Pull chunks from DemuxResult only as decoder/output capacity becomes available
 *   3. Per-frame: copy pixels → optional filter → accumulate skipped durations
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
    pixelFormat = 'rgb',
    hwAccel = 'prefer-software',
    onFrameDecoded,
    profileOperation,
    profileCopyPath,
    onFrameAvailable,
    onVideoFrameAvailable,
    mode,
    smartFrameSkip: effectiveSmartSkip = 'off',
    processingFailureSignal,
    stagedCopyLookahead = false,
    frameMemoryBudget,
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
  const motionMemoryBytes =
    streaming && effectiveSmartSkip !== 'off' && typeof onVideoFrameAvailable !== 'function'
      ? MOTION_SIGNATURE_PEAK_BYTES
      : 0;

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
  const batchFrames: DecodedFrame[] = [];
  const pendingConversions = new Set<Promise<void>>();

  // ── Parallel decode temporarily disabled (Phase 1: fix infinite loop in pendingConversions) ──
  // See .hermes/plans/refactor-critical-high-2026-07-14.md for details.
  // Re-enable after implementing bounded ordered queue with Set-based cleanup.

  // ── Smart frame skip state (continued) ──
  const isAdaptive = skipThreshold === -2;
  const sourceFps =
    Number.isFinite(demux.framerate) && demux.framerate > 0
      ? Math.max(1, Math.min(demux.framerate, FPS_CLAMP_MAX))
      : DEFAULT_FPS;
  const fallbackFrameDurationMs = 1000 / sourceFps;
  let previousMotion: MotionSignature | null = null;
  let consecutiveSkipMs = 0; // bounded smart/adaptive hold since last retained frame
  let lastRetainedStartUs: number | null = null;

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
  const maxPendingConversions = frameMemoryBudget
    ? frameMemoryBudget.calculatePendingSourceCapacity(
        estimateDecodedSourceFrameBytes(
          configuredSourceWidth,
          configuredSourceHeight,
          configuredDisplayWidth,
          configuredDisplayHeight
        ),
        10,
        motionMemoryBytes
      )
    : usesStagedCpuStreaming
      ? calculateStagedFrameSourceCapacity(
          configuredSourceWidth,
          configuredSourceHeight,
          configuredDisplayWidth,
          configuredDisplayHeight,
          width,
          height,
          10,
          1,
          pixelFormat,
          motionMemoryBytes
        )
      : calculateFrameOutputConcurrency(
          configuredSourceWidth,
          configuredSourceHeight,
          width,
          height,
          10,
          pixelFormat,
          motionMemoryBytes
        );
  if (maxPendingConversions === 0) {
    throw new Error(
      'Decoded frame output memory limit exceeded (single frame exceeds byte budget)'
    );
  }
  const outputOwnershipRequestedMaximum = Number.MAX_SAFE_INTEGER;
  const targetWorkingBytes = usesStagedCpuStreaming
    ? (frameMemoryBudget?.targetTaskBytes ?? estimateActiveFrameBytes(width, height, pixelFormat))
    : 0;
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
        2,
        pixelFormat,
        motionMemoryBytes
      )
    : 0;
  let stagedLookaheadEnabled =
    stagedCopyLookahead &&
    (frameMemoryBudget
      ? frameMemoryBudget.allowsTargetLookahead
      : twoTargetSourceCapacity >= queuedSourceHeadroomCount);
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
      FRAME_PIPELINE_MEMORY_BUDGET_BYTES - motionMemoryBytes;

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
  let presentationOriginUs: number | null = null;
  let presentationEndUs = 0;
  let duplicateTimestamps = 0;
  let lastNativeTimestampUs: number | null = null;
  let lastVisibleSourceStartUs: number | null = null;
  let lastBatchStartUs: number | null = null;
  let trimEndReached = false;
  let wakeDecodeCapacityWait: (() => void) | null = null;
  let skippedByDecimation = 0;
  let smartSkippedCount = 0;
  interface PendingPresentationFrame {
    frame: VideoFrame;
    releaseReservation: () => void;
    duplicates: number;
    knownEndUs: number | null;
  }
  let pendingPresentationFrame: PendingPresentationFrame | null = null;
  const closePendingPresentationFrame = (): void => {
    const pending = pendingPresentationFrame;
    pendingPresentationFrame = null;
    if (!pending) return;
    pending.releaseReservation();
    pending.frame.close();
  };
  // Noise floor estimation: collect frame diff stdDev from first N frames
  const noiseFloorSamples: number[] = [];
  let noiseFloor = 0; // will be set after sampling phase

  // ── Adaptive motion-classified decimation state ──
  // Running window of motion distances for scene analysis
  let adaptFrameCounter = 0;
  let lastAdaptiveKeptFrame = Number.NEGATIVE_INFINITY;
  const requestedDecimation =
    Number.isFinite(frameDecimation) && frameDecimation > 0 ? Math.max(1, frameDecimation) : 1;
  const selectFixedFrame = createPresentationSampler(sourceFps, requestedDecimation);
  const requestedFrameFloor = Math.max(1, Math.floor(requestedDecimation));
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
    frameMemoryBudget?.closeTargetGate(normalized);
    firstPipelineFailure ??= { error: normalized, origin: 'decoder' };
    wakeDecodeCapacityWait?.();
  };

  const recordCancellation = (): void => {
    cancellationObserved = true;
    discardStagedOutputs = true;
    closeStagedTargetGate();
    const cancellation = new DOMException('Cancelled', 'AbortError');
    frameMemoryBudget?.closeTargetGate(cancellation);
    firstPipelineFailure ??= {
      error: cancellation,
      origin: 'cancellation',
    };
    wakeDecodeCapacityWait?.();
  };

  const recordConversionError = (error: unknown): void => {
    conversionErrorCount++;
    const normalized = normalizeFailure(error);
    firstConversionError ??= normalized;
    closeStagedTargetGate();
    frameMemoryBudget?.closeTargetGate(normalized);
    firstPipelineFailure ??= { error: normalized, origin: 'processing' };
    wakeDecodeCapacityWait?.();
  };

  const hasProcessingFailure = (): boolean => {
    if (processingFailureSignal?.aborted && !firstConversionError) {
      recordConversionError(processingFailureSignal.reason);
    }
    return firstConversionError !== null;
  };

  let lastDecodedProgressCount = 0;
  let lastDecodedProgressTime = 0;
  const reportDecodedProgress = (count: number, terminal = false): void => {
    if (
      !onFrameDecoded ||
      signal?.aborted ||
      processingFailureSignal?.aborted ||
      firstPipelineFailure
    ) {
      return;
    }
    if (!terminal && count <= lastDecodedProgressCount) return;
    const now = performance.now();
    const advanced = count - lastDecodedProgressCount;
    // Time-based updates cover sparse decodes, while count advancement also
    // covers fast bursts. Both paths cap callbacks independently of selection.
    if (
      !terminal &&
      lastDecodedProgressCount > 0 &&
      advanced < 10 &&
      (advanced < 2 || now - lastDecodedProgressTime < 100)
    ) {
      return;
    }
    lastDecodedProgressCount = count;
    lastDecodedProgressTime = now;
    try {
      onFrameDecoded(count, demux.totalFrames);
    } catch (error) {
      recordConversionError(error);
    }
  };

  const handleProcessingFailure = (): void => {
    recordConversionError(processingFailureSignal?.reason);
  };
  const handleCancellation = (): void => {
    recordCancellation();
  };
  let motionMemoryReservation: FrameMemoryReservation | null = null;
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
    closePendingPresentationFrame();
    previousMotion = null;
    motionMemoryReservation?.release();
    motionMemoryReservation = null;

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

  // Create per-conversion frame processing context for the pixel-copy path cache.
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

  const retainPresentationFrame = (frame: VideoFrame, knownEndUs: number | null): void => {
    let releaseReservation: () => void;
    if (usesStagedCpuStreaming) {
      let runtimeAllocationBytes: number | null = null;
      if (frame.format != null && typeof frame.allocationSize === 'function') {
        try {
          runtimeAllocationBytes = frame.allocationSize();
        } catch {
          // Unknown native layout uses the conservative 8-Bpp source floor.
        }
      }
      const sourceBytes = estimateRuntimeDecodedSourceFrameBytes(
        frame.codedWidth,
        frame.codedHeight,
        frame.displayWidth,
        frame.displayHeight,
        runtimeAllocationBytes
      );
      if (frameMemoryBudget) {
        const reservation = frameMemoryBudget.tryReserveSource(sourceBytes);
        if (!reservation) {
          throw new Error('Unknown-duration frame lookbehind exceeds shared frame byte budget');
        }
        releaseReservation = () => reservation.release();
      } else {
        if (
          retainedSourceFrameBytes +
            sourceBytes +
            Math.max(activeStagedTargetSlots, 1) * targetWorkingBytes >
          FRAME_PIPELINE_MEMORY_BUDGET_BYTES - motionMemoryBytes
        ) {
          throw new Error('Unknown-duration frame lookbehind exceeds source frame byte budget');
        }
        retainedSourceFrameBytes += sourceBytes;
        let released = false;
        releaseReservation = () => {
          if (released) return;
          released = true;
          retainedSourceFrameBytes -= sourceBytes;
          drainStagedTargetWaiters();
        };
      }
    } else {
      const maxOutputSlots = Math.min(
        calculateFrameOutputConcurrency(
          frame.codedWidth,
          frame.codedHeight,
          width,
          height,
          outputOwnershipRequestedMaximum,
          pixelFormat,
          motionMemoryBytes
        ),
        calculateFrameOutputConcurrency(
          frame.displayWidth,
          frame.displayHeight,
          width,
          height,
          outputOwnershipRequestedMaximum,
          pixelFormat,
          motionMemoryBytes
        )
      );
      if (activeOutputSlots >= maxOutputSlots) {
        throw new Error('Unknown-duration frame lookbehind exceeds output frame slot limit');
      }
      activeOutputSlots++;
      let released = false;
      releaseReservation = () => {
        if (released) return;
        released = true;
        releaseOutputSlot();
      };
    }
    pendingPresentationFrame = { frame, releaseReservation, duplicates: 0, knownEndUs };
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

  const frameProcessor = {
    processDecodedFrame(frame: VideoFrame, sourceEndUs: number, deferredDuplicateCount = 0): void {
      try {
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
        if (!Number.isSafeInteger(frame.timestamp)) {
          recordDecoderError(new Error('Decoded frame has an invalid presentation timestamp'));
          frame.close();
          return;
        }
        const sourceStartUs = frame.timestamp;
        if (!Number.isSafeInteger(sourceEndUs) || sourceEndUs <= sourceStartUs) {
          recordDecoderError(
            new Error('Decoded frame presentation interval exceeds integer range')
          );
          frame.close();
          return;
        }
        const trimStartUs = Math.max(0, demux.trimStartUs ?? 0);
        const trimEndUs = demux.trimEndUs;
        const overlapStartUs = Math.max(sourceStartUs, trimStartUs);
        const overlapEndUs = Math.min(sourceEndUs, trimEndUs ?? Number.POSITIVE_INFINITY);
        const duplicate = lastVisibleSourceStartUs === sourceStartUs;
        if (!duplicate && trimEndUs !== undefined && sourceEndUs >= trimEndUs) {
          trimEndReached = true;
          wakeDecodeCapacityWait?.();
        }
        if (overlapEndUs <= overlapStartUs) {
          frame.close();
          return;
        }
        presentationOriginUs ??= overlapStartUs;
        const presentation: PresentationInterval = {
          startUs: overlapStartUs - presentationOriginUs,
          endUs: overlapEndUs - presentationOriginUs,
        };
        presentationEndUs = Math.max(presentationEndUs, presentation.endUs);
        const frameNum = inputFrameCount++;
        if (duplicate) {
          // Equal PTS has no representable hold. Keep the first visible frame
          // and count/close later native outputs before pixel admission.
          duplicateTimestamps++;
          frame.close();
          reportDecodedProgress(inputFrameCount);
          return;
        }
        inputFrameCount += deferredDuplicateCount;
        duplicateTimestamps += deferredDuplicateCount;
        lastVisibleSourceStartUs = sourceStartUs;
        reportDecodedProgress(inputFrameCount);
        if (firstPipelineFailure || signal?.aborted) {
          frame.close();
          return;
        }
        const frameDuration = Math.max(1, Math.round((overlapEndUs - overlapStartUs) / 1000));

        // Select at source presentation boundaries, preserving fractional
        // source/target FPS ratios and never anticipating the next frame.
        const cadenceEligible =
          canRunAdaptiveAnalysis || selectFixedFrame(presentation.startUs, frameNum);
        if (!canRunAdaptiveAnalysis && !cadenceEligible) {
          frame.close();
          skippedByDecimation++;
          return;
        }

        let sourceReservationBytes = 0;
        let sourceReservationActive = false;
        let sourceMemoryReservation: FrameMemoryReservation | null = null;
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
          sourceMemoryReservation =
            frameMemoryBudget?.tryReserveSource(sourceReservationBytes) ?? null;
          if (
            frameMemoryBudget
              ? sourceMemoryReservation === null
              : retainedSourceFrameBytes +
                  sourceReservationBytes +
                  Math.max(activeStagedTargetSlots, 1) * targetWorkingBytes >
                FRAME_PIPELINE_MEMORY_BUDGET_BYTES - motionMemoryBytes
          ) {
            const memoryLimitDescription = frameMemoryBudget
              ? 'shared frame byte budget'
              : `${Math.floor(
                  (FRAME_PIPELINE_MEMORY_BUDGET_BYTES -
                    Math.max(activeStagedTargetSlots, 1) * targetWorkingBytes) /
                    sourceReservationBytes
                )} source frame limit`;
            recordDecoderError(
              new Error(`Decoded frame output memory limit exceeded (${memoryLimitDescription})`)
            );
            frame.close();
            return;
          }
          if (!frameMemoryBudget) retainedSourceFrameBytes += sourceReservationBytes;
          sourceReservationActive = true;
        } else {
          const maxOutputSlots = Math.min(
            calculateFrameOutputConcurrency(
              frame.codedWidth,
              frame.codedHeight,
              width,
              height,
              outputOwnershipRequestedMaximum,
              pixelFormat,
              motionMemoryBytes
            ),
            calculateFrameOutputConcurrency(
              frame.displayWidth,
              frame.displayHeight,
              width,
              height,
              outputOwnershipRequestedMaximum,
              pixelFormat,
              motionMemoryBytes
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
          let targetMemoryReservation: FrameMemoryReservation | null = null;
          let targetMemoryHandoff: FrameMemoryHandoff | undefined;
          let stagedCopyReleased = false;
          const releaseStagedCopy = (): void => {
            if (!usesStagedCpuStreaming || stagedCopyReleased) return;
            stagedCopyReleased = true;
            resolveStagedCopy();
          };
          const releaseSourceReservation = (): void => {
            if (!sourceReservationActive) return;
            sourceReservationActive = false;
            if (sourceMemoryReservation) {
              sourceMemoryReservation.release();
              sourceMemoryReservation = null;
            } else {
              retainedSourceFrameBytes = Math.max(
                0,
                retainedSourceFrameBytes - sourceReservationBytes
              );
              drainStagedTargetWaiters();
            }
          };
          const closeSourceFrame = (): void => {
            if (sourceFrameClosed) return;
            sourceFrameClosed = true;
            frame.close();
          };
          try {
            // ── GPU-only path: pass VideoFrame directly to encoder ──
            // Skips the GPU→CPU pixel read and all pixel-motion processing.
            // Used by VP8 VideoEncoder path for zero-copy GPU encoding.
            // Smart frame skip and adaptive mode are disabled (require CPU pixels).
            if (typeof onVideoFrameAvailable === 'function') {
              await previousProcessing;
              enteredOrderedProcessing = true;
              if (signal?.aborted || decodeError || hasProcessingFailure()) return;
              keptFrameCount++;
              sourceFrameTransferred = true;
              await onVideoFrameAvailable(frame, frameDuration, frameNum, presentation);
              // Caller owns frame and MUST call frame.close()
              return;
            }

            if (usesStagedCpuStreaming) {
              await previousStagedCopy;
              if (signal?.aborted || discardStagedOutputs || hasProcessingFailure()) return;
              if (frameMemoryBudget) {
                targetMemoryReservation = await frameMemoryBudget.acquireTarget();
                targetMemoryHandoff = frameMemoryBudget.createHandoff(targetMemoryReservation);
                stagedTargetActive = true;
              } else {
                stagedTargetActive = await acquireStagedTarget(stagedTargetSlotLimit);
              }
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

            let pixelData: Uint8Array;
            const pixelCopyStart = profileOperation ? performance.now() : null;
            try {
              pixelData = await copyFrameToPixels(
                frame,
                width,
                height,
                frameCtx,
                pixelFormat,
                demux.rotation ?? 0
              );
            } finally {
              if (pixelCopyStart !== null) {
                profileOperation?.('pixelCopy', Math.max(0, performance.now() - pixelCopyStart));
              }
              profileCopyPath?.(frameCtx.copyPath ?? 'unknown');
              if (usesStagedCpuStreaming) {
                closeSourceFrame();
                releaseSourceReservation();
              }
            }
            await previousProcessing;
            enteredOrderedProcessing = true;
            if (signal?.aborted || discardStagedOutputs || hasProcessingFailure()) {
              globalBufferPool.release(pixelData);
              return;
            }

            const shouldMeasureMotion = streaming && (skipThreshold >= 0 || isAdaptive);
            const motionFeatureStart =
              profileOperation && shouldMeasureMotion ? performance.now() : null;
            const signature = shouldMeasureMotion
              ? computeMotionSignature(pixelData, width, height, pixelFormat === 'rgba' ? 4 : 3)
              : null;
            const frameDistance =
              signature !== null && previousMotion !== null
                ? compareMotionSignatures(signature, previousMotion).distance
                : null;
            if (motionFeatureStart !== null) {
              profileOperation?.(
                'motionFeatures',
                Math.max(0, performance.now() - motionFeatureStart)
              );
            }

            const motionDecisionStart =
              profileOperation && shouldMeasureMotion ? performance.now() : null;
            const recordMotionDecision = (): void => {
              if (motionDecisionStart !== null) {
                profileOperation?.(
                  'motionDecision',
                  Math.max(0, performance.now() - motionDecisionStart)
                );
              }
            };

            if (frameDistance !== null && noiseFloorSamples.length < ADAPTIVE_NOISE_SAMPLE_COUNT) {
              noiseFloorSamples.push(frameDistance);
              if (noiseFloorSamples.length === ADAPTIVE_NOISE_SAMPLE_COUNT) {
                noiseFloor = calculateAdaptiveNoiseFloor(noiseFloorSamples);
              }
            }

            // ── Smart frame skip: similarity-based deduplication ──
            if (streaming && skipThreshold >= 0 && signature !== null) {
              if (frameDistance !== null) {
                // Skip if similar AND consecutive skip time < 500ms
                // Use max of user threshold and noise-adapted floor
                const effectiveThreshold = Math.max(skipThreshold, noiseFloor);
                const elapsedSinceRetainedMs =
                  lastRetainedStartUs === null
                    ? 0
                    : (presentation.startUs - lastRetainedStartUs) / 1000;
                if (
                  frameDistance <= effectiveThreshold &&
                  Math.max(consecutiveSkipMs, elapsedSinceRetainedMs) < 500
                ) {
                  // Skip this frame: accumulate duration, release buffer, return
                  consecutiveSkipMs += frameDuration;
                  smartSkippedCount++;
                  globalBufferPool.release(pixelData);
                  recordMotionDecision();
                  return;
                }
              }

              previousMotion = signature;
              consecutiveSkipMs = 0;
              lastRetainedStartUs = presentation.startUs;
            }

            // ── Adaptive motion-classified decimation ──
            // Instead of fixed decimation, classify each frame's motion level
            // and apply variable decimation: static scenes get aggressive skip,
            // while fast motion uses the preset/memory decimation floor. Uses bounded RGB tile statistics
            // and a local-change safeguard for comparison.
            //
            // NOTE: This block is NEVER entered when onVideoFrameAvailable is active
            // (GPU-only path) because that path skips copyFrameToPixels entirely, meaning
            // no CPU pixel data/motion statistics is available. See the GPU-only early return
            // earlier in this function (onVideoFrameAvailable check).
            //
            // NOTE: The first frame is always classified as adaptLastMotionClass
            // (initially 'normal') because previousMotion is null until at least two frames
            // have been processed. This initial misclassification is expected and has
            // negligible impact — only one frame's decimation is affected.
            if (canRunAdaptiveAnalysis && signature !== null) {
              let motionClass: AdaptiveMotionClass = adaptLastMotionClass;

              if (frameDistance !== null) {
                // Classify motion level using noise-floor-adapted thresholds.
                // Lower-noise videos get tighter thresholds (more aggressive skip),
                // noisier videos get wider thresholds (conservative skip).
                motionClass = classifyAdaptiveMotion(frameDistance, noiseFloor);

                // Scene change detection: align the adaptive cadence so the new
                // scene remains visible, but never reset it before the requested
                // preset or memory floor allows another frame.
                if (
                  isSignificantMotionIncrease(motionClass, adaptLastMotionClass) &&
                  frameNum - lastAdaptiveKeptFrame >= requestedFrameFloor
                ) {
                  adaptFrameCounter = 0; // force keep on significant motion increase
                }
                adaptLastMotionClass = motionClass;
              }

              previousMotion = signature;

              const decimation = calculateAdaptiveDecimation(
                motionClass,
                requestedFrameFloor,
                maxAdaptiveDecimation
              );
              const shouldSkip = shouldSkipAdaptiveFrame({
                frameNum,
                lastKeptFrame: lastAdaptiveKeptFrame,
                requestedDecimation: requestedFrameFloor,
                frameCounter: adaptFrameCounter,
                decimation,
                consecutiveSkipMs: Math.max(
                  consecutiveSkipMs,
                  lastRetainedStartUs === null
                    ? 0
                    : (presentation.startUs - lastRetainedStartUs) / 1000
                ),
              });

              adaptFrameCounter++;

              if (shouldSkip || !selectFixedFrame(presentation.startUs, frameNum)) {
                consecutiveSkipMs += frameDuration;
                smartSkippedCount++;
                globalBufferPool.release(pixelData);
                recordMotionDecision();
                return;
              }

              // Frame kept: reset the bounded consecutive-skip counter.
              lastAdaptiveKeptFrame = frameNum;
              consecutiveSkipMs = 0;
              lastRetainedStartUs = presentation.startUs;
            }

            recordMotionDecision();

            if (streaming) {
              // Streaming mode: pass frame to callback for immediate processing.
              // The next retained timestamp determines this frame's final hold.
              keptFrameCount++;
              if (!frameAvailable) {
                throw new Error('Streaming decode requires an onFrameAvailable callback');
              }
              let delivery: Promise<void> | void;
              try {
                delivery = frameAvailable(
                  pixelData,
                  frameDuration,
                  frameNum,
                  targetMemoryHandoff,
                  presentation
                );
              } finally {
                releaseStagedCopy();
              }
              await delivery;
              // Note: onFrameAvailable is responsible for releasing pixelData
            } else {
              // Batch mode: collect into array (existing behavior for WebP)
              if (lastBatchStartUs !== null) {
                const previous = batchFrames[batchFrames.length - 1];
                if (previous) {
                  previous.duration = Math.max(0, (presentation.startUs - lastBatchStartUs) / 1000);
                }
              }
              batchFrames.push({ data: pixelData, duration: frameDuration });
              lastBatchStartUs = presentation.startUs;
            }
          } catch (error) {
            recordConversionError(error);
          } finally {
            if (!enteredOrderedProcessing) {
              await previousProcessing;
            }
            releaseStagedCopy();
            if (targetMemoryReservation) {
              if (!targetMemoryHandoff?.isTaken) targetMemoryReservation.release();
            } else if (stagedTargetActive) {
              releaseStagedTarget();
            }
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
  };

  const finishPendingPresentationFrame = (endUs: number): void => {
    const pending = pendingPresentationFrame;
    pendingPresentationFrame = null;
    if (!pending) return;
    // Transfer native ownership synchronously into the ordinary source
    // admission path. No copy or other allocation occurs between release and
    // reacquisition, and that path closes the frame on every exit.
    pending.releaseReservation();
    frameProcessor.processDecodedFrame(
      pending.frame,
      Math.min(endUs, pending.knownEndUs ?? Number.POSITIVE_INFINITY),
      pending.duplicates
    );
  };
  const getPendingPresentationFrame = (): PendingPresentationFrame | null =>
    pendingPresentationFrame;

  const decoderInit: VideoDecoderInit = {
    output(frame: VideoFrame) {
      releaseEncodedChunkForOutput(frame.timestamp);
      if (!hasSafeFrameDimensions(frame)) {
        recordDecoderError(new Error('Decoded frame dimensions exceed the per-frame memory limit'));
        frame.close();
        return;
      }
      if (decodeError || hasProcessingFailure()) {
        frame.close();
        return;
      }
      if (!Number.isSafeInteger(frame.timestamp)) {
        recordDecoderError(new Error('Decoded frame has an invalid presentation timestamp'));
        frame.close();
        return;
      }
      if (lastNativeTimestampUs !== null && frame.timestamp < lastNativeTimestampUs) {
        recordDecoderError(new Error('Decoded frames have decreasing presentation timestamps'));
        frame.close();
        return;
      }
      const pending = pendingPresentationFrame;
      if (pending && frame.timestamp === pending.frame.timestamp) {
        pending.duplicates++;
        frame.close();
        return;
      }
      if (pending) {
        try {
          finishPendingPresentationFrame(frame.timestamp);
        } catch (error) {
          recordDecoderError(error);
          frame.close();
          return;
        }
      }
      if (decodeError || hasProcessingFailure()) {
        frame.close();
        return;
      }
      lastNativeTimestampUs = frame.timestamp;

      const knownEndUs =
        frame.duration != null && Number.isSafeInteger(frame.duration) && frame.duration > 0
          ? frame.timestamp + frame.duration
          : null;
      if (knownEndUs === null) {
        if (demux.trimEndUs !== undefined && frame.timestamp >= demux.trimEndUs) {
          frame.close();
          return;
        }
        try {
          retainPresentationFrame(frame, null);
        } catch (error) {
          recordDecoderError(error);
          frame.close();
        }
        return;
      }
      const trimStartUs = Math.max(0, demux.trimStartUs ?? 0);
      if (frame.timestamp < trimStartUs && knownEndUs > trimStartUs) {
        try {
          retainPresentationFrame(frame, knownEndUs);
        } catch (error) {
          recordDecoderError(error);
          frame.close();
        }
        return;
      }
      frameProcessor.processDecodedFrame(frame, knownEndUs);
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
    if (motionMemoryBytes > 0 && frameMemoryBudget) {
      motionMemoryReservation = frameMemoryBudget.reserveAnalysis(motionMemoryBytes);
    }
    decoder = new VideoDecoder(decoderInit);
    decoder.configure(activeConfig);
  } catch (error) {
    recordDecoderError(error);
    const primaryFailure = getLatchedFailureError() ?? normalizeFailure(error);
    throw (await cleanupDecoderLifecycle(primaryFailure)) ?? primaryFailure;
  }
  const activeDecoder = decoder;

  const supportsDequeueEvent =
    typeof activeDecoder.addEventListener === 'function' &&
    typeof activeDecoder.removeEventListener === 'function';
  const waitForDecodeCapacity = async (): Promise<void> => {
    if (!supportsDequeueEvent) {
      // Older implementations without EventTarget support need a bounded retry.
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      let ready = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        activeDecoder.removeEventListener('dequeue', checkCapacity);
        signal?.removeEventListener('abort', checkCapacity);
        processingFailureSignal?.removeEventListener('abort', checkCapacity);
        if (timeoutId !== null) clearTimeout(timeoutId);
        if (wakeDecodeCapacityWait === checkCapacity) wakeDecodeCapacityWait = null;
        resolve();
      };
      const checkCapacity = (): void => {
        if (!ready) return;
        if (
          activeDecoder.decodeQueueSize <= MAX_DECODE_QUEUE ||
          signal?.aborted ||
          decodeError ||
          trimEndReached ||
          hasProcessingFailure()
        ) {
          finish();
        }
      };
      activeDecoder.addEventListener('dequeue', checkCapacity);
      signal?.addEventListener('abort', checkCapacity);
      processingFailureSignal?.addEventListener('abort', checkCapacity);
      wakeDecodeCapacityWait = checkCapacity;
      timeoutId = setTimeout(() => {
        recordDecoderError(new Error('Video decoder queue stalled while waiting for capacity'));
      }, STALL_DETECTION_TIMEOUT_MS);
      // The queue may have drained while the listeners were being attached.
      ready = true;
      checkCapacity();
    });
  };

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
      if (decodeError || hasProcessingFailure() || trimEndReached) break;

      // Backpressure: wait for native dequeue notifications when available.
      const capacityWaitDeadline = Date.now() + STALL_DETECTION_TIMEOUT_MS;
      while (
        activeDecoder.decodeQueueSize > MAX_DECODE_QUEUE &&
        !signal?.aborted &&
        !decodeError &&
        !trimEndReached &&
        !hasProcessingFailure()
      ) {
        if (!supportsDequeueEvent && Date.now() >= capacityWaitDeadline) {
          recordDecoderError(new Error('Video decoder queue stalled while waiting for capacity'));
          break;
        }
        await waitForDecodeCapacity();
      }

      // Backpressure on output processing (RES-H2): wait if too many
      // frame conversion promises are in flight. This prevents unbounded
      // memory growth when decoded frames accumulate faster than they
      // can be processed (e.g., pixel copy + encoding).
      if (pendingConversions.size >= maxPendingConversions) {
        await Promise.race([...pendingConversions]);
      }

      if (signal?.aborted) {
        recordCancellation();
        break;
      }
      if (decodeError || hasProcessingFailure() || trimEndReached) break;

      const nextChunk = await activeChunkStream.next();
      if (nextChunk.done) break;
      if (trimEndReached) break;
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

    // Finish already-emitted lookahead work before entering the decoder flush.
    // Frames emitted by flush capture the serial target limit below.
    const shouldDrainLookahead = usesStagedCpuStreaming && stagedLookaheadEnabled;
    stagedLookaheadEnabled = false;
    if (
      (shouldDrainLookahead || frameMemoryBudget) &&
      !decodeError &&
      !cancellationObserved &&
      !hasProcessingFailure()
    ) {
      await Promise.allSettled([...pendingConversions]);
      if (frameMemoryBudget && !decodeError && !cancellationObserved && !hasProcessingFailure()) {
        try {
          await frameMemoryBudget.waitForTargets();
        } catch (error) {
          if (!firstPipelineFailure) recordConversionError(error);
        }
      }
    }

    // A failure can surface while pre-flush work drains. Re-check the shared
    // latch so cancelled or failed codec work is reset instead of flushed.
    if (decodeError || cancellationObserved || hasProcessingFailure()) {
      try {
        activeDecoder.reset();
      } catch {
        // Preserve the failure already recorded by the shared latch.
      }
    } else {
      try {
        frameMemoryBudget?.beginDecoderFlush();
        await activeDecoder.flush();
      } catch (e) {
        recordDecoderError(e);
      }
    }
    const finalPendingFrame = getPendingPresentationFrame();
    if (!decodeError && !cancellationObserved && !hasProcessingFailure() && finalPendingFrame) {
      const startUs = finalPendingFrame.frame.timestamp;
      const metadataEndUs = Math.round(demux.duration * 1_000_000);
      const fallbackEndUs = startUs + Math.max(1, Math.round(fallbackFrameDurationMs * 1000));
      const endUs =
        finalPendingFrame.knownEndUs ??
        (Number.isSafeInteger(metadataEndUs) && metadataEndUs > startUs
          ? metadataEndUs
          : fallbackEndUs);
      // A final unknown duration has no following PTS. Prefer the validated
      // source endpoint; otherwise use one bounded (at most one second) FPS interval.
      finishPendingPresentationFrame(endUs);
    }
    // Always await pending conversions before closing decoder to avoid VideoFrame leak.
    // Use Promise.allSettled so that even if some conversions fail (e.g., due to abort),
    // we still drain all pending work and close frames properly.
    await Promise.allSettled([...pendingConversions]);
    frameMemoryBudget?.completeDecoderFlush();

    // Any frame or downstream encoding failure makes the output incomplete.
    // Preserve the first cause after every already-created frame is closed.
    const pipelineFailure = getLatchedFailureError();
    if (pipelineFailure) throw pipelineFailure;

    // The last batch frame owns the visible tail, including skipped frames.
    if (!streaming && lastBatchStartUs !== null && batchFrames.length > 0) {
      const last = batchFrames[batchFrames.length - 1];
      if (last) last.duration = Math.max(0, (presentationEndUs - lastBatchStartUs) / 1000);
    }

    // Compute timing summary
    const sourceTotalMs =
      streamedSourceDurationUs > 0 ? streamedSourceDurationUs / 1000 : demux.sourceTotalMs;
    // Streaming mode: encoder handles frame timing internally, so outputTotalMs is not
    // tracked here. GIF/WebP encoders compute their own timing from frame durations.
    // Non-streaming: sum all retained frame durations.
    const outputTotalMs = streaming ? 0 : batchFrames.reduce((sum, f) => sum + f.duration, 0);

    logger.info('decoders', 'Decoding complete', {
      totalInputFrames: inputFrameCount,
      outputFrames: streaming ? keptFrameCount : batchFrames.length,
      skippedByDecimation,
      smartSkipped: smartSkippedCount,
      smartSkipMode: effectiveSmartSkip,
      noiseFloor: Math.round(noiseFloor * 100) / 100,
      resolution: `${width}×${height}`,
      streaming,
    });

    decodeResult = {
      frames: batchFrames,
      totalInputFrames: inputFrameCount,
      consumedChunks: inputChunkCount,
      decodedFrames: inputFrameCount,
      selectedFrames: streaming ? keptFrameCount : batchFrames.length,
      duplicateTimestamps,
      presentationEndUs,
      skippedByDecimation,
      smartSkipped: smartSkippedCount,
      sourceTotalMs,
      outputTotalMs,
      tailAccumulatedMs: 0,
    };
  } catch (error) {
    primaryFailure = normalizeFailure(error);
  }
  const cleanupFailure = await cleanupDecoderLifecycle(primaryFailure);
  if (cleanupFailure) throw cleanupFailure;
  reportDecodedProgress(inputFrameCount, true);
  const progressFailure = getLatchedFailureError();
  if (progressFailure) throw progressFailure;
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
