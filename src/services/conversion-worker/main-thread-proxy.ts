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
 * - Timeout protection: terminates worker and rejects if conversion hangs
 */

import { getErrorMessage, isCancellationError } from '@piesp/browser-core/error';
import type { ConversionProgress } from '@t/conversion-types';
import { WORKER_MAX_MEMORY_MB, WORKER_PIPELINE_TIMEOUT_MS } from '@utils/constants';
import { logger } from '@utils/logger';
import { buildConversionRequest } from './build-conversion-request';
import { isWorkerResponse } from './guards';
import type {
  SerializedConversionOptions,
  SerializedDecoderConfig,
  WorkerRequest,
  WorkerResponse,
} from './types';

/**
 * Error thrown when a worker operation exceeds the timeout.
 */
export class WorkerTimeoutError extends Error {
  constructor(ms: number) {
    super(`Worker timed out after ${ms}ms`);
    this.name = 'WorkerTimeoutError';
  }
}

/** A worker reached its conservative memory budget and must not be retried. */
export class WorkerMemoryLimitError extends Error {
  constructor(message: string) {
    super(`Worker ran out of memory: ${message}`);
    this.name = 'WorkerMemoryLimitError';
  }
}

// ─── Types ────────────────────────────────────────────────────────────────

export type MainThreadPipelineCallback = (progress: ConversionProgress) => void;

/**
 * Runs the conversion pipeline via a Web Worker.
 *
 * @param inputBuffer - The video file buffer (will be transferred to worker)
 * @param inputBlob - Optional Blob/File for on-demand reading via BlobSource
 * @param config - Serialized decoder configuration
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
  signal?: AbortSignal,
  duration?: number,
  framerate?: number
): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const requestId = crypto.randomUUID();

    // Create the worker
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

    // Timeout guard: terminate worker and reject if it hangs
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      cleanup();
      worker.terminate();
      reject(new WorkerTimeoutError(WORKER_PIPELINE_TIMEOUT_MS));
    }, WORKER_PIPELINE_TIMEOUT_MS);

    // Clear timeout and remove abort listener — shared cleanup for all terminal paths
    const cleanup = () => {
      clearTimeout(timeoutId);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    // Throttle progress callbacks to ~100ms
    let lastProgressTime = 0;
    const throttledProgress = (update: ConversionProgress) => {
      const now = performance.now();
      if (now - lastProgressTime >= 100) {
        lastProgressTime = now;
        onProgress(update);
      }
    };

    // Set up abort signal forwarding.
    // The listener is registered BEFORE checking signal.aborted to eliminate
    // the timing window where the signal becomes aborted between the check
    // and listener registration (the handler would never fire, causing a
    // permanent hang).
    let settled = false;
    const onAbort = () => {
      if (settled || timedOut) return;
      settled = true;
      cleanup();
      worker.terminate();
      reject(new DOMException('Cancelled', 'AbortError'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        // Signal was already aborted — the { once: true } listener may have
        // fired synchronously during registration. The settled guard
        // prevents double rejection regardless.
        onAbort();
        return;
      }
    }

    // Handle messages from the worker
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      // Ignore messages after timeout — worker is already terminated
      if (timedOut) return;

      // Runtime guard: validate message shape before processing.
      // Malformed responses (null, arrays, primitives, missing fields)
      // are silently ignored.
      if (!isWorkerResponse(event.data)) return;

      const response = event.data;

      switch (response.type) {
        case 'progress': {
          throttledProgress({
            // phase is now the proper union type from WorkerResponse — no cast needed
            phase: response.phase,
            progress: response.percent,
            fps: response.fps,
            etaSeconds: response.etaSeconds ?? null,
            memoryMB: response.memoryMB,
            currentFrame: response.currentFrame,
            totalFrames: response.totalFrames,
            outputFrames: response.outputFrames,
            elapsedMs: response.elapsedMs,
          });
          break;
        }

        case 'complete': {
          cleanup();
          // Terminate immediately — transfer is complete once message received.
          // Deferring with queueMicrotask can race with consumer .then() handlers.
          worker.terminate();
          resolve(response.outputBuffer);
          break;
        }

        case 'error': {
          cleanup();
          worker.terminate();

          if (response.code === 'CANCELLED') {
            reject(new DOMException('Cancelled', 'AbortError'));
          } else if (response.code === 'OUT_OF_MEMORY') {
            reject(new WorkerMemoryLimitError(response.message));
          } else {
            reject(new Error(`Worker error: ${response.message}`));
          }
          break;
        }

        case 'log': {
          // Forward worker logs to console (can be customized)
          logger.info('general', 'worker.log-relay', {
            level: response.level,
            message: response.message,
          });
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
      if (timedOut) return;
      cleanup();
      worker.terminate();
      reject(new Error(`Worker error: ${error.message}`));
    };

    // Transfer the input buffer to the worker (zero-copy).
    // The main thread does NOT retain a copy — the fallback path in
    // runPipelineWithFallback uses inputBlob to re-read if needed.
    const startMsg: WorkerRequest = {
      type: 'start',
      requestId,
      inputBuffer,
      config,
      options,
      ...(duration !== undefined ? { duration } : {}),
      ...(framerate !== undefined ? { framerate } : {}),
    };
    try {
      worker.postMessage(startMsg, [inputBuffer]);
    } catch (error) {
      settled = true;
      cleanup();
      worker.terminate();
      reject(new Error(getErrorMessage(error)));
    }
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
  signal?: AbortSignal,
  inputBlob?: Blob,
  duration?: number,
  framerate?: number
): Promise<ArrayBuffer> {
  try {
    return await runPipelineViaWorker(
      inputBuffer,
      config,
      options,
      onProgress,
      signal,
      duration,
      framerate
    );
  } catch (workerError) {
    // If the error is a cancellation, don't fall back — propagate it
    if (isCancellationError(workerError) || workerError instanceof WorkerMemoryLimitError) {
      throw workerError;
    }

    // Fall back to main thread.
    // Since runPipelineViaWorker now transfers the original inputBuffer
    // (not a copy), the buffer will be detached.  Re-read from inputBlob
    // if available; otherwise throw — the fallback cannot proceed without
    // pixel data.
    let fallbackBuffer: ArrayBuffer;
    if (inputBuffer.byteLength === 0) {
      if (inputBlob) {
        logger.info('general', 'worker.fallback-re-reading-from-blob');
        fallbackBuffer = await inputBlob.arrayBuffer();
      } else {
        throw new Error(
          'Cannot fall back to main thread: inputBuffer is detached and no inputBlob available.'
        );
      }
    } else {
      fallbackBuffer = inputBuffer;
    }
    logger.warn('general', 'worker.fallback', { error: getErrorMessage(workerError) });

    // Dynamic import to avoid circular dependencies
    const { runConversionPipeline } = await import('../conversion-pipeline');

    const request = buildConversionRequest(
      fallbackBuffer,
      options,
      options.maxMemoryMB ?? WORKER_MAX_MEMORY_MB,
      inputBlob
    );

    return runConversionPipeline(request, onProgress, signal);
  }
}
