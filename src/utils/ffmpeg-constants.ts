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
} as const;

/**
 * Type-safe access to progress constants
 */
export type FFmpegProgressRange = typeof FFMPEG_INTERNALS.PROGRESS.GIF | typeof FFMPEG_INTERNALS.PROGRESS.WEBP;
