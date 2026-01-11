/**
 * Batch Calculator
 *
 * Memory-aware batch size calculations for video conversion operations.
 * Consolidates batch sizing logic from webcodecs-conversion-service.ts.
 *
 * Provides functions for:
 * - VFS batch sizing (FFmpeg virtual filesystem writes)
 * - WebP chunk sizing (parallel frame encoding)
 * - Worker pool sizing (parallel encoding workers)
 * - Memory-aware adjustments
 *
 * All calculations consider:
 * - Hardware concurrency (CPU cores)
 * - Frame dimensions and format
 * - Available memory
 * - Quality settings
 */

import type { ConversionQuality } from '../../types/conversion-types';
import { getAvailableMemory } from '../../utils/memory-monitor';
import { logger } from '../../utils/logger';

/**
 * VFS batch size calculation parameters
 */
export interface VFSBatchSizeParams {
  /** Frame width in pixels */
  frameWidth: number;
  /** Frame height in pixels */
  frameHeight: number;
  /** Hardware concurrency (CPU cores) */
  hwConcurrency: number;
  /** Quality level (affects JPEG vs PNG) */
  quality: ConversionQuality;
}

/**
 * WebP chunk size calculation parameters
 */
export interface WebPChunkSizeParams {
  /** Hardware concurrency (CPU cores) */
  hwConcurrency: number;
  /** Available memory in bytes (optional, for adaptive sizing) */
  availableMemory?: number;
}

/**
 * Worker pool size calculation parameters
 */
export interface WorkerPoolSizeParams {
  /** Type of worker ('gif' or 'webp') */
  workerType: 'gif' | 'webp';
  /** Hardware concurrency (CPU cores) */
  hwConcurrency: number;
  /** Available memory in bytes */
  availableMemory: number;
}

/**
 * Batch size calculation result
 */
export interface BatchSizeResult {
  /** Calculated batch size */
  size: number;
  /** Reason for this size (for logging) */
  reason: string;
  /** Memory budget used (bytes) */
  memoryBudget?: number;
  /** Estimated frame size (bytes) */
  estimatedFrameSize?: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Memory budget for VFS batch writes (100MB) */
const VFS_BATCH_MEMORY_BUDGET = 100 * 1024 * 1024;

/** Minimum VFS batch size (prevents too many small batches) */
const VFS_MIN_BATCH_SIZE = 10;

/** Maximum VFS batch size (prevents excessive memory usage) */
const VFS_MAX_BATCH_SIZE = 100;

/** Minimum WebP chunk size */
const WEBP_MIN_CHUNK_SIZE = 10;

/** Maximum WebP chunk size */
const WEBP_MAX_CHUNK_SIZE = 20;

/** Memory budget per GIF worker (100MB) */
const GIF_WORKER_MEMORY_BUDGET = 100 * 1024 * 1024;

/** Memory budget per WebP worker (50MB) */
const WEBP_WORKER_MEMORY_BUDGET = 50 * 1024 * 1024;

/** Minimum worker pool size */
const MIN_WORKER_POOL_SIZE = 1;

/** Maximum CPU utilization percentage for workers */
const WORKER_CPU_UTILIZATION = 0.75; // 75% of available cores

// ============================================================================
// VFS Batch Sizing
// ============================================================================

/**
 * Calculate optimal VFS batch size for writing frames to FFmpeg virtual filesystem
 *
 * Balances memory usage with parallelism to prevent OOM while maintaining performance.
 * Uses different compression estimates for JPEG vs PNG based on quality setting.
 *
 * Strategy:
 * 1. Estimate frame size based on dimensions and format (JPEG ~0.8 bytes/pixel, PNG ~3.5 bytes/pixel)
 * 2. Calculate how many frames fit in memory budget (100MB)
 * 3. Consider hardware concurrency for parallelism
 * 4. Clamp to min/max bounds (10-100 frames)
 *
 * @param params - Batch size parameters
 * @returns Batch size with calculation details
 *
 * @example
 * const result = calculateOptimalVFSBatchSize({
 *   frameWidth: 1920,
 *   frameHeight: 1080,
 *   hwConcurrency: 8,
 *   quality: 'high'
 * });
 * console.log(`Batch size: ${result.size} (${result.reason})`);
 */
export function calculateOptimalVFSBatchSize(params: VFSBatchSizeParams): BatchSizeResult {
  const { frameWidth, frameHeight, hwConcurrency, quality } = params;

  // Estimate bytes per frame (compressed)
  // JPEG (low/medium quality): ~0.8 bytes/pixel
  // PNG (high quality): ~3.5 bytes/pixel
  const pixelCount = frameWidth * frameHeight;
  const useJpeg = quality === 'low' || quality === 'medium';
  const bytesPerPixel = useJpeg ? 0.8 : 3.5;
  const estimatedFrameSize = pixelCount * bytesPerPixel;

  // Calculate frames per memory budget
  const framesPerBudget = Math.floor(VFS_BATCH_MEMORY_BUDGET / estimatedFrameSize);

  // Base batch size from hardware concurrency (6x cores)
  const baseBatchSize = hwConcurrency * 6;

  // Final batch size: memory-aware and concurrency-aware
  const memoryAwareBatchSize = Math.max(
    VFS_MIN_BATCH_SIZE,
    Math.min(VFS_MAX_BATCH_SIZE, Math.min(framesPerBudget, baseBatchSize))
  );

  logger.debug('conversion', 'Calculated memory-aware VFS batch size', {
    frameSize: `${frameWidth}x${frameHeight}`,
    estimatedFrameSizeMB: (estimatedFrameSize / 1024 / 1024).toFixed(2),
    framesPerBudget,
    baseBatchSize,
    finalBatchSize: memoryAwareBatchSize,
    format: useJpeg ? 'JPEG' : 'PNG',
  });

  return {
    size: memoryAwareBatchSize,
    reason: `Memory budget: ${(VFS_BATCH_MEMORY_BUDGET / 1024 / 1024).toFixed(0)}MB, ${useJpeg ? 'JPEG' : 'PNG'} compression`,
    memoryBudget: VFS_BATCH_MEMORY_BUDGET,
    estimatedFrameSize,
  };
}

/**
 * Get optimal VFS batch size with caching support
 *
 * Wrapper that checks cache before calculating. Intended to be used with
 * session cache (getCachedVFSBatchSize / cacheVFSBatchSize).
 *
 * @param params - Batch size parameters
 * @param cachedSize - Previously cached batch size (optional)
 * @param cacheValid - Whether cache is still valid (optional)
 * @returns Batch size (from cache or calculated)
 *
 * @example
 * const size = getOptimalVFSBatchSize(params, cachedValue, isHardwareCacheValid());
 */
export function getOptimalVFSBatchSize(
  params: VFSBatchSizeParams,
  cachedSize?: number,
  cacheValid = false
): number {
  if (cachedSize && cacheValid) {
    logger.debug('conversion', 'Using cached VFS batch size', {
      size: cachedSize,
    });
    return cachedSize;
  }

  const result = calculateOptimalVFSBatchSize(params);
  return result.size;
}

// ============================================================================
// WebP Chunk Sizing
// ============================================================================

/**
 * Calculate optimal WebP chunk size for parallel frame encoding
 *
 * Determines how many frames to encode in parallel based on CPU cores.
 * Smaller chunks = more overhead, larger chunks = less parallelism.
 *
 * Strategy:
 * 1. Base size = hwConcurrency * 2 (balance parallelism and overhead)
 * 2. Clamp to min/max bounds (10-20 frames)
 * 3. Can be adjusted based on available memory (future enhancement)
 *
 * @param params - Chunk size parameters
 * @returns Chunk size with calculation details
 *
 * @example
 * const result = calculateOptimalWebPChunkSize({
 *   hwConcurrency: 8
 * });
 * console.log(`Chunk size: ${result.size}`); // 16 (8 * 2)
 */
export function calculateOptimalWebPChunkSize(params: WebPChunkSizeParams): BatchSizeResult {
  const { hwConcurrency, availableMemory } = params;

  // Base chunk size: 2x hardware concurrency
  const baseChunkSize = hwConcurrency * 2;

  // Clamp to bounds
  const chunkSize = Math.min(WEBP_MAX_CHUNK_SIZE, Math.max(WEBP_MIN_CHUNK_SIZE, baseChunkSize));

  // Future: Adjust based on available memory
  // For now, use simple concurrency-based sizing
  const reason = `Based on ${hwConcurrency} cores (2x concurrency)`;

  logger.debug('conversion', 'Calculated WebP chunk size', {
    hwConcurrency,
    baseChunkSize,
    finalChunkSize: chunkSize,
    availableMemoryMB: availableMemory ? (availableMemory / 1024 / 1024).toFixed(0) : 'unknown',
  });

  return {
    size: chunkSize,
    reason,
  };
}

/**
 * Get optimal WebP chunk size with caching support
 *
 * Wrapper that checks cache before calculating. Intended to be used with
 * session cache (getCachedWebPChunkSize / cacheWebPChunkSize).
 *
 * @param params - Chunk size parameters
 * @param cachedSize - Previously cached chunk size (optional)
 * @param cacheValid - Whether cache is still valid (optional)
 * @returns Chunk size (from cache or calculated)
 *
 * @example
 * const size = getOptimalWebPChunkSize(params, cachedValue, isHardwareCacheValid());
 */
export function getOptimalWebPChunkSize(
  params: WebPChunkSizeParams,
  cachedSize?: number,
  cacheValid = false
): number {
  if (cachedSize && cacheValid) {
    logger.debug('conversion', 'Using cached WebP chunk size', {
      size: cachedSize,
    });
    return cachedSize;
  }

  const result = calculateOptimalWebPChunkSize(params);
  return result.size;
}

// ============================================================================
// Worker Pool Sizing
// ============================================================================

/**
 * Calculate optimal worker pool size
 *
 * Determines how many workers to spawn based on CPU cores and available memory.
 * Balances parallelism with memory constraints.
 *
 * Strategy:
 * 1. CPU-based limit: 75% of hardware concurrency (leave headroom)
 * 2. Memory-based limit: available memory / per-worker budget
 * 3. Take minimum of both limits
 * 4. Clamp to reasonable bounds (1-16 workers)
 *
 * @param params - Worker pool size parameters
 * @returns Worker pool size with calculation details
 *
 * @example
 * const result = calculateOptimalWorkerPoolSize({
 *   workerType: 'gif',
 *   hwConcurrency: 8,
 *   availableMemory: 1024 * 1024 * 1024 // 1GB
 * });
 * console.log(`Pool size: ${result.size}`); // 6 (75% of 8 cores)
 */
export function calculateOptimalWorkerPoolSize(params: WorkerPoolSizeParams): BatchSizeResult {
  const { workerType, hwConcurrency, availableMemory } = params;

  // CPU-based limit (75% utilization)
  const cpuLimit = Math.max(MIN_WORKER_POOL_SIZE, Math.floor(hwConcurrency * WORKER_CPU_UTILIZATION));

  // Memory-based limit
  const workerMemoryBudget =
    workerType === 'gif' ? GIF_WORKER_MEMORY_BUDGET : WEBP_WORKER_MEMORY_BUDGET;
  const memoryLimit = Math.floor(availableMemory / workerMemoryBudget);

  // Take minimum (most restrictive constraint)
  const poolSize = Math.max(MIN_WORKER_POOL_SIZE, Math.min(cpuLimit, memoryLimit));

  const reason = `CPU limit: ${cpuLimit}, Memory limit: ${memoryLimit} (${(workerMemoryBudget / 1024 / 1024).toFixed(0)}MB/worker)`;

  logger.debug('conversion', 'Calculated worker pool size', {
    workerType,
    hwConcurrency,
    availableMemoryMB: (availableMemory / 1024 / 1024).toFixed(0),
    cpuLimit,
    memoryLimit,
    finalPoolSize: poolSize,
  });

  return {
    size: poolSize,
    reason,
    memoryBudget: workerMemoryBudget,
  };
}

/**
 * Get optimal worker pool size (convenience function)
 *
 * Automatically fetches available memory and calculates pool size.
 *
 * @param workerType - Type of worker ('gif' or 'webp')
 * @param hwConcurrency - Hardware concurrency (CPU cores)
 * @returns Worker pool size
 *
 * @example
 * const poolSize = getOptimalWorkerPoolSize('gif', 8); // Returns 6 (or memory-limited)
 */
export function getOptimalWorkerPoolSize(
  workerType: 'gif' | 'webp',
  hwConcurrency: number
): number {
  const availableMemory = getAvailableMemory();
  const result = calculateOptimalWorkerPoolSize({
    workerType,
    hwConcurrency,
    availableMemory,
  });
  return result.size;
}
