/**
 * Performance Cache
 *
 * Typed wrapper around session-cache.ts providing a cleaner, more structured
 * interface for performance-related caching during video conversion.
 *
 * Caches:
 * - Capture mode success (which mode worked for a codec)
 * - Capture mode performance (speed metrics by codec/mode)
 * - VFS batch sizes (optimal batch size for frame writes)
 * - WebP chunk sizes (optimal chunk size for parallel encoding)
 *
 * All caches are session-scoped (cleared on tab close) and respect hardware
 * profile validity to avoid using stale data after system changes.
 */

import { isHardwareCacheValid } from '../../utils/hardware-profile';
import {
  type CaptureMode,
  type CapturePerformance,
  cacheCaptureMode as _cacheCaptureMode,
  cacheCapturePerformance as _cacheCapturePerformance,
  cacheVFSBatchSize as _cacheVFSBatchSize,
  cacheWebPChunkSize as _cacheWebPChunkSize,
  getCachedCaptureMode as _getCachedCaptureMode,
  getCachedCapturePerformance as _getCachedCapturePerformance,
  getCachedVFSBatchSize as _getCachedVFSBatchSize,
  getCachedWebPChunkSize as _getCachedWebPChunkSize,
} from '../../utils/session-cache';

// Re-export types for convenience
export type { CaptureMode, CapturePerformance };

// ============================================================================
// Capture Mode Caching
// ============================================================================

/**
 * Get cached successful capture mode for a codec
 *
 * Returns the capture mode that previously succeeded for this codec in the
 * current session. Used to skip unreliable modes and go straight to the
 * known-working mode.
 *
 * @param codec - Video codec (e.g., 'h264', 'vp9', 'av1')
 * @param requireHardwareValidity - If true, returns null if hardware cache is invalid
 * @returns Cached capture mode or null if not cached/invalid
 *
 * @example
 * const mode = getCachedCaptureMode('av1', true);
 * if (mode === 'demuxer') {
 *   // Use demuxer mode directly, skip probing
 * }
 */
export function getCachedCaptureMode(
  codec: string,
  requireHardwareValidity = true
): CaptureMode | null {
  if (requireHardwareValidity && !isHardwareCacheValid()) {
    return null;
  }

  return _getCachedCaptureMode(codec);
}

/**
 * Cache successful capture mode for a codec
 *
 * Records that a specific capture mode worked successfully for this codec.
 * Future conversions will use this mode directly.
 *
 * @param codec - Video codec
 * @param mode - Successful capture mode
 *
 * @example
 * cacheCaptureMode('hevc', 'demuxer');
 */
export function cacheCaptureMode(codec: string, mode: CaptureMode): void {
  _cacheCaptureMode(codec, mode);
}

// ============================================================================
// Capture Performance Caching
// ============================================================================

/**
 * Get cached performance metrics for a codec
 *
 * Returns performance data (ms/frame) for the last successful capture of
 * this codec. Used to detect slow hardware and warn users.
 *
 * @param codec - Video codec
 * @param requireHardwareValidity - If true, returns null if hardware cache is invalid
 * @returns Performance metrics or null if not cached/invalid/stale
 *
 * @example
 * const perf = getCachedCapturePerformance('av1');
 * if (perf && perf.avgMsPerFrame > 100) {
 *   console.warn('Slow frame extraction detected');
 * }
 */
export function getCachedCapturePerformance(
  codec: string,
  requireHardwareValidity = true
): CapturePerformance | null {
  if (requireHardwareValidity && !isHardwareCacheValid()) {
    return null;
  }

  return _getCachedCapturePerformance(codec);
}

/**
 * Cache performance metrics for a codec
 *
 * Records performance data for future reference. Automatically calculates
 * average ms/frame and adds timestamp.
 *
 * @param codec - Video codec
 * @param mode - Capture mode that was used
 * @param totalMs - Total time taken in milliseconds
 * @param frameCount - Number of frames processed
 *
 * @example
 * cacheCapturePerformance('vp9', 'frame-callback', 5000, 50);
 * // Stores: avgMsPerFrame = 100ms
 */
export function cacheCapturePerformance(
  codec: string,
  mode: CaptureMode,
  totalMs: number,
  frameCount: number
): void {
  _cacheCapturePerformance(codec, mode, totalMs, frameCount);
}

// ============================================================================
// Batch Size Caching
// ============================================================================

/**
 * Get cached VFS batch size
 *
 * Returns the previously successful VFS batch size for frame writes to
 * FFmpeg virtual filesystem. Valid only if hardware profile hasn't changed.
 *
 * @param requireHardwareValidity - If true, returns null if hardware cache is invalid
 * @returns Cached batch size or null if not cached/invalid
 *
 * @example
 * const batchSize = getCachedVFSBatchSize();
 * if (batchSize) {
 *   // Use cached batch size instead of recalculating
 * }
 */
export function getCachedVFSBatchSize(requireHardwareValidity = true): number | null {
  if (requireHardwareValidity && !isHardwareCacheValid()) {
    return null;
  }

  return _getCachedVFSBatchSize();
}

/**
 * Cache VFS batch size
 *
 * Records successful VFS batch size for future conversions in this session.
 *
 * @param batchSize - Batch size that worked well
 *
 * @example
 * cacheVFSBatchSize(40);
 */
export function cacheVFSBatchSize(batchSize: number): void {
  _cacheVFSBatchSize(batchSize);
}

/**
 * Get cached WebP chunk size
 *
 * Returns the previously successful WebP chunk size for parallel frame encoding.
 * Valid only if hardware profile hasn't changed.
 *
 * @param requireHardwareValidity - If true, returns null if hardware cache is invalid
 * @returns Cached chunk size or null if not cached/invalid
 *
 * @example
 * const chunkSize = getCachedWebPChunkSize();
 * if (chunkSize) {
 *   // Use cached chunk size instead of recalculating
 * }
 */
export function getCachedWebPChunkSize(requireHardwareValidity = true): number | null {
  if (requireHardwareValidity && !isHardwareCacheValid()) {
    return null;
  }

  return _getCachedWebPChunkSize();
}

/**
 * Cache WebP chunk size
 *
 * Records successful WebP chunk size for future conversions in this session.
 *
 * @param chunkSize - Chunk size that worked well
 *
 * @example
 * cacheWebPChunkSize(16);
 */
export function cacheWebPChunkSize(chunkSize: number): void {
  _cacheWebPChunkSize(chunkSize);
}

// ============================================================================
// Unified Cache Interface
// ============================================================================

/**
 * Performance cache interface
 *
 * Provides structured access to all cached performance data. Use this when
 * you need to check multiple cache values at once.
 */
export interface PerformanceCacheData {
  /** Cached capture mode for a codec */
  captureMode?: CaptureMode;
  /** Cached performance metrics for a codec */
  capturePerformance?: CapturePerformance;
  /** Cached VFS batch size */
  vfsBatchSize?: number;
  /** Cached WebP chunk size */
  webpChunkSize?: number;
}

/**
 * Get all cached performance data
 *
 * Retrieves all cached values in a single call. Useful for logging or
 * debugging cache state.
 *
 * @param codec - Video codec (for capture mode/performance lookup)
 * @param requireHardwareValidity - If true, returns null values if hardware cache is invalid
 * @returns Object with all cached values (undefined if not cached)
 *
 * @example
 * const cache = getPerformanceCache('av1');
 * console.log('Cache state:', cache);
 * // { captureMode: 'demuxer', vfsBatchSize: 40, ... }
 */
export function getPerformanceCache(
  codec?: string,
  requireHardwareValidity = true
): PerformanceCacheData {
  const hardwareValid = isHardwareCacheValid();
  const checkValidity = requireHardwareValidity && !hardwareValid;

  return {
    captureMode:
      codec && !checkValidity ? getCachedCaptureMode(codec, false) || undefined : undefined,
    capturePerformance:
      codec && !checkValidity ? getCachedCapturePerformance(codec, false) || undefined : undefined,
    vfsBatchSize: !checkValidity ? getCachedVFSBatchSize(false) || undefined : undefined,
    webpChunkSize: !checkValidity ? getCachedWebPChunkSize(false) || undefined : undefined,
  };
}

/**
 * Clear all performance cache
 *
 * Clears all session-cached performance data. Use this when hardware profile
 * changes or when you want to reset performance tuning.
 *
 * Note: This only clears the in-memory references. To fully clear session storage,
 * use sessionStorage.clear() directly (but this affects all stored data).
 *
 * @example
 * // After hardware change
 * clearPerformanceCache();
 */
export function clearPerformanceCache(): void {
  // Session storage will be cleared automatically on session end
  // This function is here for future implementation if needed
  // For now, it's a no-op since we rely on session storage expiry
}
