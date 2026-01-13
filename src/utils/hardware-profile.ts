import { readSessionString, writeSessionString } from './session-cache';

/**
 * Get hardware profile fingerprint for cache invalidation
 *
 * Returns a stable hash that changes when hardware capabilities change
 */
function getHardwareFingerprint(): string {
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
  const protectedKeys = new Set(['dropconvert:hardware:fingerprint']);
  const prefixesToRemove = [
    // Capture caches (mode + perf + reliability)
    'dropconvert:capture:',
    'dropconvert:captureReliability:',
    // Encoder tuning caches
    'dropconvert:webp:',
    // VFS tuning caches
    'dropconvert:vfs:',
  ];

  try {
    if (typeof sessionStorage === 'undefined') {
      return;
    }

    // Iterate backwards to safely remove while scanning.
    for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
      const key = sessionStorage.key(i);
      if (!key) {
        continue;
      }
      if (protectedKeys.has(key)) {
        continue;
      }

      const shouldRemove = prefixesToRemove.some((prefix) => key.startsWith(prefix));
      if (!shouldRemove) {
        continue;
      }

      try {
        sessionStorage.removeItem(key);
      } catch {
        // Ignore
      }
    }
  } catch {
    // Ignore storage failures
  }
}
