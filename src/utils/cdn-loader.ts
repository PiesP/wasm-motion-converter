import { getProviderByHostname } from '@services/cdn/cdn-config';
import { getAllHealthMetrics, recordCdnRequest } from '@services/cdn/cdn-health-tracker';
import { getErrorMessage } from './error-utils';
import { logger } from './logger';

type CdnHealthMetrics = Record<string, { successRate?: number }>;

function getProviderForUrl(cdnUrl: string) {
  try {
    const hostname = new URL(cdnUrl).hostname;
    return getProviderByHostname(hostname);
  } catch {
    return undefined;
  }
}

function orderUrlsByHealth(cdnUrls: string[], moduleName: string): string[] {
  let metrics: CdnHealthMetrics = {};
  try {
    metrics = getAllHealthMetrics() as CdnHealthMetrics;
  } catch {
    metrics = {};
  }

  const ordered = cdnUrls
    .map((cdn, index) => {
      const provider = getProviderForUrl(cdn);
      const metric = provider ? metrics[provider.hostname] : undefined;
      const score = metric?.successRate ?? (provider ? provider.healthScore / 100 : 0);
      return { cdn, index, score };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })
    .map((entry) => entry.cdn);

  if (ordered.join('|') !== cdnUrls.join('|')) {
    logger.debug('cdn', 'Reordered CDN candidates by health', {
      moduleName,
      ordered,
    });
  }

  return ordered;
}

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
 *   buildRuntimeModuleUrls('mp4box'),
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
  const orderedUrls = orderUrlsByHealth(cdnUrls, moduleName);

  for (const cdn of orderedUrls) {
    const provider = getProviderForUrl(cdn);
    try {
      logger.info('demuxer', `Attempting to load ${moduleName} from CDN`, {
        cdn,
        timeout: timeoutMs,
        provider: provider?.name ?? 'unknown',
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

      if (provider) {
        recordCdnRequest(provider.hostname, true);
      }

      // Extract default export if available, otherwise return module as-is
      return (module as unknown as { default?: T }).default || (module as T);
    } catch (error) {
      const reason = getErrorMessage(error);
      errors.push({ cdn, reason });

      logger.warn('demuxer', `Failed to load ${moduleName} from CDN`, {
        cdn,
        error: reason,
      });

      if (provider) {
        recordCdnRequest(provider.hostname, false);
      }
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
