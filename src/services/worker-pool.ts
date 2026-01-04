import * as Comlink from 'comlink';
import type { EncoderWorkerAPI, WorkerPoolOptions } from '../workers/types';
import { logger } from '../utils/logger';
import { getAvailableMemory } from '../utils/memory-monitor';

/**
 * Calculate optimal worker pool size based on hardware and memory
 *
 * @param format - Encoding format ('gif' or 'webp')
 * @param hardwareConcurrency - Number of logical CPU cores
 * @param availableMemory - Available memory in bytes
 * @returns Optimal number of workers (capped at 8)
 */
export function getOptimalPoolSize(
  format: 'gif' | 'webp',
  hardwareConcurrency: number = navigator.hardwareConcurrency || 4,
  availableMemory: number = getAvailableMemory()
): number {
  // Base concurrency: use 75% of cores to leave headroom for main thread
  const baseConcurrency = Math.floor(hardwareConcurrency * 0.75);

  // Memory limits per worker (conservative estimates)
  // GIF encoding is more memory-intensive than WebP
  const memoryPerWorker =
    format === 'gif'
      ? 100 * 1024 * 1024 // 100MB per GIF worker
      : 50 * 1024 * 1024; // 50MB per WebP worker

  // Calculate max workers based on available memory
  const memoryLimit = Math.floor(availableMemory / memoryPerWorker);

  // Return minimum of concurrency-based and memory-based limits, capped at 8
  const optimalSize = Math.min(baseConcurrency, memoryLimit, 8);

  // Ensure at least 1 worker
  return Math.max(1, optimalSize);
}

export class WorkerPool<T extends EncoderWorkerAPI> {
  private workers: Worker[] = [];
  private apis: T[] = [];
  private availableWorkers: number[] = [];
  private workerUrl: URL;
  private maxWorkers: number;
  private initialized = false;

  constructor(workerUrl: URL, options: WorkerPoolOptions = {}) {
    this.workerUrl = workerUrl;
    this.maxWorkers = options.maxWorkers ?? Math.max(2, navigator.hardwareConcurrency || 4);

    if (!options.lazyInit) {
      this.initialize();
    }
  }

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

  async execute<R>(task: (api: T) => Promise<R>): Promise<R> {
    if (!this.initialized) {
      this.initialize();
    }

    // Wait for available worker
    let workerId = this.availableWorkers.shift();

    while (workerId === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 50));
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

  get activeWorkers(): number {
    return this.maxWorkers - this.availableWorkers.length;
  }

  get poolSize(): number {
    return this.maxWorkers;
  }
}
