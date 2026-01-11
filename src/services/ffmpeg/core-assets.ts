// External dependencies
import { toBlobURL } from '@ffmpeg/util';

// Internal imports
import { FFMPEG_CORE_VERSION, TIMEOUT_FFMPEG_DOWNLOAD } from '@utils/constants';
import { withTimeout } from '@utils/with-timeout';

/**
 * Legacy timeout constant for backward compatibility with external timeout values.
 *
 * Kept here to preserve the exact error message used by the original implementation.
 */
const DOWNLOAD_TIMEOUT_SECONDS = TIMEOUT_FFMPEG_DOWNLOAD / 1000;

/**
 * Cache name for FFmpeg core assets with version identifier.
 */
const FFMPEG_CACHE_NAME = `ffmpeg-core-${FFMPEG_CORE_VERSION}`;

/**
 * Request idle callback with fallback to setTimeout for browsers that don't support it.
 *
 * @param callback - Function to execute during idle time
 * @param options - Idle callback options including timeout
 * @returns Idle callback ID (or setTimeout ID)
 */
export const requestIdle = (
  callback: IdleRequestCallback,
  options?: IdleRequestOptions
): number => {
  if (typeof requestIdleCallback !== 'undefined') {
    return requestIdleCallback(callback, options);
  }
  return window.setTimeout(
    () => callback({ didTimeout: true, timeRemaining: () => 0 }),
    options?.timeout ?? 0
  );
};

/**
 * Check if Cache Storage API is available in current environment.
 */
export const supportsCacheStorage = (): boolean => typeof caches !== 'undefined';

/**
 * Load blob URL with cache awareness.
 * Uses Cache Storage API when available for faster repeat loads.
 * Falls back to direct blob URL creation if caching fails.
 *
 * NOTE: This intentionally mirrors the previous in-file implementation to
 * avoid behavior changes during refactoring.
 */
export async function cacheAwareBlobURL(url: string, mimeType: string): Promise<string> {
  if (!supportsCacheStorage()) {
    return toBlobURL(url, mimeType);
  }

  const cache = await caches.open(FFMPEG_CACHE_NAME);
  const cachedResponse = await cache.match(url);
  if (cachedResponse) {
    const cachedBlob = await cachedResponse.blob();
    return URL.createObjectURL(cachedBlob);
  }

  const response = await fetch(url, { cache: 'force-cache', credentials: 'omit' });
  if (!response.ok) {
    return toBlobURL(url, mimeType);
  }

  await cache.put(url, response.clone());
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

/**
 * Load FFmpeg asset with timeout protection.
 * Wraps cacheAwareBlobURL with configurable timeout for reliability.
 *
 * @param url - URL to load
 * @param mimeType - MIME type for blob creation
 * @param label - Human-readable label for error messages
 * @returns Blob URL that can be used to load the asset
 */
export async function loadFFmpegAsset(
  url: string,
  mimeType: string,
  label: string
): Promise<string> {
  return withTimeout(
    cacheAwareBlobURL(url, mimeType),
    TIMEOUT_FFMPEG_DOWNLOAD,
    `Downloading ${label} timed out after ${DOWNLOAD_TIMEOUT_SECONDS} seconds. Please check your network connection and ensure cdn.jsdelivr.net is reachable.`
  );
}
