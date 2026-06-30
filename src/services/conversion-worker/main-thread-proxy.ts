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

import type { ConversionProgress, ConversionRequest } from '@t/conversion-types';
import { WORKER_MAX_MEMORY_MB } from '@utils/constants.js';

import type {
  SerializedConversionOptions,
  SerializedDecoderConfig,
  WorkerRequest,
  WorkerResponse,
} from './types.js';

// ─── Timeout configuration ──────────────────────────────────────────────
// Worker timeout: allow up to 5 minutes for large videos at high quality.
// The worker is terminated if it produces no result within this window.
// (Browser-safe: import.meta.env.VITE_WORKER_TIMEOUT_MS or default)
const WORKER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Error thrown when a worker operation exceeds the timeout.
 */
export class WorkerTimeoutError extends Error {
  constructor(ms: number) {
    super(`Worker timed out after ${ms}ms`);
    this.name = 'WorkerTimeoutError';
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
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const requestId = crypto.randomUUID();

    // Create the worker
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

    // ── Timeout guard ──────────────────────────────────────────────────
    // If the worker hangs (e.g. infinite loop, deadlock in WASM), this
    // timer fires, terminates the worker, and rejects the promise.
    // The timer is cleared on any terminal message or external abort.
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      // Forward abort to the worker so it can clean up internal state
      const abortMsg: WorkerRequest = { type: 'abort', requestId };
      try {
        worker.postMessage(abortMsg);
      } catch {
        // Worker may already be in a bad state; terminate below regardless
      }
      worker.terminate();
      reject(new WorkerTimeoutError(WORKER_TIMEOUT_MS));
    }, WORKER_TIMEOUT_MS);

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

    // Set up abort signal forwarding
    const onAbort = () => {
      // External abort — clear the timeout since we're handling termination
      clearTimeout(timeoutId);
      const abortMsg: WorkerRequest = {
        type: 'abort',
        requestId,
      };
      worker.postMessage(abortMsg);
    };

    if (signal) {
      if (signal.aborted) {
        // Already aborted
        clearTimeout(timeoutId);
        worker.terminate();
        reject(new DOMException('Cancelled', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    // Handle messages from the worker
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      // Ignore messages after timeout — worker is already terminated
      if (timedOut) return;
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
          // Clear timeout — conversion finished successfully
          cleanup();
          // The response.outputBuffer is transferred back by the worker
          // via postMessage transferables — ownership moves to main thread.
          // Terminate immediately — the transfer is complete once we receive
          // the message, so no need to defer. Deferring with queueMicrotask
          // can race with consumer .then() handlers that expect the buffer
          // to still be valid.
          worker.terminate();
          resolve(response.outputBuffer);
          break;
        }

        case 'error': {
          cleanup();
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
      if (timedOut) return;
      cleanup();
      worker.terminate();
      reject(new Error(`Worker error: ${error.message}`));
    };

    // Transfer a copy of inputBuffer to the worker (zero-copy).
    // We copy via .slice(0) so we retain a fallback copy on the main thread,
    // then transfer that copy to the worker. This avoids keeping two full
    // copies alive simultaneously while still guaranteeing inputBuffer itself
    // is never detached — the fallback path below can safely use the original.
    const bufferCopy = inputBuffer.slice(0);
    const startMsg: WorkerRequest = {
      type: 'start',
      requestId,
      inputBuffer: bufferCopy,
      config,
      options,
    };
    worker.postMessage(startMsg, [bufferCopy]);
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
  inputBlob?: Blob
): Promise<ArrayBuffer> {
  try {
    return await runPipelineViaWorker(inputBuffer, config, options, onProgress, signal);
  } catch (workerError) {
    // If the error is a cancellation, don't fall back — propagate it
    if (workerError instanceof DOMException && workerError.name === 'AbortError') {
      throw workerError;
    }

    // Fall back to main thread.
    // Since runPipelineViaWorker transfers a *copy* (not the original),
    // inputBuffer should still be valid here. However, if the caller
    // already transferred inputBuffer elsewhere before this function was
    // invoked, inputBuffer would be detached and the fallback would
    // silently fail. Re-throw in that case so the error surfaces.
    if (inputBuffer.byteLength === 0) {
      throw new Error(
        'Cannot fall back to main thread: inputBuffer is detached (already transferred).'
      );
    }
    console.warn('[WorkerPipeline] Worker failed, falling back to main thread:', workerError);

    // Dynamic import to avoid circular dependencies
    const { runConversionPipeline } = await import('../conversion-pipeline.js');

    const request: ConversionRequest = {
      inputBuffer,
      inputBlob,
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
