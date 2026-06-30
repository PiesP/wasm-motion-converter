// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Pipeline Worker — runs the full conversion pipeline inside a Web Worker.
 *
 * This module is the entry point for worker-side conversion logic.
 * It reuses the existing decoder-service, encoder-service, and frame-utils
 * but replaces requestAnimationFrame with setTimeout(0) and handles the
 * fact that performance.memory is unavailable in Workers.
 */

import type { ConversionRequest } from '@t/conversion-types.js';
import {
  DEFAULT_FPS,
  GIF_TARGET_FPS,
  WEBP_TARGET_FPS,
  WORKER_MAX_MEMORY_LIMIT_MB,
  WORKER_MAX_MEMORY_MB,
  WORKER_MIN_MEMORY_MB,
} from '@utils/constants.js';
import { logger } from '@utils/logger.js';
import { globalBufferPool } from '../buffer-pool.js';
import { demuxVideo } from '../demuxer-service.js';
import { calcAutoDecimation } from '../encoder-common.js';
import { encodeGif } from '../gif-encoder-service.js';
import { encodeWebp } from '../webp-encoder-service.js';
import { restoreVideoDecoderConfig } from './protocol.js';
import type {
  SerializedConversionOptions,
  SerializedDecoderConfig,
  WorkerResponse,
} from './types.js';

interface WorkerProgressState {
  lastPostTime: number;
  fpsTracker: { current: number; lastTime: number; lastFrame: number };
}

function createWorkerProgressTracker(): WorkerProgressState {
  return {
    lastPostTime: 0,
    fpsTracker: { current: 0, lastTime: performance.now(), lastFrame: 0 },
  };
}

/**
 * Clamps maxMemoryMB to valid bounds.
 * Ensures the value is within [WORKER_MIN_MEMORY_MB, WORKER_MAX_MEMORY_LIMIT_MB].
 */
function clampMaxMemoryMB(value: number): number {
  if (!Number.isFinite(value)) return WORKER_MAX_MEMORY_MB;
  return Math.min(WORKER_MAX_MEMORY_LIMIT_MB, Math.max(WORKER_MIN_MEMORY_MB, value));
}

// ─── Main Worker Pipeline ────────────────────────────────────────────────

/**
 * Runs the full conversion pipeline in a worker.
 * This mirrors the main-thread conversion-pipeline.ts but adapted for worker context.
 */
export async function runWorkerPipeline(
  inputBuffer: ArrayBuffer,
  config: SerializedDecoderConfig,
  options: SerializedConversionOptions,
  postMessage: (msg: WorkerResponse, transferables?: Transferable[]) => void,
  _signal?: AbortSignal
): Promise<ArrayBuffer> {
  const pipelineStart = performance.now();

  // Restore VideoDecoderConfig from serialized form
  restoreVideoDecoderConfig(config);

  // Build a ConversionRequest for the existing pipeline code
  const request: ConversionRequest = {
    inputBuffer,
    fileName: 'input.webm', // Worker doesn't have original filename
    format: options.format,
    quality: options.quality,
    scale: options.scale,
    trimStart: options.trimStart,
    trimEnd: options.trimEnd,
    maxMemoryMB: clampMaxMemoryMB(WORKER_MAX_MEMORY_MB),
    forceDecimation: options.forceDecimation ?? 1,
    smartFrameSkip: options.smartFrameSkip ?? 'off',
  };

  const progressState = createWorkerProgressTracker();

  // Post initial log
  postMessage({
    type: 'log',
    requestId: '',
    level: 'info',
    message: `Worker pipeline started: ${options.format} ${options.quality} ${options.scale}x`,
  });

  // ── Demux Phase ────────────────────────────────────────────
  let demuxResult: Awaited<ReturnType<typeof demuxVideo>>;
  try {
    demuxResult = await demuxVideo(request, undefined, (packetsExtracted) => {
      const now = performance.now();
      if (now - progressState.lastPostTime >= 100) {
        progressState.lastPostTime = now;
        postMessage({
          type: 'progress',
          requestId: '',
          phase: 'demuxing',
          percent: Math.min(10, Math.round(packetsExtracted / 10)),
          fps: 0,
          memoryMB: 0,
          currentFrame: packetsExtracted,
          totalFrames: 0,
        });
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    postMessage({
      type: 'error',
      requestId: '',
      message: `Demux failed: ${msg}`,
      code: 'DECODER_ERROR',
    });
    throw err;
  }

  const cfg = demuxResult.config;
  // Prioritize codedWidth/codedHeight — these are the actual pixel dimensions
  // from the VideoDecoderConfig and are always present for valid configs.
  // displayAspectWidth/Height and displayWidth/Height are only used as fallbacks
  // when coded dimensions are unavailable (extremely rare, indicates malformed config).
  const codedWidth =
    cfg.codedWidth ??
    (cfg as VideoDecoderConfig & { displayAspectWidth?: number }).displayAspectWidth ??
    (cfg as VideoDecoderConfig & { displayWidth?: number }).displayWidth;
  const codedHeight =
    cfg.codedHeight ??
    (cfg as VideoDecoderConfig & { displayAspectHeight?: number }).displayAspectHeight ??
    (cfg as VideoDecoderConfig & { displayHeight?: number }).displayHeight;
  if (!codedWidth || !codedHeight) {
    postMessage({
      type: 'error',
      requestId: '',
      message: 'Unable to determine video dimensions',
      code: 'DECODER_ERROR',
    });
    throw new Error('Unable to determine video dimensions');
  }

  // ── Decode + Encode Phase ──────────────────────────────────────
  let output: ArrayBuffer;

  const sourceFps = demuxResult.framerate ?? DEFAULT_FPS;

  const decodeProgressCb = (frameIdx: number, totalFrames: number) => {
    const now = performance.now();
    const deltaMs = now - progressState.fpsTracker.lastTime;
    const framesDelta = frameIdx - progressState.fpsTracker.lastFrame;
    progressState.fpsTracker.current =
      deltaMs > 0 && framesDelta > 0 ? Math.round(((framesDelta * 1000) / deltaMs) * 10) / 10 : 0;
    progressState.fpsTracker.lastTime = now;
    progressState.fpsTracker.lastFrame = frameIdx;

    // Throttle progress posts to ~100ms
    if (now - progressState.lastPostTime >= 100) {
      progressState.lastPostTime = now;
      const decodePct = totalFrames > 0 ? Math.round((frameIdx / totalFrames) * 40) : 0;
      postMessage({
        type: 'progress',
        requestId: '',
        phase: 'decoding',
        percent: 10 + Math.min(40, decodePct),
        fps: progressState.fpsTracker.current,
        memoryMB: 0,
        currentFrame: frameIdx,
        totalFrames,
      });
    }
  };

  if (options.format === 'gif') {
    const gifDecimation = calcAutoDecimation(
      sourceFps,
      GIF_TARGET_FPS,
      options.scale,
      options.forceDecimation
    );

    logger.info('encoders', 'GIF encoder (streaming decode→encode)', {
      codec: demuxResult.config.codec,
      codedWidth,
      codedHeight,
      totalFrames: demuxResult.totalFrames,
      sourceFps: Math.round(sourceFps),
      gifDecimation,
    });

    const gifResult = await encodeGif(
      demuxResult,
      {
        width: codedWidth,
        height: codedHeight,
        quality: options.quality,
        scale: options.scale,
        frameDecimation: gifDecimation,
        onFrameDecoded: decodeProgressCb,
        onFrameEncoded: (frameIdx: number, totalFrames: number) => {
          const now = performance.now();
          if (now - progressState.lastPostTime >= 100) {
            progressState.lastPostTime = now;
            const encodePct = totalFrames > 0 ? Math.round((frameIdx / totalFrames) * 40) : 0;
            postMessage({
              type: 'progress',
              requestId: '',
              phase: 'encoding',
              percent: 50 + Math.min(40, encodePct),
              fps: progressState.fpsTracker.current,
              memoryMB: 0,
              currentFrame: frameIdx,
              totalFrames,
            });
          }
        },
      },
      _signal
    );
    output = gifResult.buffer as ArrayBuffer;
  } else {
    const webpDecimation = calcAutoDecimation(
      sourceFps,
      WEBP_TARGET_FPS[options.quality],
      options.scale,
      options.forceDecimation
    );

    logger.info('encoders', 'WebP encoder (streaming encodeRGB + mux)', {
      codec: demuxResult.config.codec,
      codedWidth,
      codedHeight,
      totalFrames: demuxResult.totalFrames,
      sourceFps: Math.round(sourceFps),
      webpDecimation,
    });

    const webpResult = await encodeWebp(
      demuxResult,
      {
        width: codedWidth,
        height: codedHeight,
        quality: options.quality,
        scale: options.scale,
        frameDecimation: webpDecimation,
        onFrameDecoded: decodeProgressCb,
      },
      (p: { progress: number; currentFrame?: number }) => {
        const now = performance.now();
        if (now - progressState.lastPostTime >= 100) {
          progressState.lastPostTime = now;
          const mappedProgress = 50 + Math.round(p.progress * 0.4);
          postMessage({
            type: 'progress',
            requestId: '',
            phase: 'encoding',
            percent: Math.min(90, mappedProgress),
            fps: progressState.fpsTracker.current,
            memoryMB: 0,
            currentFrame: p.currentFrame ?? 0,
            totalFrames: demuxResult.totalFrames,
          });
        }
      },
      _signal
    );
    output = webpResult.buffer as ArrayBuffer;
  }

  // ── Assembly Phase ─────────────────────────────────────────────
  globalBufferPool.clear();

  const totalElapsedMs = Math.round(performance.now() - pipelineStart);
  postMessage({
    type: 'progress',
    requestId: '',
    phase: 'assembling',
    percent: 100,
    fps: 0,
    memoryMB: 0,
    currentFrame: demuxResult.totalFrames,
    totalFrames: demuxResult.totalFrames,
    elapsedMs: totalElapsedMs,
  });

  return output;
}
