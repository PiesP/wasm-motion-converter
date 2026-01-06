import { TIMEOUT_CONFIG } from './constants';

/**
 * Calculate adaptive timeout based on video duration and format
 * @param format - Output format (gif, webp, mp4)
 * @param durationMs - Video duration in milliseconds
 * @returns Calculated timeout in milliseconds
 */
export function calculateTimeout(format: string, durationMs: number): number {
  const config = TIMEOUT_CONFIG[format.toLowerCase()];

  if (!config) {
    console.warn(`No timeout config for format ${format}, using default 120s`);
    return 120_000; // Default 2 minutes
  }

  const durationSeconds = durationMs / 1000;
  const adaptiveTimeout = config.baseTimeout + durationSeconds * config.perSecondMultiplier;

  // Cap at maximum
  const finalTimeout = Math.min(adaptiveTimeout, config.maxTimeout);

  console.log(
    `[timeout-calculator] ${format} (${durationSeconds.toFixed(1)}s video): ${finalTimeout}ms timeout`
  );

  return finalTimeout;
}

/**
 * Get timeout for format with fallback to default
 * @param format - Output format (gif, webp, mp4)
 * @param durationMs - Optional video duration in milliseconds
 * @returns Timeout in milliseconds
 */
export function getTimeoutForFormat(format: string, durationMs?: number): number {
  if (durationMs && durationMs > 0) {
    return calculateTimeout(format, durationMs);
  }

  // Fallback to base timeout if duration unknown
  const config = TIMEOUT_CONFIG[format.toLowerCase()];
  const fallbackTimeout = config?.baseTimeout ?? 120_000;

  console.log(
    `[timeout-calculator] ${format} (duration unknown): using base timeout ${fallbackTimeout}ms`
  );

  return fallbackTimeout;
}
