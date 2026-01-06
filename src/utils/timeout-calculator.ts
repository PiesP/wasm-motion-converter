import { logger } from './logger';
import { TIMEOUT_CONFIG } from './constants';

/**
 * Supported output formats for timeout calculation
 */
type TimeoutFormat = 'gif' | 'webp' | 'mp4';

/**
 * Calculate adaptive timeout based on video duration and format
 *
 * Strategy:
 * - Base timeout: minimum time for format encoding
 * - Per-second multiplier: additional time needed per second of video
 * - Maximum timeout: prevents excessively long timeouts for long videos
 * - Formula: min(baseTimeout + durationSeconds × multiplier, maxTimeout)
 *
 * @param format - Output format (gif/webp/mp4)
 * @param durationMs - Video duration in milliseconds (must be >= 0)
 * @returns Calculated timeout in milliseconds (minimum 10 seconds)
 * @throws Error if format is unsupported or durationMs is negative
 *
 * @example
 * // For 30-second GIF conversion with typical config
 * const timeout = calculateTimeout('gif', 30_000); // Returns adaptive timeout
 *
 * @example
 * // For 2-minute MP4 conversion
 * const timeout = calculateTimeout('mp4', 120_000); // Returns timeout capped at max
 */
export function calculateTimeout(format: TimeoutFormat, durationMs: number): number {
  // Validate inputs
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error(`Invalid durationMs: ${durationMs}. Must be a non-negative number.`);
  }

  const normalizedFormat = format.toLowerCase();
  const config = TIMEOUT_CONFIG[normalizedFormat];

  if (!config) {
    logger.warn('general', 'No timeout config for format, using default', {
      format,
      available: Object.keys(TIMEOUT_CONFIG),
    });
    return 120_000; // Default 2 minutes
  }

  const durationSeconds = durationMs / 1000;
  const adaptiveTimeout = config.baseTimeout + durationSeconds * config.perSecondMultiplier;

  // Cap at maximum to prevent runaway timeouts
  const finalTimeout = Math.min(adaptiveTimeout, config.maxTimeout);

  logger.info('performance', 'Calculated adaptive timeout', {
    format,
    durationSeconds: Number(durationSeconds.toFixed(1)),
    baseTimeout: config.baseTimeout,
    adaptiveTimeout: Math.round(adaptiveTimeout),
    finalTimeout,
  });

  return finalTimeout;
}

/**
 * Get timeout for format with fallback to base timeout
 *
 * Provides a convenient way to get timeout with optional duration.
 * Falls back to base timeout if duration is unknown or invalid.
 *
 * @param format - Output format (gif/webp/mp4)
 * @param durationMs - Optional video duration in milliseconds
 * @returns Timeout in milliseconds (minimum 10 seconds, maximum per format config)
 * @throws Error if format is unsupported
 *
 * @example
 * // With known duration
 * const timeout = getTimeoutForFormat('gif', 45_000);
 *
 * @example
 * // Without duration (uses base timeout)
 * const timeout = getTimeoutForFormat('webp');
 */
export function getTimeoutForFormat(format: TimeoutFormat, durationMs?: number): number {
  // Use adaptive timeout if duration is provided and valid
  if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0) {
    return calculateTimeout(format, durationMs);
  }

  // Fallback to base timeout if duration unknown or invalid
  const normalizedFormat = format.toLowerCase();
  const config = TIMEOUT_CONFIG[normalizedFormat];

  if (!config) {
    logger.warn('general', 'No timeout config for format, using default', {
      format,
      available: Object.keys(TIMEOUT_CONFIG),
    });
    return 120_000;
  }

  const fallbackTimeout = config.baseTimeout;

  logger.info('performance', 'Using base timeout (duration unavailable)', {
    format,
    baseTimeout: fallbackTimeout,
    reason: durationMs === undefined ? 'duration not provided' : 'invalid duration',
  });

  return fallbackTimeout;
}
