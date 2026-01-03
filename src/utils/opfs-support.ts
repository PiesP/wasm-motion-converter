/**
 * OPFS (Origin Private File System) utilities for browser-based file operations
 * Provides disk-based storage instead of memory-based for handling large files
 */

/**
 * Check if OPFS is supported in the current browser
 * OPFS requires:
 * - Chrome/Edge 102+
 * - Firefox 111+
 * - Safari 15.2+
 */
export function isOPFSSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'storage' in navigator &&
    'getDirectory' in navigator.storage
  );
}

/**
 * Check if OPFS with AccessHandle API is supported
 * AccessHandle provides synchronous file operations needed by WASM
 * Chrome/Edge 102+, Firefox 111+, Safari 16.4+
 */
export async function isOPFSAccessHandleSupported(): Promise<boolean> {
  if (!isOPFSSupported()) {
    return false;
  }

  try {
    const root = await navigator.storage.getDirectory();
    const testFile = await root.getFileHandle('opfs-test', { create: true });
    // @ts-expect-error - createSyncAccessHandle is experimental
    const accessHandle = await testFile.createSyncAccessHandle();
    await accessHandle.close();
    await root.removeEntry('opfs-test');
    return true;
  } catch {
    return false;
  }
}

/**
 * Get estimated storage quota for OPFS
 */
export async function getStorageEstimate(): Promise<{
  quota: number;
  usage: number;
  available: number;
} | null> {
  if (!navigator.storage || !navigator.storage.estimate) {
    return null;
  }

  try {
    const estimate = await navigator.storage.estimate();
    const quota = estimate.quota || 0;
    const usage = estimate.usage || 0;
    const available = quota - usage;

    return {
      quota,
      usage,
      available,
    };
  } catch (error) {
    console.error('[OPFS] Failed to get storage estimate:', error);
    return null;
  }
}

/**
 * Format storage size in human-readable format
 */
export function formatStorageSize(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  const mb = bytes / (1024 * 1024);

  if (gb >= 1) {
    return `${gb.toFixed(2)} GB`;
  }
  return `${mb.toFixed(2)} MB`;
}

/**
 * Log OPFS capabilities and storage info
 */
export async function logOPFSStatus(): Promise<void> {
  const supported = isOPFSSupported();
  const accessHandleSupported = await isOPFSAccessHandleSupported();
  const storageEstimate = await getStorageEstimate();

  console.log('[OPFS] Status:', {
    supported,
    accessHandleSupported,
    storageEstimate: storageEstimate
      ? {
          quota: formatStorageSize(storageEstimate.quota),
          usage: formatStorageSize(storageEstimate.usage),
          available: formatStorageSize(storageEstimate.available),
        }
      : null,
  });
}
