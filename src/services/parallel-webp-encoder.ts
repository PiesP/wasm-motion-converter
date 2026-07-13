// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Parallel WebP Encoder — encoding only (no decoding).
 *
 * Receives pre-decoded RGB frames and distributes them to a pool of
 * Web Workers for parallel OffscreenCanvas WebP encoding. Results are
 * collected in order and muxed into an animated WebP container.
 *
 * Decoding must happen on the main thread (VideoDecoder requirement).
 * The caller is responsible for feeding RGB frames via submit().
 *
 * Falls back to main-thread encoding if Worker pool is unavailable.
 *
 * Backpressure: submit() is async and limits in-flight frames to
 * MAX_IN_FLIGHT (2× pool size). When the limit is reached, the caller
 * awaits until a slot opens. This prevents unbounded growth of both
 * the pending promise array and the worker queue when the decoder
 * produces frames faster than workers can encode them.
 */

import type { ProgressCallback } from '@t/conversion-types';
import { logger } from '@utils/logger';
import type { BaseEncoderOptions } from './encoder-common';
import { StreamingWebpMuxer } from './streaming-webp-encoder';
import type { EncodeTask, EncodeTaskResult } from './worker-pool';
import { getWorkerPool, WebpWorkerPool } from './worker-pool';

const WORKER_QUALITY_MAP: Record<BaseEncoderOptions['quality'], number> = {
  low: 0.6,
  medium: 0.75,
  high: 0.85,
};

interface FrameEncodeResult {
  bitstream: Uint8Array;
  durationMs: number;
  encodeIdx: number;
}

/**
 * Streaming variant of encodeWebpParallel: frames are submitted one at a time
 * instead of collecting all into an array first. submit() is async and applies
 * backpressure when in-flight frames reach the limit.
 *
 * @returns { submit, finish } — submit frames during decode, call finish after
 */
export function createStreamingWebpEncoder(
  width: number,
  height: number,
  quality: BaseEncoderOptions['quality'],
  totalFrames: number,
  onProgress?: ProgressCallback
): {
  submit: (rgbData: Uint8Array, durationMs: number) => Promise<void>;
  finish: () => Promise<Uint8Array>;
  /** Pad the last frame's duration (for tail-accumulated durations from decimation/smart-skip). */
  padLastFrame: (extraMs: number) => void;
} {
  const qualityF = WORKER_QUALITY_MAP[quality];
  const pool = getWorkerPool(WebpWorkerPool.getOptimalWorkerCount(width, height));

  // Pool may be non-null but have 0 workers if all Worker() init attempts
  // failed (e.g. CSP blocks). The caller (conversion-pipeline) already gates
  // on pool.activeWorkers > 0, but we check here for defense-in-depth.
  if (!pool || pool.activeWorkers === 0) {
    throw new Error('Worker pool has no active workers');
  }

  const muxer = new StreamingWebpMuxer(width, height);
  const resultBuffer = new Map<number, FrameEncodeResult>();
  let nextExpectedId = 0;
  let submittedCount = 0;
  let failedCount = 0;
  const inFlight = new Set<Promise<EncodeTaskResult | void>>();

  // Cap in-flight frames at 2× pool size so that (a) each worker has one
  // frame encoding + one queued frame ready with no gap, and (b) backup
  // never grows unbounded even if encoding is slower than decoding.
  const MAX_IN_FLIGHT = pool ? pool.stats.poolSize * 2 : 4;

  function flushResultsToMuxer(finalFlush = false): void {
    while (resultBuffer.has(nextExpectedId)) {
      const r = resultBuffer.get(nextExpectedId)!;
      resultBuffer.delete(nextExpectedId);
      if (r.bitstream.length > 0) {
        muxer.addFrame(r.bitstream, r.durationMs);
      }
      nextExpectedId++;
    }
    // On final flush, also write any remaining out-of-order results
    if (finalFlush && resultBuffer.size > 0) {
      const remaining = [...resultBuffer.entries()].sort(([a], [b]) => a - b);
      for (const [, r] of remaining) {
        if (r.bitstream.length > 0) {
          muxer.addFrame(r.bitstream, r.durationMs);
        }
      }
      resultBuffer.clear();
    }
  }

  // Helper: wait for at least one in-flight promise to complete (backpressure).
  async function waitForSlot(): Promise<void> {
    while (inFlight.size >= MAX_IN_FLIGHT) {
      await Promise.race([...inFlight]);
    }
  }

  const submit = async (rgbData: Uint8Array, durationMs: number): Promise<void> => {
    // Backpressure: wait if we have too many frames in-flight
    await waitForSlot();

    const id = submittedCount++;

    const task: EncodeTask = {
      id,
      rgbData, // ownership transferred to pool (postMessage transfers buffer)
      width,
      height,
      quality: qualityF,
      durationMs,
    };

    const promise = pool!
      .encode(task)
      .then((result: EncodeTaskResult) => {
        resultBuffer.set(result.id, {
          bitstream: result.bitstream,
          durationMs,
          encodeIdx: result.id,
        });
        flushResultsToMuxer();

        if (onProgress) {
          const completedFrames = nextExpectedId;
          const encodePct = totalFrames > 0 ? Math.round((completedFrames / totalFrames) * 40) : 0;
          onProgress({
            phase: 'encoding',
            progress: 50 + Math.min(40, encodePct),
            fps: 0,
            etaSeconds: null,
            memoryMB: 0,
            currentFrame: completedFrames,
            totalFrames,
          });
        }

        return result;
      })
      .catch((err: Error) => {
        failedCount++;
        logger.warn('encoders', 'worker-encode-failed', { encodeId: id, error: err.message });
        // Don't rethrow — let remaining frames complete.
        // finish() will throw if ALL frames failed.
      })
      .finally(() => {
        // Self-clean: remove from in-flight set when settled
        inFlight.delete(promise);
      });

    inFlight.add(promise);
  };

  const finish = async (): Promise<Uint8Array> => {
    await Promise.allSettled([...inFlight]);
    flushResultsToMuxer(true);

    if (muxer.frames === 0) {
      if (failedCount > 0) {
        throw new Error(`All ${failedCount} submitted frames failed to encode`);
      }
      throw new Error('No frames encoded for streaming WebP encoding');
    }

    if (failedCount > 0) {
      logger.warn('encoders', 'Some frames failed to encode in streaming WebP', {
        failed: failedCount,
        total: submittedCount,
      });
    }

    return muxer.finish();
  };

  const padLastFrame = (extraMs: number): void => {
    muxer.padLastFrameDuration(extraMs);
  };

  return { submit, finish, padLastFrame };
}
