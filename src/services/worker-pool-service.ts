// External dependencies
import * as Comlink from 'comlink';

// Internal imports
import { logger } from '@utils/logger';
import { getAvailableMemory } from '@utils/memory-monitor';

// Type imports
import type { EncoderWorkerAPI, WorkerPoolOptions } from '@t/worker-types';

/**
 * CPU concurrency utilization ratio
 *
 * Use 75% of logical cores to leave headroom for main thread and browser operations.
 */
const CPU_UTILIZATION_RATIO = 0.75;

/**
 * Maximum worker pool size
 *
 * Cap pool size to prevent excessive resource consumption even on high-core systems.
 * Increased to 12 (from 8) to better utilize modern high-core CPUs (16-24+ cores).
 */
const MAX_POOL_SIZE = 12;

/**
 * Memory allocation per GIF encoder worker (bytes)
 *
 * GIF encoding is memory-intensive due to color quantization and frame buffering.
 */
const MEMORY_PER_GIF_WORKER = 100 * 1024 * 1024; // 100 MB

/**
 * Memory allocation per WebP encoder worker (bytes)
 *
 * WebP encoding is less memory-intensive than GIF.
 */
const MEMORY_PER_WEBP_WORKER = 50 * 1024 * 1024; // 50 MB

/**
 * Worker availability polling interval (milliseconds)
 *
 * Interval for checking worker availability when all workers are busy.
 */
const WORKER_POLL_INTERVAL = 50;

/**
 * Worker readiness ping interval (milliseconds)
 *
 * Used to avoid a race where the main thread sends a Comlink RPC message
 * before the worker has finished loading Comlink and attaching its message
 * handler. The first message can be dropped and the call can hang forever.
 */
const WORKER_READY_PING_INTERVAL = 50;

/** Default worker-ready timeout (milliseconds) */
const DEFAULT_WORKER_READY_TIMEOUT_MS = 15_000;

/** Default task timeout (milliseconds) */
const DEFAULT_TASK_TIMEOUT_MS = 300_000;

type WorkerPoolExecuteOptions = {
  /** Optional AbortSignal used to cancel waiting / task execution */
  signal?: AbortSignal;
  /** Per-task timeout override */
  timeoutMs?: number;
};

type DropconvertWorkerReadyMessage = {
  __dropconvertWorkerReady?: boolean;
  __dropconvertWorkerPong?: boolean;
  __dropconvertWorkerNotReady?: boolean;
};

type DropconvertWorkerPingMessage = {
  __dropconvertWorkerPing: true;
};

const READY_PING_MESSAGE: DropconvertWorkerPingMessage = {
  __dropconvertWorkerPing: true,
};

/**
 * Calculate optimal worker pool size based on hardware and memory
 *
 * @param format - Encoding format ('gif' or 'webp')
 * @param hardwareConcurrency - Number of logical CPU cores
 * @param availableMemory - Available memory in bytes
 * @returns Optimal number of workers (capped at 12)
 */
export function getOptimalPoolSize(
  format: 'gif' | 'webp',
  hardwareConcurrency: number = navigator.hardwareConcurrency || 4,
  availableMemory: number = getAvailableMemory()
): number {
  // Base concurrency: use CPU_UTILIZATION_RATIO of cores
  const baseConcurrency = Math.floor(hardwareConcurrency * CPU_UTILIZATION_RATIO);

  // Get memory limit per worker based on format
  const memoryPerWorker = format === 'gif' ? MEMORY_PER_GIF_WORKER : MEMORY_PER_WEBP_WORKER;

  // Calculate max workers based on available memory
  const memoryLimit = Math.floor(availableMemory / memoryPerWorker);

  // Return minimum of concurrency-based and memory-based limits, capped at MAX_POOL_SIZE
  const optimalSize = Math.min(baseConcurrency, memoryLimit, MAX_POOL_SIZE);

  // Ensure at least 1 worker
  return Math.max(1, optimalSize);
}

/**
 * Worker pool for parallel task execution
 *
 * Manages a pool of Web Workers for parallel encoding operations (GIF/WebP).
 * Features:
 * - Lazy initialization (optional)
 * - Automatic worker allocation and release
 * - Task queuing when all workers are busy
 * - Graceful cleanup and termination
 *
 * @template T - Worker API type (must extend EncoderWorkerAPI)
 *
 * @example
 * const pool = new WorkerPool<GifEncoderWorkerAPI>(
 *   new URL('../workers/gif-encoder.worker.ts', import.meta.url),
 *   { maxWorkers: 4 }
 * );
 *
 * const result = await pool.execute((api) => api.encodeFrame(frameData));
 * pool.terminate();
 */
export class WorkerPool<T extends EncoderWorkerAPI> {
  private workers: Worker[] = [];
  private apis: T[] = [];
  private availableWorkers: number[] = [];
  private workerUrl: URL | string;
  private maxWorkers: number;
  private initialized = false;

  private readonly readyTimeoutMs: number;
  private readonly defaultTaskTimeoutMs: number;
  private workerReady: boolean[] = [];
  private workerReadyPromise: Array<Promise<void> | null> = [];

  /**
   * Create worker pool
   *
   * @param workerUrl - Worker script URL (Vite-built URL string or a URL object)
   * @param options - Pool configuration options
   */
  constructor(workerUrl: URL | string, options: WorkerPoolOptions = {}) {
    this.workerUrl = workerUrl;
    this.maxWorkers = options.maxWorkers ?? Math.max(2, navigator.hardwareConcurrency || 4);

    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_WORKER_READY_TIMEOUT_MS;
    this.defaultTaskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;

    if (!options.lazyInit) {
      this.initialize();
    }
  }

  /**
   * Initialize worker pool
   *
   * Creates worker instances, wraps them with Comlink, and marks all as available.
   * Idempotent: safe to call multiple times.
   *
   * @private
   */
  private initialize(): void {
    if (this.initialized) return;

    logger.info('worker-pool', `Initializing worker pool with ${this.maxWorkers} workers`);

    for (let i = 0; i < this.maxWorkers; i++) {
      this.spawnWorker(i);
    }

    this.initialized = true;
  }

  private spawnWorker(workerId: number): void {
    const worker = new Worker(this.workerUrl, {
      type: 'module',
      name: `encoder-worker-${workerId}`,
    });

    worker.addEventListener('error', (event) => {
      logger.warn('worker-pool', 'Worker error event', {
        workerId,
        message: (event as ErrorEvent | undefined)?.message,
      });
      // Mark as not-ready so the next task forces a re-check.
      this.workerReady[workerId] = false;
      this.workerReadyPromise[workerId] = null;
    });

    worker.addEventListener('messageerror', () => {
      logger.warn('worker-pool', 'Worker messageerror event', { workerId });
      this.workerReady[workerId] = false;
      this.workerReadyPromise[workerId] = null;
    });

    this.workers[workerId] = worker;
    this.apis[workerId] = Comlink.wrap<T>(worker) as T;
    this.workerReady[workerId] = false;
    this.workerReadyPromise[workerId] = null;

    // Keep existing behavior: workers are immediately considered available.
    // execute() will block until the worker is actually ready.
    this.availableWorkers.push(workerId);
  }

  private async respawnWorker(workerId: number, reason: string): Promise<void> {
    logger.warn('worker-pool', 'Respawning worker', { workerId, reason });

    try {
      this.workers[workerId]?.terminate();
    } catch {
      // Ignore.
    }

    // Remove any cached readiness state.
    this.workerReady[workerId] = false;
    this.workerReadyPromise[workerId] = null;

    // Replace worker + API proxy in-place.
    const worker = new Worker(this.workerUrl, {
      type: 'module',
      name: `encoder-worker-${workerId}`,
    });

    worker.addEventListener('error', (event) => {
      logger.warn('worker-pool', 'Worker error event', {
        workerId,
        message: (event as ErrorEvent | undefined)?.message,
      });
      this.workerReady[workerId] = false;
      this.workerReadyPromise[workerId] = null;
    });

    worker.addEventListener('messageerror', () => {
      logger.warn('worker-pool', 'Worker messageerror event', { workerId });
      this.workerReady[workerId] = false;
      this.workerReadyPromise[workerId] = null;
    });

    this.workers[workerId] = worker;
    this.apis[workerId] = Comlink.wrap<T>(worker) as T;
  }

  private createAbortPromise(signal?: AbortSignal): Promise<never> {
    if (!signal) {
      return new Promise<never>(() => {
        // Never resolves
      });
    }

    if (signal.aborted) {
      return Promise.reject(new Error('Conversion cancelled by user'));
    }

    return new Promise<never>((_, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error('Conversion cancelled by user'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private createTimeoutPromise(timeoutMs: number, message: string): Promise<never> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return new Promise<never>(() => {
        // Never resolves
      });
    }

    return new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(message));
      }, timeoutMs);

      // Node-style timers are compatible in browser typings.
      // Ensure this promise does not keep references alive.
      (timer as unknown as { unref?: () => void }).unref?.();
    });
  }

  private async ensureWorkerReady(workerId: number, signal?: AbortSignal): Promise<void> {
    if (this.workerReady[workerId]) {
      return;
    }

    if (!this.workerReadyPromise[workerId]) {
      const worker = this.workers[workerId];
      if (!worker) {
        throw new Error(`Worker ${workerId} is not initialized`);
      }

      this.workerReadyPromise[workerId] = new Promise<void>((resolve, reject) => {
        const startAt = Date.now();
        let intervalId: ReturnType<typeof setInterval> | undefined;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        const cleanup = () => {
          if (intervalId !== undefined) {
            clearInterval(intervalId);
          }
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
          }
          worker.removeEventListener('message', onMessage as EventListener);
        };

        const onMessage = (event: MessageEvent<DropconvertWorkerReadyMessage>) => {
          const data = event.data;
          if (!data) {
            return;
          }

          if (data.__dropconvertWorkerReady || data.__dropconvertWorkerPong) {
            this.workerReady[workerId] = true;
            cleanup();
            logger.debug('worker-pool', 'Worker is ready', {
              workerId,
              waitMs: Date.now() - startAt,
            });
            resolve();
          }
        };

        worker.addEventListener('message', onMessage as EventListener);

        // Send periodic pings until the worker indicates readiness.
        intervalId = globalThis.setInterval(() => {
          try {
            worker.postMessage(READY_PING_MESSAGE);
          } catch {
            // Ignore: worker may be terminating.
          }
        }, WORKER_READY_PING_INTERVAL);

        try {
          worker.postMessage(READY_PING_MESSAGE);
        } catch {
          // Ignore.
        }

        timeoutId = globalThis.setTimeout(() => {
          cleanup();
          reject(
            new Error(`Worker ${workerId} did not become ready within ${this.readyTimeoutMs}ms`)
          );
        }, this.readyTimeoutMs);
      });
    }

    try {
      await Promise.race([
        this.workerReadyPromise[workerId] as Promise<void>,
        this.createAbortPromise(signal),
      ]);
    } catch (error) {
      // Reset readiness state so future calls retry.
      this.workerReady[workerId] = false;
      this.workerReadyPromise[workerId] = null;
      throw error;
    }
  }

  /**
   * Execute task on available worker
   *
   * Allocates a worker from the pool, executes the task, and returns the worker to the pool.
   * If all workers are busy, waits until one becomes available.
   *
   * @template R - Task result type
   * @param task - Task function receiving worker API
   * @returns Task result
   *
   * @example
   * const encoded = await pool.execute(async (api) => {
   *   return api.encodeFrame(frameData);
   * });
   */
  async execute<R>(
    task: (api: T) => Promise<R>,
    options: WorkerPoolExecuteOptions = {}
  ): Promise<R> {
    if (!this.initialized) {
      this.initialize();
    }

    if (options.signal?.aborted) {
      throw new Error('Conversion cancelled by user');
    }

    // Wait for available worker
    let workerId = this.availableWorkers.shift();

    while (workerId === undefined) {
      if (options.signal?.aborted) {
        throw new Error('Conversion cancelled by user');
      }
      await new Promise((resolve) => setTimeout(resolve, WORKER_POLL_INTERVAL));
      workerId = this.availableWorkers.shift();
    }

    const api = this.apis[workerId] as T;

    // Ensure we do not call into the Comlink proxy before the worker has
    // finished loading Comlink and installed its message handler.
    try {
      await this.ensureWorkerReady(workerId, options.signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // If readiness failed, respawn the worker to avoid a permanently stuck slot.
      await this.respawnWorker(workerId, `ready-failed: ${message}`);
      throw error;
    }

    try {
      logger.debug('worker-pool', `Executing task on worker ${workerId}`);
      const timeoutMs = options.timeoutMs ?? this.defaultTaskTimeoutMs;
      const result = await Promise.race([
        task(api),
        this.createTimeoutPromise(
          timeoutMs,
          `Worker task timed out after ${timeoutMs}ms (worker ${workerId})`
        ),
        this.createAbortPromise(options.signal),
      ]);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isCancellation = message.toLowerCase().includes('cancelled by user');
      const isTimeout = message.toLowerCase().includes('timed out');

      if (isCancellation || isTimeout) {
        // Prevent a stuck/in-flight Comlink call from poisoning the pool.
        await this.respawnWorker(workerId, isCancellation ? 'cancelled' : 'timeout');
      }

      throw error;
    } finally {
      // Return worker to pool
      this.availableWorkers.push(workerId);
    }
  }

  /**
   * Terminate all workers and cleanup pool
   *
   * Terminates all worker threads, clears all state, and resets initialization flag.
   * Safe to call multiple times.
   */
  terminate(): void {
    logger.info('worker-pool', `Terminating ${this.workers.length} workers`);

    for (const worker of this.workers) {
      worker.terminate();
    }

    this.workers = [];
    this.apis = [];
    this.availableWorkers = [];
    this.initialized = false;

    this.workerReady = [];
    this.workerReadyPromise = [];
  }

  /**
   * Get number of currently active (busy) workers
   *
   * @returns Number of workers executing tasks
   */
  get activeWorkers(): number {
    return this.maxWorkers - this.availableWorkers.length;
  }

  /**
   * Get total pool size
   *
   * @returns Total number of workers in pool
   */
  get poolSize(): number {
    return this.maxWorkers;
  }
}
