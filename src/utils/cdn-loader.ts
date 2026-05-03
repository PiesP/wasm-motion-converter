import { getErrorMessage } from './error-utils';
import { logger } from './logger';

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

      logger.info('demuxer', `Successfully loaded ${moduleName} from CDN`, { cdn });

      return (module as unknown as { default?: T }).default || (module as T);
    } catch (error) {
      const reason = getErrorMessage(error);
      errors.push({ cdn, reason });
      logger.warn('demuxer', `Failed to load ${moduleName} from CDN`, { cdn, error: reason });
    }
  }

  logger.error('demuxer', `All CDN sources failed for ${moduleName}`, {
    moduleName,
    attemptCount: cdnUrls.length,
    errors,
  });

  throw new Error(`Failed to load ${moduleName} from all CDN sources (${cdnUrls.length} attempts)`);
}
