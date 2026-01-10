import { getErrorMessage } from './error-utils';
import { logger } from './logger';

/**
 * Load ECMAScript module from multiple CDN sources with automatic fallback
 *
 * Attempts to load a module from a primary CDN with fallbacks.
 * Each CDN request has a configurable timeout. Logs all attempts and results.
 * Extracts default export if present, otherwise returns module as-is.
 *
 * @template T - Type of the loaded module
 * @param moduleName - Descriptive name of the module (for logging)
 * @param cdnUrls - Array of CDN URLs in priority order
 * @param timeoutMs - Timeout per CDN request in milliseconds (default: 15000)
 * @returns Loaded module (type T)
 * @throws Error if all CDN sources fail
 *
 * @example
 * ```typescript
 * const mp4Box = await loadFromCDN<MP4BoxModule>(
 *   'mp4box.js',
 *   ['https://esm.sh/mp4box@0.5.2', 'https://cdn.jsdelivr.net/npm/mp4box@0.5.2/+esm'],
 *   15000
 * );
 * ```
 */
export async function loadFromCDN<T>(
  moduleName: string,
  cdnUrls: string[],
  timeoutMs: number = 15000
): Promise<T> {
  const errors: Array<{ cdn: string; reason: string }> = [];

  for (const cdn of cdnUrls) {
    try {
      logger.info('demuxer', `Attempting to load ${moduleName} from CDN`, {
        cdn,
        timeout: timeoutMs,
      });

      const module = await Promise.race([
        import(/* @vite-ignore */ cdn),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('CDN timeout')), timeoutMs)
        ),
      ]);

      logger.info('demuxer', `Successfully loaded ${moduleName} from CDN`, {
        cdn,
      });

      // Extract default export if available, otherwise return module as-is
      return (module as unknown as { default?: T }).default || (module as T);
    } catch (error) {
      const reason = getErrorMessage(error);
      errors.push({ cdn, reason });

      logger.warn('demuxer', `Failed to load ${moduleName} from CDN`, {
        cdn,
        error: reason,
      });
    }
  }

  // All CDN sources exhausted
  logger.error('demuxer', `All CDN sources failed for ${moduleName}`, {
    moduleName,
    attemptCount: cdnUrls.length,
    errors,
  });

  throw new Error(`Failed to load ${moduleName} from all CDN sources (${cdnUrls.length} attempts)`);
}
