/**
 * Internal constants for FFmpeg service configuration
 * Centralizes all hardcoded values for easier tuning and testing
 */

export const FFMPEG_INTERNALS = {
  // File names used in FFmpeg virtual filesystem
  INPUT_FILE_NAME: 'input.mp4',
  PALETTE_FILE_NAME: 'palette.png',

  // Cache configuration (in milliseconds)
  INPUT_CACHE_TTL_MS: 120_000, // 2 minutes
  INPUT_CACHE_POST_CONVERT_MS: 60_000, // 1 minute after conversion

  // Progress configuration
  PROGRESS_THROTTLE_MS: 220, // Minimum time between progress emissions
  HEARTBEAT_INTERVAL_MS: 5000, // Progress heartbeat update interval

  // Watchdog configuration
  WATCHDOG_CHECK_INTERVAL_MS: 10_000, // How often to check for stalls
  WATCHDOG_STALL_TIMEOUT_MS: 90_000, // Timeout for detecting stalled conversions

  // Termination configuration
  TERMINATION_SETTLE_MS: 200, // Time to wait after termination
  TERMINATION_CHECK_INTERVAL_MS: 100, // How often to check termination status
  MAX_TERMINATION_WAIT_MS: 5_000, // Maximum time to wait for termination

  // Progress range constants for consistent UX
  PROGRESS: {
    GIF: {
      START: 0,
      PALETTE_START: 10,
      PALETTE_END: 40,
      CONVERSION_START: 40,
      CONVERSION_END: 90,
      COMPLETE: 100,
    },
    WEBP: {
      START: 0,
      CONVERSION_START: 10,
      CONVERSION_END: 90,
      COMPLETE: 100,
    },
  },

  // Heartbeat estimation parameters
  HEARTBEAT_DURATION_MULTIPLIER: 1.5, // Multiplier for estimated duration
  HEARTBEAT_MAX_COMPLETION: 0.95, // Cap heartbeat progress at 95% of estimate

  // FFmpeg log buffer configuration
  FFMPEG_LOG_BUFFER_SIZE: 100, // Maximum number of log entries to keep

  // Adaptive watchdog timeout multipliers
  WATCHDOG_MULTIPLIERS: {
    RESOLUTION_4K: 5.0, // 5x timeout for 4K+ video (3840x2160+)
    RESOLUTION_FHD: 2.0, // 2x timeout for FHD (1920x1080+)
    LONG_DURATION: 2.0, // 2x timeout for videos >5min
    HIGH_QUALITY: 1.5, // 1.5x timeout for high quality settings
  },
} as const;

/**
 * Type-safe access to progress constants
 */
export type FFmpegProgressRange =
  | typeof FFMPEG_INTERNALS.PROGRESS.GIF
  | typeof FFMPEG_INTERNALS.PROGRESS.WEBP;

/**
 * Calculate adaptive watchdog timeout based on video characteristics
 * Scales timeout for complex conversions to prevent false positives
 *
 * @param baseTimeoutMs - Base timeout in milliseconds (default: WATCHDOG_STALL_TIMEOUT_MS)
 * @param options - Video and conversion characteristics
 * @returns Adaptive timeout in milliseconds
 */
export function calculateAdaptiveWatchdogTimeout(
  baseTimeoutMs: number = FFMPEG_INTERNALS.WATCHDOG_STALL_TIMEOUT_MS,
  options: {
    resolution?: { width: number; height: number };
    duration?: number; // in seconds
    quality?: 'low' | 'medium' | 'high';
  } = {}
): number {
  let multiplier = 1.0;

  // Scale based on resolution
  if (options.resolution) {
    const { width, height } = options.resolution;
    const totalPixels = width * height;

    if (totalPixels >= 3840 * 2160) {
      // 4K or higher
      multiplier *= FFMPEG_INTERNALS.WATCHDOG_MULTIPLIERS.RESOLUTION_4K;
    } else if (totalPixels >= 1920 * 1080) {
      // Full HD
      multiplier *= FFMPEG_INTERNALS.WATCHDOG_MULTIPLIERS.RESOLUTION_FHD;
    }
  }

  // Scale based on duration (>5 minutes = long video)
  if (options.duration && options.duration > 300) {
    multiplier *= FFMPEG_INTERNALS.WATCHDOG_MULTIPLIERS.LONG_DURATION;
  }

  // Scale based on quality setting
  if (options.quality === 'high') {
    multiplier *= FFMPEG_INTERNALS.WATCHDOG_MULTIPLIERS.HIGH_QUALITY;
  }

  const adaptiveTimeout = Math.round(baseTimeoutMs * multiplier);

  return adaptiveTimeout;
}
