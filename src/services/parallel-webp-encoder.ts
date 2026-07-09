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
 * Falls back to main-thread encoding if:
 * - Worker pool is unavailable (unsupported environment)
 * - Frame count is too low (< MIN_FRAMES_FOR_PARALLEL)
 * - Any worker error occurs (logged, then fallback)
 */

import type { ProgressCallback } from '@t/conversion-types';
import { logger } from '@utils/logger';
import { globalBufferPool } from './buffer-pool';
import type { BaseEncoderOptions } from './encoder-common';
import { reportEncodingProgress } from './encoding-progress-reporter';
import { convertRGBToRGBA } from './frame-utils';
import {
  extractVP8Bitstream,
  extractVP8BitstreamFast,
  StreamingWebpMuxer,
} from './streaming-webp-encoder';
import type { EncodeTask, EncodeTaskResult } from './worker-pool';
import { getWorkerPool } from './worker-pool';

const WORKER_QUALITY_MAP: Record<BaseEncoderOptions['quality'], number> = {
  low: 0.6,
  medium: 0.75,
  high: 0.85,
};

const MIN_FRAMES_FOR_PARALLEL = 5;

interface FrameEncodeResult {
  bitstream: Uint8Array;
  durationMs: number;
  encodeIdx: number;
}

/**
 * Encode pre-decoded RGB frames to animated WebP using Worker pool.
 *
 * @param frames - Array of { rgbData, durationMs } from decoder
 * @param width - Output width (after scale)
 * @param height - Output height (after scale)
 * @param quality - Quality preset
 * @param onProgress - Progress callback
 * @returns Uint8Array of animated WebP
 */
async function encodeWebpParallel(
  frames: Array<{ rgbData: Uint8Array; durationMs: number }>,
  width: number,
  height: number,
  quality: BaseEncoderOptions['quality'],
  onProgress?: ProgressCallback
): Promise<Uint8Array> {
  const qualityF = WORKER_QUALITY_MAP[quality];

  const pool = getWorkerPool();
  const useParallel = pool !== null && frames.length >= MIN_FRAMES_FOR_PARALLEL;

  if (!useParallel) {
    logger.info('encoders', '  │  ├─ WebP: Parallel encoding NOT used', {
      reason: !pool ? 'no pool available' : `too few frames: ${frames.length}`,
      fallback: 'main-thread OffscreenCanvas',
    });
    return encodeWebpMainThread(frames, width, height, qualityF, onProgress);
  }

  logger.info('encoders', '  │  ├─ WebP: Parallel Worker encoding', {
    resolution: `${width}×${height}`,
    quality: qualityF,
    frameCount: frames.length,
    poolSize: pool!.stats.poolSize,
  });

  const startTime = performance.now();
  const muxer = new StreamingWebpMuxer(width, height);
  const resultBuffer = new Map<number, FrameEncodeResult>();
  let nextExpectedId = 0;
  const pendingPromises: Array<Promise<EncodeTaskResult>> = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const isFirstFrame = i === 0;

    const task: EncodeTask = {
      id: i,
      rgbData: new Uint8Array(frame.rgbData),
      width,
      height,
      quality: qualityF,
      durationMs: frame.durationMs,
      isFirstFrame,
    };

    const encodePromise = pool!
      .encode(task)
      .then((result: EncodeTaskResult) => {
        resultBuffer.set(result.id, {
          bitstream: result.bitstream,
          durationMs: frame.durationMs,
          encodeIdx: result.id,
        });
        flushResultsToMuxer();

        if (onProgress) {
          const completedFrames = resultBuffer.size;
          reportEncodingProgress(onProgress, completedFrames, frames.length);
        }

        return result;
      })
      .catch((err: Error) => {
        logger.error('encoders', 'Worker encode failed', { encodeId: i, error: err.message });
        throw err;
      });

    pendingPromises.push(encodePromise);
  }

  await Promise.allSettled(pendingPromises);
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

  const result = muxer.finish();
  const totalElapsed = (performance.now() - startTime) / 1000;

  logger.info('encoders', 'Parallel WebP encoding complete', {
    keptFrames: muxer.frames,
    outputBytes: result.length,
    fps: Math.round(muxer.frames / totalElapsed),
    duration: `${totalElapsed.toFixed(2)}s`,
  });

  return result;
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

/**
 * Fallback: encode frames on main thread using OffscreenCanvas.
 */
async function encodeWebpMainThread(
  frames: Array<{ rgbData: Uint8Array; durationMs: number }>,
  width: number,
  height: number,
  quality: number,
  onProgress?: ProgressCallback
): Promise<Uint8Array> {
  const muxer = new StreamingWebpMuxer(width, height);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to get 2D context');

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const pixelCount = width * height;
    const rawBuf = convertRGBToRGBA(frame.rgbData, width, height);
    // ImageData constructor requires ArrayBuffer or BufferSource — the pool
    // always returns Uint8Array backed by ArrayBuffer, so casting is safe.
    const rgbaData = new Uint8ClampedArray(
      rawBuf.buffer as ArrayBuffer,
      rawBuf.byteOffset,
      pixelCount * 4
    ) as unknown as Uint8ClampedArray<ArrayBuffer>;

    const imageData = new ImageData(rgbaData, width, height);
    ctx.putImageData(imageData, 0, 0);
    globalBufferPool.release(rawBuf);

    const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
    const webpBuffer = new Uint8Array(await blob.arrayBuffer());

    const bitstream =
      i === 0 ? extractVP8Bitstream(webpBuffer) : extractVP8BitstreamFast(webpBuffer);

    muxer.addFrame(bitstream, frame.durationMs);

    reportEncodingProgress(onProgress, i + 1, frames.length);
  }

  return muxer.finish();
}
