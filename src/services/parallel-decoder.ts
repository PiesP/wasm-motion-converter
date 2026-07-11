// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Parallel VideoDecoder Service
 *
 * Splits video at keyframe boundaries and decodes multiple segments
 * in parallel using N VideoDecoder instances. Speeds up the dominant
 * decode phase (~70% of total time) by up to N× depending on keyframe
 * spacing and hardware concurrency.
 *
 * Architecture:
 *   1. Detect keyframe positions from EncodedVideoChunk.type
 *   2. Split chunks into segments at keyframe boundaries
 *   3. Run up to MAX_PARALLEL decoders concurrently
 *   4. Decoded VideoFrames are collected and ordered by frame index
 *   5. Output: ordered stream of VideoFrames ready for encoding
 *
 * Requirements:
 *   - Video must have ≥2 keyframes (otherwise falls back to single decoder)
 *   - Each segment decodes independently (B/P frames reference within segment)
 *
 * VideoDecoder is stateful — B/P frames depend on all frames since the last
 * keyframe. By splitting at keyframes, each segment is independently decodable.
 */

import { logger } from '@utils/logger';
import type { DemuxResult } from './demuxer-service';
import {
  copyFrameToRGB,
  createFrameProcessingContext,
  type FrameProcessingContext,
  getFrameDurationMs,
} from './frame-utils';

/** Maximum number of parallel decoders */
const MAX_PARALLEL_DECODERS = 4;

/** Maximum number of in-flight frame conversions per segment.
 *  Parallel decoders have a higher limit than the single-decoder path
 *  (10) because multiple segments may need concurrent memory. Still bounded
 *  to prevent unbounded memory growth when decoded frames arrive faster than
 *  copyFrameToRGB can process them. */
const MAX_PENDING_CONVERSIONS = 16;

/** Minimum frames per segment to justify parallelization overhead.
 *  Small segments waste time on decoder creation/teardown.
 *  At 60fps, 100 frames ≈ 1.7s of video. */
const MIN_SEGMENT_FRAMES = 100;

export interface DecodedFrameStream {
  /** RGB pixel data (borrowed from buffer pool — caller must release) */
  data: Uint8Array;
  /** Frame display duration in milliseconds */
  durationMs: number;
  /** Global frame index for ordering */
  globalIndex: number;
}

export interface ParallelDecodeOptions {
  width: number;
  height: number;
  hwAccel?: 'prefer-hardware' | 'prefer-software';
  /** Progress callback: (completedFrames, totalFrames) */
  onProgress?: (completed: number, total: number) => void;
  /**
   * Streaming callback: when provided, decoded frames are emitted per-batch
   * instead of collected into a full array. This reduces peak memory from
   * O(total frames) to O(batch frames) — critical for long/high-res videos.
   */
  onFrame?: ((frame: DecodedFrameStream) => Promise<void> | void) | undefined;
}

export interface ParallelDecodeResult {
  /** Ordered frame stream */
  frames: DecodedFrameStream[];
  /** Total source duration in milliseconds */
  sourceTotalMs: number;
  /** Total input frames decoded */
  totalInputFrames: number;
}

/**
 * Detects keyframe positions from demuxed chunks.
 * Returns array of chunk indices where keyframes occur.
 */
function findKeyframes(chunks: EncodedVideoChunk[]): number[] {
  const keyframes: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i]!.type === 'key') {
      keyframes.push(i);
    }
  }
  // Always include start
  if (keyframes.length === 0 || keyframes[0] !== 0) {
    keyframes.unshift(0);
  }
  return keyframes;
}

/**
 * Split chunks into segments at keyframe boundaries.
 * Each segment starts with a keyframe chunk and contains all
 * subsequent chunks until the next keyframe.
 */
function splitIntoOrderedSegments(
  chunks: EncodedVideoChunk[],
  keyframeIndices: number[]
): Array<{ chunks: EncodedVideoChunk[]; startIndex: number }> {
  const segments: Array<{ chunks: EncodedVideoChunk[]; startIndex: number }> = [];

  for (let i = 0; i < keyframeIndices.length; i++) {
    const start = keyframeIndices[i]!;
    const end = keyframeIndices[i + 1] ?? chunks.length;
    const segmentChunks = chunks.slice(start, end);
    if (segmentChunks.length >= MIN_SEGMENT_FRAMES) {
      segments.push({ chunks: segmentChunks, startIndex: start });
    }
  }

  // Limit to MAX_PARALLEL_DECODERS by merging adjacent segments.
  // Too many small segments waste time on decoder creation/teardown.
  if (segments.length > MAX_PARALLEL_DECODERS) {
    const merged: Array<{ chunks: EncodedVideoChunk[]; startIndex: number }> = [];
    const mergeSize = Math.ceil(segments.length / MAX_PARALLEL_DECODERS);
    for (let i = 0; i < segments.length; i += mergeSize) {
      const batch = segments.slice(i, i + mergeSize);
      const mergedChunks = batch.flatMap((s) => s.chunks);
      merged.push({ chunks: mergedChunks, startIndex: batch[0]!.startIndex });
    }
    return merged;
  }

  return segments;
}

/**
 * Decode a single segment using a dedicated VideoDecoder.
 */
async function decodeSegment(
  segment: { chunks: EncodedVideoChunk[]; startIndex: number },
  config: VideoDecoderConfig,
  opts: ParallelDecodeOptions,
  signal?: AbortSignal
): Promise<DecodedFrameStream[]> {
  const { width, height, hwAccel = 'prefer-software' } = opts;
  const frames: DecodedFrameStream[] = [];
  const frameCtx: FrameProcessingContext = createFrameProcessingContext();

  let segmentFrameIdx = 0;
  let decodeError: Error | null = null;
  const pendingConversions: Promise<void>[] = [];

  const decoder = new VideoDecoder({
    output(frame: VideoFrame) {
      try {
        const { durationMs, ctx: nextFrameCtx } = getFrameDurationMs(frame, frameCtx);
        Object.assign(frameCtx, nextFrameCtx);
        const globalIndex = segment.startIndex + segmentFrameIdx;
        segmentFrameIdx++;

        // Track async conversion for final flush
        const conversion = copyFrameToRGB(frame, width, height, frameCtx)
          .then((rgbData) => {
            frames.push({
              data: rgbData,
              durationMs,
              globalIndex,
            });
          })
          .catch((err) => {
            logger.error('decoders', 'Segment frame copy failed', {
              globalIndex,
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            frame.close();
          });

        pendingConversions.push(conversion);
      } catch (err) {
        frame.close();
        throw err;
      }
    },
    error(e: Error) {
      decodeError = e;
    },
  });

  // Resolve decoder config with hardware acceleration support check
  const swConfig = { ...config, hardwareAcceleration: 'prefer-software' as const };
  const hwConfig = { ...config, hardwareAcceleration: 'prefer-hardware' as const };
  const hwSupport = await VideoDecoder.isConfigSupported(hwConfig);
  const activeConfig =
    hwAccel === 'prefer-hardware' && hwSupport.supported
      ? { ...hwConfig, optimizeForLatency: false }
      : { ...swConfig, optimizeForLatency: false };
  decoder.configure(activeConfig);

  for (let i = 0; i < segment.chunks.length; i++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (decodeError) break;

    // Backpressure: wait if decode queue is full
    while (decoder.decodeQueueSize > 8 && !signal?.aborted && !decodeError) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    // Backpressure on output: wait if too many frame conversion promises
    // are in flight. Prevents OOM when VideoDecoder produces frames faster
    // than copyFrameToRGB can process them (same counter as single-decoder path).
    while (
      pendingConversions.length >= MAX_PENDING_CONVERSIONS &&
      !signal?.aborted &&
      !decodeError
    ) {
      await Promise.race(pendingConversions);
    }

    decoder.decode(segment.chunks[i]!);
  }

  try {
    await decoder.flush();
  } catch (_err) {
    // flush may throw if decodeError is set — that's ok
  }

  // Wait for all pending frame conversions to complete before closing
  await Promise.allSettled(pendingConversions);
  decoder.close();

  if (decodeError) throw decodeError;

  return frames;
}

/**
 * Decode all frames using parallel VideoDecoders.
 *
 * Splits the video into keyframe-aligned segments and decodes
 * them concurrently. Frames are collected and reordered by global
 * frame index before returning.
 *
 * @returns Ordered frame stream ready for encoding
 */
export async function decodeFramesParallel(
  demux: DemuxResult,
  opts: ParallelDecodeOptions,
  signal?: AbortSignal
): Promise<ParallelDecodeResult> {
  const { onProgress } = opts;
  const chunks = demux.chunks;

  // Step 1: Find keyframes and split into segments
  const keyframeIndices = findKeyframes(chunks);
  const segments = splitIntoOrderedSegments(chunks, keyframeIndices);

  logger.info('decoders', 'Parallel decode segments', {
    keyframes: keyframeIndices,
    segments: segments.length,
    segmentSizes: segments.map((s) => s.chunks.length),
    totalChunks: chunks.length,
  });

  // Fall back to single decoder if not enough segments
  if (segments.length < 2) {
    logger.info('decoders', 'Not enough segments for parallel decode', {
      segments: segments.length,
      keyframes: keyframeIndices.length,
    });
    // Caller should fall back to regular decodeFrames
    throw new Error('Insufficient keyframes for parallel decode');
  }

  // Step 2: Decode segments in parallel (up to MAX_PARALLEL_DECODERS at a time).
  // Emit frames per-batch through the streaming callback to keep memory bounded.
  const { onFrame } = opts;
  if (!onFrame) {
    // Legacy batch-collection path (non-streaming callers)
    const allFrames: DecodedFrameStream[][] = [];
    for (let i = 0; i < segments.length; i += MAX_PARALLEL_DECODERS) {
      const batch = segments.slice(i, i + MAX_PARALLEL_DECODERS);
      const batchResults = await Promise.all(
        batch.map((seg) => decodeSegment(seg, demux.config, opts, signal))
      );
      allFrames.push(...batchResults);
      if (onProgress) {
        const totalDone = allFrames.reduce((sum, f) => sum + f.length, 0);
        onProgress(totalDone, chunks.length);
      }
    }
    const flatFrames = allFrames.flat();
    flatFrames.sort((a, b) => a.globalIndex - b.globalIndex);
    return {
      frames: flatFrames,
      sourceTotalMs: demux.sourceTotalMs,
      totalInputFrames: chunks.length,
    };
  }

  // Streaming path: emit sorted frames per-batch, avoiding O(all frames) memory
  let totalCompleted = 0;
  for (let i = 0; i < segments.length; i += MAX_PARALLEL_DECODERS) {
    const batch = segments.slice(i, i + MAX_PARALLEL_DECODERS);
    const batchResults = await Promise.all(
      batch.map((seg) => decodeSegment(seg, demux.config, opts, signal))
    );
    // Flatten, sort, and emit this batch's frames, then discard
    const batchFrames = batchResults.flat().sort((a, b) => a.globalIndex - b.globalIndex);
    for (const frame of batchFrames) {
      await onFrame(frame);
    }
    totalCompleted += batchFrames.length;
    if (onProgress) {
      onProgress(totalCompleted, chunks.length);
    }
  }

  logger.info('decoders', 'Parallel decode complete', {
    segments: segments.length,
    totalFrames: totalCompleted,
    totalInput: chunks.length,
    mode: 'streaming',
  });

  return {
    frames: [], // streaming — frames emitted via onFrame callback
    sourceTotalMs: demux.sourceTotalMs,
    totalInputFrames: chunks.length,
  };
}
