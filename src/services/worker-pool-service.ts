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
  private workerUrl: URL;
  private maxWorkers: number;
  private initialized = false;

  /**
   * Create worker pool
   *
   * @param workerUrl - Worker script URL (use `new URL('./worker.ts', import.meta.url)`)
   * @param options - Pool configuration options
   */
  constructor(workerUrl: URL, options: WorkerPoolOptions = {}) {
    this.workerUrl = workerUrl;
    this.maxWorkers = options.maxWorkers ?? Math.max(2, navigator.hardwareConcurrency || 4);

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
      const worker = new Worker(this.workerUrl, {
        type: 'module',
        name: `encoder-worker-${i}`,
      });

      this.workers.push(worker);
      this.apis.push(Comlink.wrap<T>(worker) as T);
      this.availableWorkers.push(i);
    }

    this.initialized = true;
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
  async execute<R>(task: (api: T) => Promise<R>): Promise<R> {
    if (!this.initialized) {
      this.initialize();
    }

    // Wait for available worker
    let workerId = this.availableWorkers.shift();

    while (workerId === undefined) {
      await new Promise((resolve) => setTimeout(resolve, WORKER_POLL_INTERVAL));
      workerId = this.availableWorkers.shift();
    }

    const api = this.apis[workerId] as T;

    try {
      logger.debug('worker-pool', `Executing task on worker ${workerId}`);
      const result = await task(api);
      return result;
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
