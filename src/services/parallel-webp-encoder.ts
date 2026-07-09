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
 * The caller is responsible for feeding RGB frames via encodeRGB().
 *
 * Falls back to main-thread encoding if Worker pool is unavailable.
 */

import type { ProgressCallback } from '@t/conversion-types';
import { logger } from '@utils/logger';
import type { BaseEncoderOptions } from './encoder-common';
import { StreamingWebpMuxer } from './streaming-webp-encoder';
import type { EncodeTask, EncodeTaskResult } from './worker-pool';
import { getWorkerPool } from './worker-pool';

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
 * instead of collecting all into an array first. Reduces peak memory by ~50%
 * for large videos and enables decode↔encode overlap.
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
  submit: (rgbData: Uint8Array, durationMs: number) => void;
  finish: () => Promise<Uint8Array>;
} {
  const qualityF = WORKER_QUALITY_MAP[quality];
  const pool = getWorkerPool();

  const muxer = new StreamingWebpMuxer(width, height);
  const resultBuffer = new Map<number, FrameEncodeResult>();
  let nextExpectedId = 0;
  let submittedCount = 0;
  const pendingPromises: Array<Promise<EncodeTaskResult>> = [];

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

  const submit = (rgbData: Uint8Array, durationMs: number): void => {
    const id = submittedCount++;
    const isFirstFrame = id === 0;

    const task: EncodeTask = {
      id,
      rgbData: new Uint8Array(rgbData), // copy before transfer
      width,
      height,
      quality: qualityF,
      durationMs,
      isFirstFrame,
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
        logger.error('encoders', 'Worker encode failed', { encodeId: id, error: err.message });
        throw err;
      });

    pendingPromises.push(promise);
  };

  const finish = async (): Promise<Uint8Array> => {
    await Promise.allSettled(pendingPromises);
    flushResultsToMuxer(true);

    if (muxer.frames === 0) {
      throw new Error('No frames encoded for streaming WebP encoding');
    }

    return muxer.finish();
  };

  return { submit, finish };
}
