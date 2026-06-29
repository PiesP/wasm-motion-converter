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
import type { BaseEncoderOptions } from './encoder-common';
import { extractVP8BitstreamFast, StreamingWebpMuxer } from './streaming-webp-encoder';
import { type EncodeTask, type EncodeTaskResult, getWorkerPool } from './worker-pool';

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
export async function encodeWebpParallel(
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
      rgbData: frame.rgbData,
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
          const encodePct =
            frames.length > 0 ? Math.round((completedFrames / frames.length) * 40) : 0;
          onProgress({
            phase: 'encoding',
            progress: 50 + Math.min(40, encodePct),
            fps: 0,
            etaSeconds: null,
            memoryMB: 0,
            currentFrame: completedFrames,
            totalFrames: frames.length,
          });
        }

        return result;
      })
      .catch((err: Error) => {
        logger.error('encoders', 'Worker encode failed', { encodeId: i, error: err.message });
        resultBuffer.set(i, {
          bitstream: new Uint8Array(0),
          durationMs: frame.durationMs,
          encodeIdx: i,
        });
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
    const rgbaData = new Uint8ClampedArray(pixelCount * 4);

    for (let j = 0, k = 0; j < frame.rgbData.length; j += 3, k += 4) {
      rgbaData[k] = frame.rgbData[j]!;
      rgbaData[k + 1] = frame.rgbData[j + 1]!;
      rgbaData[k + 2] = frame.rgbData[j + 2]!;
      rgbaData[k + 3] = 255;
    }

    const imageData = new ImageData(rgbaData, width, height);
    ctx.putImageData(imageData, 0, 0);

    const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
    const webpBuffer = new Uint8Array(await blob.arrayBuffer());

    const bitstream =
      i === 0 ? extractVP8FromMainThread(webpBuffer) : extractVP8BitstreamFast(webpBuffer);

    muxer.addFrame(bitstream, frame.durationMs);

    if (onProgress) {
      const encodePct = Math.round(((i + 1) / frames.length) * 40);
      onProgress({
        phase: 'encoding',
        progress: 50 + Math.min(40, encodePct),
        fps: 0,
        etaSeconds: null,
        memoryMB: 0,
        currentFrame: i + 1,
        totalFrames: frames.length,
      });
    }
  }

  return muxer.finish();
}

// Inline VP8 extraction for main thread fallback
function extractVP8FromMainThread(webpBuffer: Uint8Array): Uint8Array {
  if (webpBuffer.length < 24) throw new Error(`WebP too small: ${webpBuffer.length}`);

  const view = new DataView(webpBuffer.buffer, webpBuffer.byteOffset, webpBuffer.byteLength);

  if (view.getUint32(0, false) !== 0x52494646) throw new Error('Invalid RIFF');
  if (view.getUint32(8, false) !== 0x57454250) throw new Error('Invalid WEBP');

  const fourCC = view.getUint32(12, false);

  if (fourCC === 0x56503820) {
    const frameSize = view.getUint32(16, true);
    return webpBuffer.subarray(20, 20 + frameSize);
  }

  if (fourCC === 0x56503858) {
    const vp8xSize = view.getUint32(16, true);
    let offset = 12 + 8 + vp8xSize;
    while (offset + 8 <= webpBuffer.length) {
      const chunkFourCC = view.getUint32(offset, false);
      const chunkSize = view.getUint32(offset + 4, true);
      if (chunkFourCC === 0x56503820) {
        return webpBuffer.subarray(offset + 8, offset + 8 + chunkSize);
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
    throw new Error('VP8X without VP8 chunk');
  }

  throw new Error(`Unknown WebP: 0x${fourCC.toString(16)}`);
}
