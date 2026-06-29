// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Parallel WebP Encoder using Worker Pool
 *
 * Decodes frames on the main thread (VideoDecoder requires it), then distributes
 * each frame's RGB data to a pool of Web Workers for parallel OffscreenCanvas
 * WebP encoding. Results are collected in order and muxed into an animated WebP.
 *
 * Architecture:
 * - Main thread: demux → decode (VideoDecoder) → distribute RGB to workers
 * - Worker threads: RGB → OffscreenCanvas → convertToBlob → VP8 bitstream
 * - Main thread: collect VP8 bitstreams in order → mux with StreamingWebpMuxer
 */

import type { ProgressCallback } from '@t/conversion-types';
import { logger } from '@utils/logger';
import { globalBufferPool } from './buffer-pool';
import { decodeFrames } from './decoder-service';
import type { DemuxResult } from './demuxer-service';
import { createDynamicDecimationController } from './dynamic-decimation-controller';
import type { BaseEncoderOptions } from './encoder-common';
import { StreamingWebpMuxer } from './streaming-webp-encoder';
import { type EncodeTask, type EncodeTaskResult, getWorkerPool } from './worker-pool';

/**
 * Quality parameter (0.0–1.0 float) for browser OffscreenCanvas WebP encoder.
 * Same mapping as in offscreen-webp-encoder.ts.
 */
const WORKER_QUALITY_MAP: Record<BaseEncoderOptions['quality'], number> = {
  low: 0.6,
  medium: 0.75,
  high: 0.85,
};

/**
 * Minimum frames required to benefit from worker parallelism.
 * For very small frame counts, worker overhead exceeds parallel gains.
 */
const MIN_FRAMES_FOR_PARALLEL = 5;

/**
 * Encoding result with bitstream and timing info.
 */
interface FrameEncodeResult {
  bitstream: Uint8Array;
  durationMs: number;
  encodeIdx: number;
}

/**
 * Encode demuxed video frames to animated WebP using a Worker pool.
 *
 * Falls back to main-thread encoding if:
 * - Worker pool is unavailable (unsupported environment)
 * - Frame count is too low (< MIN_FRAMES_FOR_PARALLEL)
 * - Any worker error occurs (logged, then fallback)
 *
 * @param demux - Demuxed video data
 * @param opts - Encoder options
 * @param onProgress - Progress callback
 * @param signal - Abort signal
 * @returns Uint8Array of animated WebP
 */
export async function encodeWebpParallel(
  demux: DemuxResult,
  opts: BaseEncoderOptions,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const w = Math.floor(opts.width * opts.scale);
  const h = Math.floor(opts.height * opts.scale);
  const quality = WORKER_QUALITY_MAP[opts.quality];
  const frameDecimation = opts.frameDecimation ?? 1;

  // Get worker pool — may be null if unsupported
  const pool = getWorkerPool();

  // Check if parallel encoding is worthwhile
  const estimatedFrames = Math.ceil(demux.totalFrames / frameDecimation);
  const useParallel = pool !== null && estimatedFrames >= MIN_FRAMES_FOR_PARALLEL;

  if (!useParallel) {
    logger.info('encoders', '  │  ├─ WebP: Parallel encoding NOT used', {
      reason: !pool ? 'no pool available' : `too few frames: ${estimatedFrames}`,
      fallback: 'main-thread OffscreenCanvas',
    });
    // Dynamic import to avoid circular dependency and keep tree-shaking
    const { encodeWebpOffscreen } = await import('./offscreen-webp-encoder');
    return encodeWebpOffscreen(demux, opts, onProgress, signal);
  }

  logger.info('encoders', '  │  ├─ WebP: Parallel Worker encoding', {
    resolution: `${w}×${h}`,
    quality,
    frameDecimation,
    estimatedFrames,
    poolSize: pool!.stats.poolSize,
  });

  const startTime = performance.now();
  const muxer = new StreamingWebpMuxer(w, h);
  let totalInputFrames = 0;
  let encodeIdx = 0;
  const decimationController = createDynamicDecimationController();

  // Frame buffer: collect RGB data and durations until we can dispatch in order.
  // Key insight: WebP muxing requires frames IN ORDER, but workers may complete
  // out-of-order. We maintain an in-order dispatch: frame N is dispatched before
  // frame N+1, and results are collected in order.
  //
  // Strategy: We use a sequential pipeline — dispatch frames 1,2,3... to the pool.
  // The pool internally queues them to idle workers. We collect results as they
  // come and handle out-of-order arrival with a reorder buffer.

  // Pending results (out-of-order collection)
  const resultBuffer = new Map<number, FrameEncodeResult>();
  let nextExpectedId = 0; // Next frame ID to write to muxer

  // Track frames that are in-flight (submitted to pool but not yet completed)
  const pendingPromises: Array<Promise<EncodeTaskResult>> = [];

  // Decode with streaming callback to feed workers
  const { totalInputFrames: totalDecoded, skippedByDecimation: totalSkipped } = await decodeFrames(
    demux,
    {
      width: w,
      height: h,
      frameDecimation,
      hwAccel: 'prefer-hardware',
      smartFrameSkip: opts.smartFrameSkip,
      onFrameDecoded: (_frameNum, total) => {
        totalInputFrames = total;
      },
      onFrameAvailable: async (rgbData: Uint8Array, frameDurationMs: number, _frameNum: number) => {
        if (signal?.aborted) {
          globalBufferPool.release(rgbData);
          throw new DOMException('Cancelled', 'AbortError');
        }

        // ── Dynamic decimation based on memory pressure ──
        const shouldSkip = decimationController.shouldSkip(_frameNum);
        if (shouldSkip) {
          globalBufferPool.release(rgbData);
          return;
        }

        const currentEncodeId = encodeIdx++;
        const isFirstFrame = currentEncodeId === 0;

        // Clone RGB data for transfer (the pool takes ownership via transfer)
        // We need to send a copy since we may need to release the original
        const rgbCopy = new Uint8Array(rgbData);
        globalBufferPool.release(rgbData);

        const task: EncodeTask = {
          id: currentEncodeId,
          rgbData: rgbCopy,
          width: w,
          height: h,
          quality,
          durationMs: frameDurationMs,
          isFirstFrame,
        };

        // Submit to worker pool
        const encodePromise = pool!
          .encode(task)
          .then((result: EncodeTaskResult) => {
            // Store result in reorder buffer
            resultBuffer.set(result.id, {
              bitstream: result.bitstream,
              durationMs: frameDurationMs,
              encodeIdx: result.id,
            });

            // Try to flush in-order results to muxer
            flushResultsToMuxer();

            // Report progress
            if (onProgress) {
              const completedFrames = resultBuffer.size;
              const encodePct =
                totalInputFrames > 0 ? Math.round((completedFrames / totalInputFrames) * 40) : 0;
              onProgress({
                phase: 'encoding',
                progress: 50 + Math.min(40, encodePct),
                fps: 0,
                etaSeconds: null,
                memoryMB: 0,
                currentFrame: completedFrames,
                totalFrames: totalInputFrames,
              });
            }

            return result;
          })
          .catch((err: Error) => {
            logger.error('encoders', 'Worker encode failed', {
              encodeId: currentEncodeId,
              error: err.message,
            });
            // Mark as failed — we'll produce a placeholder or skip
            resultBuffer.set(currentEncodeId, {
              bitstream: new Uint8Array(0),
              durationMs: frameDurationMs,
              encodeIdx: currentEncodeId,
            });
            throw err;
          });

        pendingPromises.push(encodePromise);
      },
    },
    signal
  );

  totalInputFrames = totalDecoded;

  // Wait for all pending encodings to complete
  await Promise.allSettled(pendingPromises);

  // Flush any remaining results in order
  flushResultsToMuxer(true);

  function flushResultsToMuxer(finalFlush = false): void {
    while (resultBuffer.has(nextExpectedId)) {
      const result = resultBuffer.get(nextExpectedId)!;
      resultBuffer.delete(nextExpectedId);

      if (result.bitstream.length > 0) {
        muxer.addFrame(result.bitstream, result.durationMs);
      }

      nextExpectedId++;
    }

    if (finalFlush && resultBuffer.size > 0) {
      logger.warn('encoders', 'Orphaned frames in result buffer', {
        orphanedCount: resultBuffer.size,
        nextExpectedId,
      });
      // Add remaining frames in order
      const ids = [...resultBuffer.keys()].sort((a, b) => a - b);
      for (const id of ids) {
        const result = resultBuffer.get(id)!;
        if (result.bitstream.length > 0) {
          muxer.addFrame(result.bitstream, result.durationMs);
        }
      }
      resultBuffer.clear();
    }
  }

  if (muxer.frames === 0) {
    throw new Error('No frames encoded for WebP parallel encoding');
  }

  // Mux all encoded frames into animated WebP container
  const result = muxer.finish();
  const totalElapsed = (performance.now() - startTime) / 1000;

  const poolStats = pool!.stats;
  logger.info('encoders', 'Parallel WebP encoding complete', {
    decodedFrames: totalInputFrames,
    keptFrames: muxer.frames,
    totalFrames: demux.totalFrames,
    frameDecimation,
    outputBytes: result.length,
    fps: Math.round(muxer.frames / totalElapsed),
    duration: `${totalElapsed.toFixed(2)}s`,
    resolution: `${w}×${h}`,
    quality,
    skippedByDecimation: totalSkipped,
    dynamicSkipCount: decimationController.getSkipCount(),
    poolStats,
  });

  return result;
}
