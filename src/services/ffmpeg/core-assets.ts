// External dependencies
import { toBlobURL } from '@ffmpeg/util';

// Internal imports
import { FFMPEG_CORE_VERSION } from '@utils/constants';
import { withTimeout } from '@utils/with-timeout';
import { getEnabledProviders } from '@services/cdn/cdn-config';
import { buildAssetUrl } from '@services/cdn/cdn-url-builder';
import { recordCdnRequest } from '@services/cdn/cdn-health-tracker';

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
 * Load FFmpeg asset with CDN fallback and timeout protection.
 * Tries all enabled CDN providers in order until one succeeds.
 *
 * @param assetPath - Path to the asset (e.g., "ffmpeg-core.js")
 * @param mimeType - MIME type for blob creation
 * @param label - Human-readable label for error messages
 * @returns Blob URL that can be used to load the asset
 */
export async function loadFFmpegAsset(
  assetPath: string,
  mimeType: string,
  label: string
): Promise<string> {
  const providers = getEnabledProviders();
  const errors: Array<{ provider: string; error: string }> = [];

  console.log(`[FFmpeg Asset] Loading ${label} from ${providers.length} CDN providers`);

  for (const provider of providers) {
    try {
      // Build URL for this CDN provider
      const url = buildAssetUrl(
        provider,
        '@ffmpeg/core-mt',
        FFMPEG_CORE_VERSION,
        `/dist/esm/${assetPath}`
      );

      console.log(`[FFmpeg Asset] Trying ${provider.name}: ${url}`);

      const startTime = performance.now();

      // Load with timeout
      const blobUrl = await withTimeout(
        cacheAwareBlobURL(url, mimeType),
        provider.timeout,
        `Timeout after ${provider.timeout / 1000}s`
      );

      const elapsed = performance.now() - startTime;

      // Record success
      recordCdnRequest(provider.hostname, true);

      console.log(
        `[FFmpeg Asset] ✓ ${provider.name}: ${label} loaded successfully (${elapsed.toFixed(0)}ms)`
      );

      return blobUrl;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push({ provider: provider.name, error: errorMsg });

      // Record failure
      recordCdnRequest(provider.hostname, false);

      console.warn(`[FFmpeg Asset] ✗ ${provider.name}: ${label} failed - ${errorMsg}`);

      // Continue to next CDN
    }
  }

  // All CDNs failed
  const errorSummary = errors.map((e) => `${e.provider} (${e.error})`).join(', ');
  throw new Error(
    `Failed to download ${label} from all CDN providers. Errors: ${errorSummary}. Please check your network connection.`
  );
}
