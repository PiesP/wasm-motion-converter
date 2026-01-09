import { readSessionString, writeSessionString } from './session-cache';

/**
 * Get hardware profile fingerprint for cache invalidation
 *
 * Returns a stable hash that changes when hardware capabilities change
 */
export function getHardwareFingerprint(): string {
  const cores = navigator.hardwareConcurrency || 4;

  // Memory tier (512MB buckets to avoid invalidation on minor changes)
  // performance.memory is non-standard (Chrome-only)
  const memInfo = (performance as Performance & { memory?: { jsHeapSizeLimit: number } }).memory;
  const memoryTier = memInfo ? Math.floor(memInfo.jsHeapSizeLimit / (512 * 1024 * 1024)) : 8; // Default: 4GB

  // Fingerprint format: "cores_memoryTier"
  return `${cores}_${memoryTier}`;
}

/**
 * Check if cached data is valid for current hardware
 *
 * @returns true if cache is valid, false if hardware changed
 */
export function isHardwareCacheValid(): boolean {
  const currentFingerprint = getHardwareFingerprint();
  const cachedFingerprint = readSessionString('dropconvert:hardware:fingerprint');

  if (!cachedFingerprint) {
    // First run, write fingerprint
    writeSessionString('dropconvert:hardware:fingerprint', currentFingerprint);
    return false; // No cache yet
  }

  if (cachedFingerprint !== currentFingerprint) {
    // Hardware changed, invalidate all caches
    clearSessionCache();
    writeSessionString('dropconvert:hardware:fingerprint', currentFingerprint);
    return false;
  }

  return true;
}

/**
 * Clear all performance-related session caches
 */
function clearSessionCache(): void {
  const keysToRemove = [
    'dropconvert:capture:success:av1',
    'dropconvert:capture:success:h264',
    'dropconvert:capture:success:hevc',
    'dropconvert:capture:success:vp9',
    'dropconvert:vfs:batchSize',
    'dropconvert:webp:chunkSize',
    'dropconvert:captureReliability:av1:frame-callback:failures', // 기존 키
  ];

  for (const key of keysToRemove) {
    try {
      sessionStorage?.removeItem(key);
    } catch {
      // Ignore
    }
  }
}
