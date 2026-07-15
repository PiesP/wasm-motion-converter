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

import { WORKER_TIMEOUT_MS } from '@utils/constants';
import { logger } from '@utils/logger';

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

// ─── Worker Pool ───────────────────────────────────────────────────

export class WebpWorkerPool {
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private queue: PendingTask[] = [];
  private activeTasks: Map<Worker, EncodeTask> = new Map();
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
   *   - CPU: hardwareConcurrency - 1, minimum 1
   *   - Device memory: ≤4GB → 2, ≤8GB → 4, >8GB → unlimited
   *   - Frame resolution: >1080p → 2, >720p → 4
   */
  static getOptimalWorkerCount(frameWidth?: number, frameHeight?: number): number {
    let count = 1;

    if (typeof navigator !== 'undefined') {
      // CPU-based cap
      if (navigator.hardwareConcurrency) {
        count = Math.max(1, navigator.hardwareConcurrency - 1);
      } else {
        count = 2;
      }

      // Device memory cap (navigator.deviceMemory in GB, Chrome only)
      const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
      if (typeof deviceMemory === 'number' && deviceMemory > 0) {
        if (deviceMemory <= 4) {
          count = Math.min(count, 2);
        } else if (deviceMemory <= 8) {
          count = Math.min(count, 4);
        }
      }

      // Frame resolution cap: each worker needs an OffscreenCanvas
      // at frame size (~w·h·4 bytes RGBA)
      if (frameWidth && frameHeight) {
        const pixels = frameWidth * frameHeight;
        if (pixels > 1920 * 1080) {
          // >1080p: limit to 2 workers (~66MB canvas memory at 4K)
          count = Math.min(count, 2);
        } else if (pixels > 1280 * 720) {
          // >720p: limit to 4 workers (~32MB canvas memory at 1080p)
          count = Math.min(count, 4);
        }
      }
    }

    return count;
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
        const worker = new Worker(new URL('./webp-encoder-worker.ts', import.meta.url), {
          type: 'module',
        });

        worker.onmessage = (event: MessageEvent<EncodeTaskResult & { error?: string }>) => {
          this.handleWorkerMessage(worker, event.data);
        };

        worker.onerror = (event: ErrorEvent) => {
          this.handleWorkerError(worker, event);
        };

        this.workers.push(worker);
        this.idleWorkers.push(worker);
      } catch (err) {
        logger.warn('encoders', 'worker-create-failed', {
          index: i,
          error: err instanceof Error ? err.message : String(err),
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

  private handleWorkerMessage(worker: Worker, data: EncodeTaskResult & { error?: string }): void {
    // Find the pending task that was assigned to this worker
    const activeTask = this.activeTasks.get(worker);
    if (!activeTask) {
      logger.warn('encoders', 'Worker message received but no active task found');
      this.releaseWorker(worker);
      return;
    }

    // Clear the timeout for this task (it completed successfully)
    const timeoutHandle = this.taskTimeouts.get(activeTask.id);
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
      this.taskTimeouts.delete(activeTask.id);
    }

    this.activeTasks.delete(worker);

    if (data.error) {
      // Reject the promise
      const pending = this.findPendingByTaskId(data.id);
      if (pending) {
        pending.reject(new Error(`Worker encoding failed: ${data.error}`));
      }
    } else {
      // Resolve the promise with the result
      const pending = this.findPendingByTaskId(data.id);
      if (pending) {
        pending.resolve({ id: data.id, bitstream: data.bitstream });
      }
    }

    this.releaseWorker(worker);
  }

  private handleWorkerError(worker: Worker, event: ErrorEvent): void {
    logger.warn('encoders', 'worker-error', { message: event.message });

    const activeTask = this.activeTasks.get(worker);
    this.activeTasks.delete(worker);

    // Clear timeout for this task
    if (activeTask) {
      const timeoutHandle = this.taskTimeouts.get(activeTask.id);
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
        this.taskTimeouts.delete(activeTask.id);
      }
    }

    // Reject the pending task
    if (activeTask) {
      const pending = this.findPendingByTaskId(activeTask.id);
      if (pending) {
        pending.reject(new Error(`Worker error: ${event.message}`));
      }
    }

    // Replace dead worker (with try/catch inside replaceWorker)
    this.replaceWorker(worker);
  }

  private findPendingByTaskId(id: number): PendingTask | undefined {
    // Pending tasks that have been submitted are tracked via pendingResolvers map keyed by task id.
    const resolver = this.pendingResolvers.get(id);
    if (resolver) {
      this.pendingResolvers.delete(id);
      return resolver;
    }
    return undefined;
  }

  // Map task id → pending task with resolve/reject (for submitted tasks awaiting result)
  private pendingResolvers = new Map<number, PendingTask>();

  // Map task id → setTimeout handle (for timeout cleanup on task completion)
  private taskTimeouts = new Map<number, ReturnType<typeof setTimeout>>();

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
      this.taskTimeouts.delete(pending.task.id);

      if (!this.activeTasks.has(worker)) return; // already completed

      logger.warn('encoders', 'Worker task timed out, retiring worker', {
        taskId: pending.task.id,
        timeoutMs: this.timeoutMs,
      });

      this.activeTasks.delete(worker);
      this.pendingResolvers.delete(pending.task.id);
      pending.reject(
        new Error(`Encoding task ${pending.task.id} timed out after ${this.timeoutMs}ms`)
      );

      // Retire this worker and create a new one
      this.replaceWorker(worker);
    }, this.timeoutMs);

    this.taskTimeouts.set(pending.task.id, timeoutHandle);

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
      this.taskTimeouts.delete(pending.task.id);
      pending.reject(err instanceof Error ? err : new Error(String(err)));
      this.releaseWorker(worker);
      return;
    }

    // Only register the task AFTER successful postMessage.
    // If the transfer succeeded, the worker now owns the buffer.
    this.activeTasks.set(worker, pending.task);
    this.pendingResolvers.set(pending.task.id, pending);
  }

  private replaceWorker(worker: Worker): void {
    const idx = this.workers.indexOf(worker);
    if (idx === -1) return;

    worker.terminate();

    try {
      const newWorker = new Worker(new URL('./webp-encoder-worker.ts', import.meta.url), {
        type: 'module',
      });
      newWorker.onmessage = (event: MessageEvent<EncodeTaskResult & { error?: string }>) => {
        this.handleWorkerMessage(newWorker, event.data);
      };
      newWorker.onerror = (event: ErrorEvent) => {
        this.handleWorkerError(newWorker, event);
      };
      this.workers[idx] = newWorker;
      this.idleWorkers.push(newWorker);
    } catch (err) {
      // new Worker() can fail due to CSP, network errors, or file://
      // protocol restrictions. Remove the worker slot and continue
      // with reduced pool size.
      logger.warn('encoders', 'worker-replace-failed', {
        error: err instanceof Error ? err.message : String(err),
        remainingWorkers: this.workers.length - 1,
      });
      this.workers.splice(idx, 1);
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
      pending.reject(new Error('Worker pool terminated'));
    }
    for (const pending of this.pendingResolvers.values()) {
      pending.reject(new Error('Worker pool terminated'));
    }

    this.queue.length = 0;
    this.idleWorkers.length = 0;
    this.activeTasks.clear();
    this.pendingResolvers.clear();
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

// ─── Singleton Pool (lazy) ─────────────────────────────────────────

let singletonPool: WebpWorkerPool | null = null;

/**
 * Get the shared worker pool instance.
 * Creates it on first access. Returns null if Worker is unsupported.
 */
export function getWorkerPool(size?: number): WebpWorkerPool | null {
  if (!WebpWorkerPool.isSupported()) {
    return null;
  }
  if (!singletonPool) {
    singletonPool = new WebpWorkerPool(size);
  }
  return singletonPool;
}
