// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Parallel WebP Encoder — encoding only (no decoding).
 *
 * Receives pre-decoded opaque RGBA frames and distributes them to a pool of
 * Web Workers for parallel OffscreenCanvas WebP encoding. Results are
 * collected in order and muxed into an animated WebP container.
 *
 * The current caller decodes outside this encoding pool and is responsible for
 * feeding RGBA frames via submit().
 *
 * The pipeline selects a main-thread fallback before calling this function when
 * the Worker pool is unavailable.
 *
 * Backpressure bounds frames that have been accepted but not yet muxed by both
 * a queue limit and the shared live-frame byte budget.
 */

import type { ProgressCallback } from '@t/conversion-types';
import { getCanvasWebpQuality } from '@utils/constants';
import { logger } from '@utils/logger';
import { globalBufferPool } from './buffer-pool';
import type { BaseEncoderOptions } from './encoder-common';
import {
  type FrameMemoryHandoff,
  type FrameMemoryReservation,
  WebpFrameMemoryBudget,
} from './frame-memory';
import type { OutputLimitOverrides } from './output-limits';
import { StreamingWebpMuxer } from './streaming-webp-encoder';
import type { EncodeTask, EncodeTaskResult, WebpWorkerPool } from './worker-pool';

interface FrameEncodeResult {
  bitstream: Uint8Array;
  durationMs: number;
}

export interface StreamingWebpEncoder {
  submit: (
    rgbaData: Uint8Array,
    durationMs: number,
    memoryHandoff?: FrameMemoryHandoff
  ) => Promise<void>;
  finish: () => Promise<Uint8Array>;
  /** Signals the first asynchronous worker failure to the decoder immediately. */
  failureSignal: AbortSignal;
  /** Pad the last frame's duration (for tail-accumulated durations from decimation/smart-skip). */
  padLastFrame: (extraMs: number) => void;
  /** Release conversion-scoped reservations after the Worker pool is terminated. */
  dispose: () => void;
}

interface OutstandingTask {
  reservation: FrameMemoryReservation;
  state: 'active' | 'result';
}

/**
 * Streaming variant of encodeWebpParallel: frames are submitted one at a time
 * instead of collecting all into an array first. submit() resolves after bounded
 * ownership is accepted; finish() awaits encoding and ordered mux completion.
 *
 * @returns { submit, finish } — submit frames during decode, call finish after
 */
export function createStreamingWebpEncoder(
  pool: WebpWorkerPool,
  width: number,
  height: number,
  quality: BaseEncoderOptions['quality'],
  totalFrames: number,
  onProgress?: ProgressCallback,
  limits?: OutputLimitOverrides,
  signal?: AbortSignal,
  sharedMemoryBudget?: WebpFrameMemoryBudget
): StreamingWebpEncoder {
  const qualityF = getCanvasWebpQuality(quality);

  // The caller owns this conversion-scoped pool and its teardown. A pool may
  // still have 0 workers if all Worker() init attempts failed (e.g. CSP blocks).
  if (pool.activeWorkers === 0) {
    throw new Error('Worker pool has no active workers');
  }

  const muxer = new StreamingWebpMuxer(width, height, limits);
  const resultBuffer = new Map<number, FrameEncodeResult>();
  let nextExpectedId = 0;
  let submittedCount = 0;
  let firstEncodeError: Error | null = null;
  let pendingTailMs = 0;
  const inFlight = new Set<Promise<EncodeTaskResult | void>>();
  const outstandingTasks = new Map<number, OutstandingTask>();
  const failureController = new AbortController();
  let admissionBusy = false;
  const admissionWaiters: Array<{
    reject: (error: unknown) => void;
    resolve: () => void;
  }> = [];
  const ownsMemoryBudget = sharedMemoryBudget === undefined;
  const memoryBudget =
    sharedMemoryBudget ??
    new WebpFrameMemoryBudget({
      codedWidth: width,
      codedHeight: height,
      displayWidth: width,
      displayHeight: height,
      targetWidth: width,
      targetHeight: height,
      workerCount: pool.activeWorkers,
      sourceHeadroomFrames: 1,
    });
  const maxOutstanding = memoryBudget.maxOutstandingTasks;

  const cancellationError = (): unknown =>
    signal?.reason ?? new DOMException('Cancelled', 'AbortError');

  const handleAbort = (): void => {
    const error = cancellationError();
    memoryBudget.closeTargetGate(error);
    for (const waiter of admissionWaiters.splice(0)) waiter.reject(error);
  };
  if (signal?.aborted) handleAbort();
  else signal?.addEventListener('abort', handleAbort, { once: true });

  const acquireAdmission = async (): Promise<void> => {
    if (signal?.aborted) throw cancellationError();
    if (!admissionBusy) {
      admissionBusy = true;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      admissionWaiters.push({ reject, resolve });
    });
  };

  const releaseAdmission = (): void => {
    const next = admissionWaiters.shift();
    if (next) next.resolve();
    else admissionBusy = false;
  };

  const awaitWithCancellation = async <T>(work: Promise<T>): Promise<T> => {
    if (signal?.aborted) throw cancellationError();
    if (!signal) {
      return await work;
    }
    let removeAbortListener = (): void => {};
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          const onAbort = (): void => reject(cancellationError());
          removeAbortListener = () => signal.removeEventListener('abort', onAbort);
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      removeAbortListener();
    }
  };

  const awaitCapacityChange = async (): Promise<void> => {
    await awaitWithCancellation(Promise.race([...inFlight]));
  };

  const retainedResultBytes = (bitstream: Uint8Array): number =>
    bitstream.buffer instanceof ArrayBuffer ? bitstream.buffer.byteLength : bitstream.byteLength;

  function flushResultsToMuxer(): void {
    while (resultBuffer.has(nextExpectedId)) {
      const r = resultBuffer.get(nextExpectedId)!;
      if (r.bitstream.length > 0) {
        muxer.addFrame(r.bitstream, r.durationMs);
      }
      resultBuffer.delete(nextExpectedId);
      const task = outstandingTasks.get(nextExpectedId);
      task?.reservation.release();
      outstandingTasks.delete(nextExpectedId);
      nextExpectedId++;
    }
  }

  function discardCompletedResults(): void {
    resultBuffer.clear();
    for (const [id, task] of outstandingTasks) {
      if (task.state !== 'result') continue;
      task.reservation.release();
      outstandingTasks.delete(id);
    }
  }

  function recordEncodeFailure(error: unknown, encodeId: number): Error {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (!firstEncodeError) {
      firstEncodeError = normalized;
      failureController.abort(normalized);
      memoryBudget.closeTargetGate(normalized);
      discardCompletedResults();
    }
    logger.warn('encoders', 'worker-encode-failed', {
      encodeId,
      error: normalized.message,
    });
    return normalized;
  }

  const submit = async (
    rgbaData: Uint8Array,
    durationMs: number,
    memoryHandoff?: FrameMemoryHandoff
  ): Promise<void> => {
    let reservation: FrameMemoryReservation | null = null;
    let poolOwnsPixels = false;
    let admissionAcquired = false;
    try {
      await acquireAdmission();
      admissionAcquired = true;
      while (submittedCount - nextExpectedId >= maxOutstanding) {
        if (firstEncodeError) throw firstEncodeError;
        if (signal?.aborted) signal.throwIfAborted();
        if (inFlight.size === 0) {
          throw new Error('WebP encoder cannot advance the ordered result queue');
        }
        await awaitCapacityChange();
      }
      if (firstEncodeError) throw firstEncodeError;
      if (signal?.aborted) signal.throwIfAborted();

      reservation = memoryHandoff?.take() ?? (await memoryBudget.acquireTarget());
      if (firstEncodeError) throw firstEncodeError;
      if (signal?.aborted) signal.throwIfAborted();

      const id = submittedCount++;
      const task: EncodeTask = {
        id,
        rgbaData,
        width,
        height,
        quality: qualityF,
        durationMs,
      };
      outstandingTasks.set(id, { reservation, state: 'active' });

      const promise = pool
        .encode(task)
        .then((result: EncodeTaskResult) => {
          if (result.id !== id) {
            throw new Error(`Invalid WebP worker response for task ${id}`);
          }
          const outstanding = outstandingTasks.get(id);
          if (!outstanding || firstEncodeError) return result;
          const resultBytes = retainedResultBytes(result.bitstream);
          if (!outstanding.reservation.reserveResultBytes(resultBytes)) {
            throw new Error('WebP frame memory limit exceeded by encoded results');
          }
          outstanding.state = 'result';
          resultBuffer.set(result.id, {
            bitstream: result.bitstream,
            durationMs,
          });
          flushResultsToMuxer();

          if (onProgress) {
            const completedFrames = nextExpectedId;
            const encodePct =
              totalFrames > 0 ? Math.round((completedFrames / totalFrames) * 40) : 0;
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
        .catch((error: unknown) => {
          recordEncodeFailure(error, id);
        })
        .finally(() => {
          inFlight.delete(promise);
          const outstanding = outstandingTasks.get(id);
          if (outstanding?.state === 'active') {
            outstanding.reservation.release();
            outstandingTasks.delete(id);
          }
        });

      inFlight.add(promise);
      poolOwnsPixels = true;
    } catch (error) {
      reservation?.release();
      if (!poolOwnsPixels && rgbaData.byteLength > 0) globalBufferPool.release(rgbaData);
      throw error;
    } finally {
      if (admissionAcquired) releaseAdmission();
    }
  };

  const finish = async (): Promise<Uint8Array> => {
    await awaitWithCancellation(Promise.allSettled([...inFlight]));

    if (firstEncodeError) {
      discardCompletedResults();
      throw firstEncodeError;
    }

    flushResultsToMuxer();

    if (nextExpectedId !== submittedCount || resultBuffer.size > 0) {
      discardCompletedResults();
      throw new Error('WebP encoder finished with a missing ordered result');
    }

    if (muxer.frames === 0) {
      throw new Error('No frames encoded for streaming WebP encoding');
    }

    if (pendingTailMs > 0) {
      muxer.padLastFrameDuration(pendingTailMs);
      pendingTailMs = 0;
    }

    return await muxer.finish(signal);
  };

  const padLastFrame = (extraMs: number): void => {
    if (extraMs > 0) pendingTailMs += extraMs;
  };

  const dispose = (): void => {
    signal?.removeEventListener('abort', handleAbort);
    const disposedError = new Error('Streaming WebP encoder disposed');
    for (const waiter of admissionWaiters.splice(0)) waiter.reject(disposedError);
    admissionBusy = false;
    discardCompletedResults();
    for (const task of outstandingTasks.values()) task.reservation.release();
    outstandingTasks.clear();
    if (ownsMemoryBudget) memoryBudget.dispose();
  };

  return { submit, finish, failureSignal: failureController.signal, padLastFrame, dispose };
}
