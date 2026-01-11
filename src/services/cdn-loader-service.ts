/**
 * CDN Loader Service
 *
 * Generic CDN loading utilities with multi-provider fallback cascade.
 * Extracted from ffmpeg-service.ts pattern for reusability.
 *
 * Features:
 * - Multi-CDN fallback (esm.sh → jsdelivr → unpkg → skypack)
 * - Timeout handling per CDN attempt
 * - Cache-aware fetching (Browser Cache Storage API)
 * - Error handling and logging
 */

import { CDN_PROVIDERS, CDN_REQUEST_TIMEOUT, convertCDNUrl, getCDNUrl } from '@utils/cdn-constants';
import { logger } from '@utils/logger';
import { withTimeout } from '@utils/with-timeout';

import type { CDNProvider, DependencyName } from '@utils/cdn-constants';

/**
 * CDN load result with metadata
 */
export interface CDNLoadResult {
  /**
   * Response from CDN
   */
  response: Response;

  /**
   * CDN provider that successfully served the request
   */
  provider: CDNProvider;

  /**
   * Whether response came from browser cache
   */
  fromCache: boolean;

  /**
   * Load latency in milliseconds
   */
  latency: number;
}

/**
 * CDN load options
 */
export interface CDNLoadOptions {
  /**
   * Timeout for each CDN attempt (default: 15s)
   */
  timeout?: number;

  /**
   * Whether to use browser cache (default: true)
   */
  useCache?: boolean;

  /**
   * Custom CDN provider order (default: from cdn-constants.ts)
   */
  providers?: CDNProvider[];

  /**
   * Cache storage name (default: 'cdn-deps-v1')
   */
  cacheName?: string;
}

/**
 * Default cache name for CDN resources
 */
const DEFAULT_CACHE_NAME = 'cdn-deps-v1';

/**
 * Checks if Cache Storage API is supported
 *
 * @returns True if cache storage is available
 */
function supportsCacheStorage(): boolean {
  return typeof caches !== 'undefined' && typeof caches.open === 'function';
}

/**
 * Fetches resource from CDN with cache awareness
 * Similar to cacheAwareBlobURL from ffmpeg-service.ts but for ESM modules
 *
 * @param url - CDN URL to fetch
 * @param cacheName - Cache storage name
 * @returns Response with cache metadata
 */
async function fetchFromCacheOrNetwork(
  url: string,
  cacheName: string
): Promise<{ response: Response; fromCache: boolean }> {
  if (!supportsCacheStorage()) {
    const response = await fetch(url, { cache: 'force-cache', credentials: 'omit' });
    return { response, fromCache: false };
  }

  // Try cache first
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(url);

  if (cachedResponse) {
    logger.info('general', `CDN Cache hit: ${url}`);
    return { response: cachedResponse, fromCache: true };
  }

  // Cache miss - fetch from network
  const response = await fetch(url, { cache: 'force-cache', credentials: 'omit' });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  // Store in cache for future use
  await cache.put(url, response.clone());
  logger.info('general', `CDN Cache stored: ${url}`);

  return { response, fromCache: false };
}

/**
 * Attempts to load resource from a single CDN provider
 *
 * @param url - CDN URL to try
 * @param provider - CDN provider name
 * @param options - Load options
 * @returns Load result or throws on failure
 */
async function tryLoadFromCDN(
  url: string,
  provider: CDNProvider,
  options: Required<CDNLoadOptions>
): Promise<CDNLoadResult> {
  const startTime = performance.now();

  try {
    const fetchPromise = options.useCache
      ? fetchFromCacheOrNetwork(url, options.cacheName)
      : fetch(url, { cache: 'no-store', credentials: 'omit' }).then((r) => ({
          response: r,
          fromCache: false,
        }));

    const { response, fromCache } = await withTimeout(
      fetchPromise,
      options.timeout,
      `CDN request to ${provider} timed out after ${options.timeout}ms`
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const latency = performance.now() - startTime;

    logger.info('general', `CDN: Successfully loaded from ${provider}`, {
      url,
      fromCache,
      latency: `${latency.toFixed(2)}ms`,
    });

    return { response, provider, fromCache, latency };
  } catch (error) {
    const latency = performance.now() - startTime;

    logger.warn('general', `CDN: Failed to load from ${provider}`, {
      url,
      error: error instanceof Error ? error.message : String(error),
      latency: `${latency.toFixed(2)}ms`,
    });

    throw error;
  }
}

/**
 * Loads ESM module from CDN with cascade fallback
 *
 * Tries each CDN provider in order until one succeeds.
 * Returns metadata about successful load for telemetry.
 *
 * @param dependency - Package name
 * @param subExport - Optional sub-export path (e.g., 'web' for solid-js/web)
 * @param options - Load options
 * @returns Load result from successful CDN
 * @throws Error if all CDN providers fail
 *
 * @example
 * // Load solid-js from CDN with fallback
 * const result = await loadFromCDN('solid-js');
 * console.log(`Loaded from ${result.provider} in ${result.latency}ms`);
 *
 * @example
 * // Load solid-js/web sub-export
 * const result = await loadFromCDN('solid-js', 'web');
 */
export async function loadFromCDN(
  dependency: DependencyName,
  subExport?: string,
  options: CDNLoadOptions = {}
): Promise<CDNLoadResult> {
  const opts: Required<CDNLoadOptions> = {
    timeout: options.timeout ?? CDN_REQUEST_TIMEOUT,
    useCache: options.useCache ?? true,
    providers: options.providers ?? [...CDN_PROVIDERS],
    cacheName: options.cacheName ?? DEFAULT_CACHE_NAME,
  };

  const errors: Array<{ provider: CDNProvider; error: Error }> = [];

  // Try each CDN provider in order
  for (const provider of opts.providers) {
    const url = getCDNUrl(dependency, provider, subExport);

    try {
      return await tryLoadFromCDN(url, provider, opts);
    } catch (error) {
      errors.push({
        provider,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      // Continue to next provider
    }
  }

  // All providers failed
  const errorMessage = `Failed to load ${dependency}${subExport ? `/${subExport}` : ''} from all CDN providers (${opts.providers.join(', ')})`;
  logger.error('general', `CDN: ${errorMessage}`, { errors });

  throw new Error(errorMessage);
}

/**
 * Loads resource from URL with cascade fallback to alternative CDNs
 * Used by Service Worker to handle requests with fallback
 *
 * @param originalUrl - Original CDN URL that failed
 * @param options - Load options
 * @returns Load result from successful CDN
 * @throws Error if all alternatives fail
 *
 * @example
 * // In Service Worker fetch handler
 * try {
 *   const result = await loadWithCascade(event.request.url);
 *   return result.response;
 * } catch {
 *   // All CDNs failed, use fallback bundle
 * }
 */
export async function loadWithCascade(
  originalUrl: string,
  options: CDNLoadOptions = {}
): Promise<CDNLoadResult> {
  const opts: Required<CDNLoadOptions> = {
    timeout: options.timeout ?? CDN_REQUEST_TIMEOUT,
    useCache: options.useCache ?? true,
    providers: options.providers ?? [...CDN_PROVIDERS],
    cacheName: options.cacheName ?? DEFAULT_CACHE_NAME,
  };

  const errors: Array<{ provider: string; error: Error }> = [];

  // Try original URL first
  const originalDomain = new URL(originalUrl).hostname;
  const primaryProvider = CDN_PROVIDERS.find((p) => originalDomain.includes(p)) ?? CDN_PROVIDERS[0];

  try {
    return await tryLoadFromCDN(originalUrl, primaryProvider, opts);
  } catch (error) {
    errors.push({
      provider: primaryProvider,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  // Try alternative CDNs
  for (const provider of opts.providers) {
    if (provider === primaryProvider) continue; // Already tried

    const alternativeUrl = convertCDNUrl(originalUrl, provider);
    if (!alternativeUrl) continue; // Couldn't convert URL

    try {
      return await tryLoadFromCDN(alternativeUrl, provider, opts);
    } catch (error) {
      errors.push({
        provider,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  // All CDNs failed
  const errorMessage = `Failed to load ${originalUrl} from all CDN alternatives`;
  logger.error('general', `CDN: ${errorMessage}`, { errors });

  throw new Error(errorMessage);
}

/**
 * Preloads dependencies into cache
 * Useful for warming cache during idle time or app initialization
 *
 * @param dependencies - List of dependencies to preload
 * @param options - Load options
 * @returns Array of load results (successful loads only)
 *
 * @example
 * // Preload all dependencies during app startup
 * await preloadDependencies(['solid-js', 'modern-gif', 'comlink']);
 */
export async function preloadDependencies(
  dependencies: DependencyName[],
  options: CDNLoadOptions = {}
): Promise<CDNLoadResult[]> {
  const results = await Promise.allSettled(
    dependencies.map((dep) => loadFromCDN(dep, undefined, options))
  );

  return results
    .filter((r): r is PromiseFulfilledResult<CDNLoadResult> => r.status === 'fulfilled')
    .map((r) => r.value);
}

/**
 * Clears CDN cache storage
 * Useful for debugging or forcing fresh fetch
 *
 * @param cacheName - Cache storage name (default: 'cdn-deps-v1')
 */
export async function clearCDNCache(cacheName = DEFAULT_CACHE_NAME): Promise<void> {
  if (!supportsCacheStorage()) {
    logger.warn('general', 'CDN: Cache Storage API not supported');
    return;
  }

  const deleted = await caches.delete(cacheName);

  if (deleted) {
    logger.info('general', `CDN: Cleared cache: ${cacheName}`);
  } else {
    logger.warn('general', `CDN: Cache not found: ${cacheName}`);
  }
}
