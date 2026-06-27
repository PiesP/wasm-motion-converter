// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Main Thread Proxy — provides a drop-in async interface for the worker pipeline.
 *
 * Wraps Worker lifecycle (create, communicate, terminate) and provides
 * an async function matching the current pipeline signature:
 *   runPipeline(inputBuffer, config, options, callbacks) → Promise<ArrayBuffer>
 *
 * Features:
 * - Transfers inputBuffer (zero-copy to worker)
 * - Throttled progress callbacks to the main thread
 * - Graceful fallback to main-thread pipeline on worker errors
 * - AbortController propagation to the worker
 */

import type { ConversionProgress } from '@t/conversion-types';
import { WORKER_MAX_MEMORY_MB } from '@utils/constants.js';

import type {
  SerializedConversionOptions,
  SerializedDecoderConfig,
  WorkerRequest,
  WorkerResponse,
} from './types.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface MainThreadPipelineOptions {
  /** Serialized decoder config from the demuxer */
  config: SerializedDecoderConfig;
  /** Conversion options */
  options: SerializedConversionOptions;
}

export type MainThreadPipelineCallback = (progress: ConversionProgress) => void;

/**
 * Runs the conversion pipeline via a Web Worker.
 *
 * @param inputBuffer - The video file buffer (will be transferred to worker)
 * @param config - Serialized video decoder configuration
 * @param options - Conversion options (format, quality, scale, etc.)
 * @param onProgress - Progress callback (throttled to ~100ms)
 * @param signal - Abort signal for cancellation
 * @returns Promise resolving to the output ArrayBuffer (GIF or WebP)
 */
export async function runPipelineViaWorker(
  inputBuffer: ArrayBuffer,
  config: SerializedDecoderConfig,
  options: SerializedConversionOptions,
  onProgress: MainThreadPipelineCallback,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const requestId = crypto.randomUUID();

    // Create the worker
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

    // Throttle progress callbacks to ~100ms
    let lastProgressTime = 0;
    const throttledProgress = (update: ConversionProgress) => {
      const now = performance.now();
      if (now - lastProgressTime >= 100) {
        lastProgressTime = now;
        onProgress(update);
      }
    };

    // Set up abort signal forwarding
    const onAbort = () => {
      const abortMsg: WorkerRequest = {
        type: 'abort',
        requestId,
      };
      worker.postMessage(abortMsg);
    };

    if (signal) {
      if (signal.aborted) {
        // Already aborted
        worker.terminate();
        reject(new DOMException('Cancelled', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    // Handle messages from the worker
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;

      switch (response.type) {
        case 'progress': {
          throttledProgress({
            phase: response.phase as ConversionProgress['phase'],
            progress: response.percent,
            fps: response.fps,
            etaSeconds: null,
            memoryMB: response.memoryMB,
            currentFrame: response.currentFrame,
            totalFrames: response.totalFrames,
            elapsedMs: response.elapsedMs,
          });
          break;
        }

        case 'complete': {
          // Clean up
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
          // Defer terminate() to next microtask to ensure the transferred
          // outputBuffer is fully received before the worker is terminated.
          // Calling terminate() synchronously can race with buffer transfer.
          queueMicrotask(() => {
            worker.terminate();
          });

          // The response.outputBuffer is transferred back by the worker
          // via postMessage transferables — ownership moves to main thread.
          resolve(response.outputBuffer);
          break;
        }

        case 'error': {
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
          worker.terminate();

          if (response.code === 'CANCELLED') {
            reject(new DOMException('Cancelled', 'AbortError'));
          } else {
            reject(new Error(`Worker error: ${response.message}`));
          }
          break;
        }

        case 'log': {
          // Forward worker logs to console (can be customized)
          console.info(`[Worker] [${response.level}] ${response.message}`);
          break;
        }

        default: {
          // Exhaustive check
          const _exhaustiveCheck: never = response;
          void _exhaustiveCheck;
          break;
        }
      }
    };

    // Handle worker errors
    worker.onerror = (error) => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      worker.terminate();
      reject(new Error(`Worker error: ${error.message}`));
    };

    // Send the start message with transferable inputBuffer
    const startMsg: WorkerRequest = {
      type: 'start',
      requestId,
      inputBuffer,
      config,
      options,
    };
    worker.postMessage(startMsg, [inputBuffer]);
  });
}

/**
 * Worker-enabled pipeline interface that matches the existing pipeline signature.
 *
 * Use this as a drop-in replacement for runConversionPipeline when you want
 * to offload the conversion to a Web Worker.
 *
 * Falls back to the main-thread pipeline if Worker creation fails
 * (e.g., CSP violations, file:// protocol).
 */
export async function runPipelineWithFallback(
  inputBuffer: ArrayBuffer,
  config: SerializedDecoderConfig,
  options: SerializedConversionOptions,
  onProgress: MainThreadPipelineCallback,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  try {
    return await runPipelineViaWorker(inputBuffer, config, options, onProgress, signal);
  } catch (workerError) {
    // If the error is a cancellation, don't fall back — propagate it
    if (workerError instanceof DOMException && workerError.name === 'AbortError') {
      throw workerError;
    }

    // Fall back to main thread
    console.warn('[WorkerPipeline] Worker failed, falling back to main thread:', workerError);

    // Dynamic import to avoid circular dependencies
    const { runConversionPipeline } = await import('../conversion-pipeline.js');

    // We need to reconstruct a full ConversionRequest for the main thread pipeline
    // This is a simplified version — the worker path should handle most cases
    const request = {
      inputBuffer,
      fileName: 'input.webm',
      format: options.format,
      quality: options.quality,
      scale: options.scale,
      trimStart: options.trimStart,
      trimEnd: options.trimEnd,
      maxMemoryMB: WORKER_MAX_MEMORY_MB,
      forceDecimation: options.forceDecimation ?? 1,
      smartFrameSkip: options.smartFrameSkip ?? 'off',
    };

    return runConversionPipeline(request, onProgress, signal);
  }
}
