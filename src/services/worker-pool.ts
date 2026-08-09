// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Worker Pool for Parallel WebP Encoding
 *
 * Manages a pool of Web Workers that each encode frames to WebP via
 * OffscreenCanvas.convertToBlob(). The pool distributes frames to idle
 * workers, collects results in order, and handles worker lifecycle.
 *
 * Features:
 * - Automatic worker count based on navigator.hardwareConcurrency
 * - In-order result collection (frames may complete out-of-order)
 * - Graceful fallback: if Worker is unavailable, encode on main thread
 * - Transferable RGB data (zero-copy transfer to worker)
 * - Timeout-based task retirement for stalled workers
 */

import { getErrorMessage } from '@piesp/browser-core/error';
import { isRecord } from '@piesp/browser-core/util';
import { WEBP_WORKER_MAX_COUNT, WORKER_TIMEOUT_MS } from '@utils/constants';
import { logger } from '@utils/logger';
import { globalBufferPool } from './buffer-pool';

// ─── Types ─────────────────────────────────────────────────────────

export interface EncodeTask {
  id: number;
  rgbData: Uint8Array;
  width: number;
  height: number;
  quality: number;
  durationMs: number;
}

export interface EncodeTaskResult {
  id: number;
  bitstream: Uint8Array;
}

interface PendingTask {
  task: EncodeTask;
  resolve: (result: EncodeTaskResult) => void;
  reject: (error: Error) => void;
  submittedAt: number;
}

export interface WorkerCountCapabilities {
  hardwareConcurrency?: number | undefined;
  deviceMemory?: number | undefined;
}

export function calculateOptimalWorkerCount(
  capabilities: WorkerCountCapabilities | undefined,
  frameWidth?: number,
  frameHeight?: number
): number {
  let count = 1;
  if (!capabilities) return count;

  if (capabilities.hardwareConcurrency) {
    count = Math.min(WEBP_WORKER_MAX_COUNT, Math.max(1, capabilities.hardwareConcurrency - 1));
  } else {
    count = 2;
  }

  const { deviceMemory } = capabilities;
  if (typeof deviceMemory === 'number' && deviceMemory > 0) {
    if (deviceMemory <= 4) {
      count = Math.min(count, 2);
    } else if (deviceMemory <= 8) {
      count = Math.min(count, 4);
    }
  }

  if (frameWidth && frameHeight) {
    const pixels = frameWidth * frameHeight;
    if (pixels > 1920 * 1080) {
      count = Math.min(count, 2);
    } else if (pixels > 1280 * 720) {
      count = Math.min(count, 4);
    }
  }

  return count;
}

// ─── Worker Pool ───────────────────────────────────────────────────

export class WebpWorkerPool {
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private queue: PendingTask[] = [];
  private activeTasks: Map<Worker, PendingTask> = new Map();
  private terminated = false;
  private readonly size: number;
  private readonly timeoutMs: number;

  /**
   * @param size - Number of workers. Default: navigator.hardwareConcurrency - 1 (min 1).
   * @param timeoutMs - Max time (ms) before a task is considered stalled. Default: 30000.
   */
  constructor(size?: number, timeoutMs = WORKER_TIMEOUT_MS) {
    this.size = size ?? WebpWorkerPool.getOptimalWorkerCount();
    this.timeoutMs = timeoutMs;
    this.initWorkers();
  }

  /**
   * Get optimal worker count based on available CPU cores, device memory,
   * and frame resolution. Each worker requires an OffscreenCanvas (~w·h·4 bytes)
   * plus encoding overhead, so large frames need fewer concurrent workers.
   *
   * Caps applied in order (most restrictive wins):
   *   - CPU: hardwareConcurrency - 1, minimum 1, absolute maximum 4
   *   - Device memory: ≤4GB → 2, otherwise bounded by the absolute maximum
   *   - Frame resolution: >1080p → 2, >720p → 4
   */
  static getOptimalWorkerCount(frameWidth?: number, frameHeight?: number): number {
    const capabilities =
      typeof navigator === 'undefined'
        ? undefined
        : {
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
          };
    return calculateOptimalWorkerCount(capabilities, frameWidth, frameHeight);
  }

  /**
   * Check if Worker and OffscreenCanvas are available for parallel encoding.
   */
  static isSupported(): boolean {
    return (
      typeof Worker !== 'undefined' &&
      typeof OffscreenCanvas !== 'undefined' &&
      typeof createImageBitmap !== 'undefined'
    );
  }

  /**
   * Number of workers that were successfully initialized.
   * May be 0 if all Worker() constructor calls failed (e.g. CSP blocks,
   * network errors, or module load failures). Callers should check this
   * before routing tasks to the pool — a pool with 0 workers cannot
   * process any tasks and will reject every submission immediately.
   */
  get activeWorkers(): number {
    return this.workers.length;
  }

  private initWorkers(): void {
    for (let i = 0; i < this.size; i++) {
      try {
        const worker = this.createWorker();
        this.workers.push(worker);
        this.idleWorkers.push(worker);
      } catch (err) {
        logger.warn('encoders', 'worker-create-failed', {
          index: i,
          error: getErrorMessage(err),
        });
        // Continue with fewer workers — the caller (encodeWebpParallel) falls back
        // to main-thread encoding when pool is unavailable or has no workers.
      }
    }

    logger.info('encoders', 'Worker pool initialized', {
      poolSize: this.size,
      created: this.workers.length,
      optimalCount: WebpWorkerPool.getOptimalWorkerCount(),
    });
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL('./webp-encoder-worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent) => {
      this.handleWorkerMessage(worker, event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      this.handleWorkerError(worker, event);
    };
    return worker;
  }

  private handleWorkerMessage(worker: Worker, data: unknown): void {
    // Find the pending task that was assigned to this worker
    const pending = this.activeTasks.get(worker);
    if (!pending) {
      logger.warn('encoders', 'Worker message received but no active task found');
      return;
    }
    const { task } = pending;

    // Clear the timeout for this task (it completed successfully)
    const timeoutHandle = this.taskTimeouts.get(worker);
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
      this.taskTimeouts.delete(worker);
    }

    this.activeTasks.delete(worker);

    if (!isRecord(data) || data.id !== task.id || !Number.isSafeInteger(data.id)) {
      this.rejectInvalidWorkerResponse(worker, pending, task.id);
      return;
    }

    if (data.error !== undefined) {
      if (typeof data.error !== 'string' || data.error.length === 0) {
        this.rejectInvalidWorkerResponse(worker, pending, task.id);
        return;
      }
      pending.reject(new Error(`Worker encoding failed: ${data.error}`));
      this.releaseWorker(worker);
      return;
    }

    if (!(data.bitstream instanceof Uint8Array) || data.bitstream.byteLength === 0) {
      this.rejectInvalidWorkerResponse(worker, pending, task.id);
      return;
    }

    pending.resolve({ id: task.id, bitstream: data.bitstream });
    this.releaseWorker(worker);
  }

  private rejectInvalidWorkerResponse(
    worker: Worker,
    pending: PendingTask | undefined,
    taskId: number
  ): void {
    logger.warn('encoders', 'Invalid WebP worker response', { taskId });
    pending?.reject(new Error(`Invalid WebP worker response for task ${taskId}`));
    this.replaceWorker(worker);
  }

  private handleWorkerError(worker: Worker, event: ErrorEvent): void {
    logger.warn('encoders', 'worker-error', { message: event.message });

    const pending = this.activeTasks.get(worker);
    this.activeTasks.delete(worker);

    // Clear timeout for this task
    if (pending) {
      const timeoutHandle = this.taskTimeouts.get(worker);
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
        this.taskTimeouts.delete(worker);
      }
    }

    // Reject the pending task
    if (pending) {
      pending.reject(new Error(`Worker error: ${event.message}`));
    }

    // Replace dead worker (with try/catch inside replaceWorker)
    this.replaceWorker(worker);
  }

  // Timeout ownership follows the Worker and its exact active PendingTask. Task IDs
  // are encoder-local and may overlap across conversion sessions.
  private taskTimeouts = new Map<Worker, ReturnType<typeof setTimeout>>();

  private releaseWorker(worker: Worker): void {
    if (this.terminated) return;
    if (!this.idleWorkers.includes(worker)) {
      this.idleWorkers.push(worker);
    }
    this.processQueue();
  }

  /**
   * Submit an encoding task to the worker pool.
   * Returns a promise that resolves with the VP8 bitstream.
   * Tasks are returned in the order they were submitted (by id).
   */
  async encode(task: EncodeTask): Promise<EncodeTaskResult> {
    if (this.terminated) {
      return Promise.reject(new Error('Worker pool has been terminated'));
    }

    // If no workers were created (all init attempts failed), reject immediately
    // rather than queuing tasks that will never complete (M5 fix).
    if (this.workers.length === 0) {
      return Promise.reject(new Error('Worker pool has no active workers'));
    }

    return new Promise<EncodeTaskResult>((resolve, reject) => {
      const pending: PendingTask = {
        task,
        resolve,
        reject,
        submittedAt: performance.now(),
      };

      // If an idle worker is available, dispatch immediately
      const idleWorker = this.idleWorkers.pop();
      if (idleWorker) {
        this.dispatch(idleWorker, pending);
      } else {
        // Queue for later dispatch
        this.queue.push(pending);
      }
    });
  }

  private dispatch(worker: Worker, pending: PendingTask): void {
    // Set up timeout BEFORE postMessage so the task is always guarded.
    // postMessage can throw synchronously (e.g. detached ArrayBuffer),
    // in which case the timeout will clean up and reject the task.
    const timeoutHandle = setTimeout(() => {
      this.taskTimeouts.delete(worker);

      if (this.activeTasks.get(worker) !== pending) return; // already completed or replaced

      logger.warn('encoders', 'Worker task timed out, retiring worker', {
        taskId: pending.task.id,
        timeoutMs: this.timeoutMs,
      });

      this.activeTasks.delete(worker);
      pending.reject(
        new Error(`Encoding task ${pending.task.id} timed out after ${this.timeoutMs}ms`)
      );

      // Retire this worker and create a new one
      this.replaceWorker(worker);
    }, this.timeoutMs);

    this.taskTimeouts.set(worker, timeoutHandle);

    // Transfer the rgbData buffer to the worker (zero-copy).
    // postMessage is called BEFORE registering in activeTasks so that
    // a synchronous exception (detached buffer, etc.) doesn't leave
    // the task permanently stuck with no cleanup path.
    const { rgbData } = pending.task;
    try {
      worker.postMessage(pending.task, [rgbData.buffer]);
    } catch (err) {
      // postMessage threw synchronously — clean up and reject
      clearTimeout(timeoutHandle);
      this.taskTimeouts.delete(worker);
      // The pool owns task buffers once encode() is called. If transfer failed
      // before detaching the buffer, return it so a failed submission cannot
      // strand a frame allocation.
      if (rgbData.byteLength > 0) {
        globalBufferPool.release(rgbData);
      }
      pending.reject(new Error(getErrorMessage(err)));
      this.releaseWorker(worker);
      return;
    }

    // Only register the task AFTER successful postMessage.
    // If the transfer succeeded, the worker now owns the buffer.
    this.activeTasks.set(worker, pending);
  }

  private replaceWorker(worker: Worker): void {
    const idx = this.workers.indexOf(worker);
    if (idx === -1) return;

    worker.terminate();
    const idleIdx = this.idleWorkers.indexOf(worker);
    if (idleIdx !== -1) {
      this.idleWorkers.splice(idleIdx, 1);
    }

    try {
      const newWorker = this.createWorker();
      this.workers[idx] = newWorker;
      this.idleWorkers.push(newWorker);
    } catch (err) {
      // new Worker() can fail due to CSP, network errors, or file://
      // protocol restrictions. Remove the worker slot and continue
      // with reduced pool size.
      logger.warn('encoders', 'worker-replace-failed', {
        error: getErrorMessage(err),
        remainingWorkers: this.workers.length - 1,
      });
      this.workers.splice(idx, 1);
      if (this.workers.length === 0) {
        this.rejectQueuedTasks(new Error('All WebP workers failed'));
      }
    }

    this.processQueue();
  }

  private processQueue(): void {
    while (this.queue.length > 0 && this.idleWorkers.length > 0 && !this.terminated) {
      const worker = this.idleWorkers.pop()!;
      const pending = this.queue.shift()!;
      this.dispatch(worker, pending);
    }
  }

  private rejectQueuedTasks(error: Error): void {
    for (const pending of this.queue) {
      globalBufferPool.release(pending.task.rgbData);
      pending.reject(error);
    }
    this.queue.length = 0;
  }

  /**
   * Terminate all workers and reject pending tasks.
   */
  terminate(): void {
    this.terminated = true;

    for (const worker of this.workers) {
      worker.terminate();
    }

    // Reject all pending tasks
    for (const pending of this.queue) {
      globalBufferPool.release(pending.task.rgbData);
      pending.reject(new Error('Worker pool terminated'));
    }
    for (const pending of this.activeTasks.values()) {
      pending.reject(new Error('Worker pool terminated'));
    }

    this.queue.length = 0;
    this.idleWorkers.length = 0;
    this.activeTasks.clear();
    for (const timeoutHandle of this.taskTimeouts.values()) {
      clearTimeout(timeoutHandle);
    }
    this.taskTimeouts.clear();
    this.workers.length = 0;
  }

  /**
   * Current pool statistics for diagnostics.
   */
  get stats(): { poolSize: number; idle: number; active: number; queued: number } {
    return {
      poolSize: this.workers.length,
      idle: this.idleWorkers.length,
      active: this.activeTasks.size,
      queued: this.queue.length,
    };
  }
}

/**
 * Create a conversion-owned worker pool. Concurrent conversions must never
 * share a pool: their frame IDs are local, and each pipeline owns its teardown.
 */
export function createWorkerPool(size?: number): WebpWorkerPool | null {
  if (!WebpWorkerPool.isSupported()) {
    return null;
  }
  return new WebpWorkerPool(size);
}

/** Release one conversion's Worker, OffscreenCanvas, and native encoder resources. */
export function disposeWorkerPool(pool: WebpWorkerPool | null): void {
  pool?.terminate();
}
