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
import { getCanvasWebpQuality } from '@utils/constants';
import { logger } from '@utils/logger';
import { globalBufferPool } from './buffer-pool';
import type { BaseEncoderOptions } from './encoder-common';
import { StreamingWebpMuxer } from './streaming-webp-encoder';
import type { EncodeTask, EncodeTaskResult } from './worker-pool';
import { getWorkerPool, WebpWorkerPool } from './worker-pool';

interface FrameEncodeResult {
  bitstream: Uint8Array;
  durationMs: number;
  encodeIdx: number;
}

interface StreamingWebpEncoder {
  submit: (rgbData: Uint8Array, durationMs: number) => Promise<void>;
  finish: () => Promise<Uint8Array>;
  /** Signals the first asynchronous worker failure to the decoder immediately. */
  failureSignal: AbortSignal;
  /** Pad the last frame's duration (for tail-accumulated durations from decimation/smart-skip). */
  padLastFrame: (extraMs: number) => void;
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
): StreamingWebpEncoder {
  const qualityF = getCanvasWebpQuality(quality);
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
  let firstEncodeError: Error | null = null;
  let pendingTailMs = 0;
  const inFlight = new Set<Promise<EncodeTaskResult | void>>();
  const failureController = new AbortController();

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
      if (firstEncodeError) throw firstEncodeError;
    }
  }

  function throwIfFailed(rgbData: Uint8Array): void {
    if (!firstEncodeError) return;
    globalBufferPool.release(rgbData);
    throw firstEncodeError;
  }

  const submit = async (rgbData: Uint8Array, durationMs: number): Promise<void> => {
    throwIfFailed(rgbData);
    // Backpressure: wait if we have too many frames in-flight
    try {
      await waitForSlot();
    } catch (error) {
      globalBufferPool.release(rgbData);
      throw error;
    }
    throwIfFailed(rgbData);

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
        if (!firstEncodeError) {
          firstEncodeError = err;
          failureController.abort(err);
        }
        logger.warn('encoders', 'worker-encode-failed', { encodeId: id, error: err.message });
        // Existing in-flight work is drained by finish(); the failure signal stops
        // the decoder from feeding more chunks or submitting additional frames.
      })
      .finally(() => {
        // Self-clean: remove from in-flight set when settled
        inFlight.delete(promise);
      });

    inFlight.add(promise);
  };

  const finish = async (): Promise<Uint8Array> => {
    await Promise.allSettled([...inFlight]);

    if (firstEncodeError) {
      resultBuffer.clear();
      throw firstEncodeError;
    }

    flushResultsToMuxer(true);

    if (muxer.frames === 0) {
      throw new Error('No frames encoded for streaming WebP encoding');
    }

    if (pendingTailMs > 0) {
      muxer.padLastFrameDuration(pendingTailMs);
      pendingTailMs = 0;
    }

    return await muxer.finish();
  };

  const padLastFrame = (extraMs: number): void => {
    if (extraMs > 0) pendingTailMs += extraMs;
  };

  return { submit, finish, failureSignal: failureController.signal, padLastFrame };
}
