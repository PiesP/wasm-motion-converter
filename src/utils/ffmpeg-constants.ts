/**
 * FFmpeg service internal constants and configuration
 *
 * This module centralizes all hardcoded configuration values used by FFmpegService,
 * including file I/O constants, cache settings, timeout configurations, progress tracking ranges,
 * and adaptive watchdog multipliers. Centralizing these values enables:
 * - Consistent behavior across conversion operations
 * - Easy tuning and testing of service parameters
 * - Clear documentation of timing and threshold decisions
 * - Single source of truth for all FFmpeg-related constants
 *
 * Key sections:
 * - **File I/O**: Input/output file names, cache TTL
 * - **Timeouts & Monitoring**: Watchdog intervals, stall detection, heartbeat timing
 * - **Progress Ranges**: Percentage breakpoints for GIF, WebP, WebCodecs, AV1 pipelines
 * - **Validation**: Minimum file sizes for output validation
 * - **Transcoding**: AV1-specific H.264 transcode configuration
 * - **Adaptive Timeouts**: Dynamic timeout scaling for complex videos
 */

export const FFMPEG_INTERNALS = {
  // File names used in FFmpeg virtual filesystem
  /** File name for input video in the virtual filesystem. */
  INPUT_FILE_NAME: 'input.mp4',
  /** File name for GIF palette image in the virtual filesystem. */
  PALETTE_FILE_NAME: 'palette.png',

  // Cache configuration (in milliseconds)
  /** Time-to-live for input file in cache (prevents re-reading same file). Set to 2 minutes. */
  INPUT_CACHE_TTL_MS: 120_000, // 2 minutes
  /** Cache retention time after successful conversion (allows quick re-use). Set to 1 minute. */
  INPUT_CACHE_POST_CONVERT_MS: 60_000, // 1 minute after conversion

  // Progress configuration
  /** Minimum time between progress event emissions to prevent excessive updates. Throttles at ~220ms. */
  PROGRESS_THROTTLE_MS: 220, // Minimum time between progress emissions
  /** Interval for heartbeat progress updates when no frame progress is detected. Set to 5 seconds. */
  HEARTBEAT_INTERVAL_MS: 5000, // Progress heartbeat update interval

  // Watchdog configuration (detects stalled/hung conversions)
  /** Interval for checking conversion progress (stall detection). Set to 10 seconds. */
  WATCHDOG_CHECK_INTERVAL_MS: 10_000, // How often to check for stalls
  /** Base timeout for detecting stalled conversions. Adaptive multipliers may increase this. Set to 90 seconds. */
  WATCHDOG_STALL_TIMEOUT_MS: 90_000, // Timeout for detecting stalled conversions

  // Termination configuration (cleanup and shutdown)
  /** Grace period after termination signal before force-kill. Set to 200ms. */
  TERMINATION_SETTLE_MS: 200, // Time to wait after termination
  /** Poll interval for checking if FFmpeg has terminated cleanly. Set to 100ms. */
  TERMINATION_CHECK_INTERVAL_MS: 100, // How often to check termination status
  /** Maximum time to wait for graceful termination before force-kill. Set to 5 seconds. */
  MAX_TERMINATION_WAIT_MS: 5_000, // Maximum time to wait for termination

  // Output validation thresholds (prevents corrupt/empty output files)
  OUTPUT_VALIDATION: {
    /** Minimum file size for any output (prevents 0-byte or corrupt files). Set to 100 bytes. */
    MIN_FILE_SIZE_BYTES: 100, // Minimum valid output (prevents 0-byte files)
    /** Minimum GIF file size (includes GIF header and at least one frame). Set to 50 bytes. */
    MIN_GIF_SIZE_BYTES: 50, // GIF header + minimal frame
    /** Minimum WebP file size (includes WebP header and minimal data). Set to 50 bytes. */
    MIN_WEBP_SIZE_BYTES: 50, // WebP header + minimal frame
  },

  // AV1 transcode settings (FFmpeg lacks AV1 decoder, so we transcode AV1→H.264→GIF/WebP)
  AV1_TRANSCODE: {
    /** Temporary file name for AV1→H.264 transcode intermediate. */
    TEMP_H264_FILE: 'temp_h264.mp4',
    /** FFmpeg analyzeduration for probing complex AV1 streams. Set to 10 seconds (10,000,000 microseconds). */
    PROBE_DURATION_MS: 10_000_000, // 10s analyzeduration for complex streams
    /** FFmpeg probesize for difficult AV1 decodes. Set to 100MB. */
    PROBE_SIZE_MB: 100, // 100MB probesize for difficult decodes
    /** H.264 CRF quality for intermediate transcode (18=high quality, lower=better). */
    INTERMEDIATE_CRF: 18, // High quality intermediate
    /** H.264 encoding preset for intermediate transcode (medium balances speed/quality). */
    INTERMEDIATE_PRESET: 'medium', // Balance speed/quality
  },

  // Progress range constants for consistent UX (percentage breakpoints for different conversion pipelines)
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
    WEBCODECS: {
      DECODE_START: 10,
      DECODE_END: 50,
      ENCODE_START: 50,
      ENCODE_END: 90,
    },
    AV1_TRANSCODE: {
      DECODE_START: 20, // AV1→H.264 decode phase
      DECODE_END: 60,
      ENCODE_START: 60, // H.264→output encode phase
      ENCODE_END: 90,
    },
  },

  // Heartbeat estimation parameters (for progress updates when no frame progress detected)
  /** Multiplier for estimated duration used in heartbeat calculations. Set to 1.5x to be conservative. */
  HEARTBEAT_DURATION_MULTIPLIER: 1.5, // Multiplier for estimated duration
  /** Maximum progress percentage during heartbeat updates (caps at 99% to prevent visible 99% stall). */
  HEARTBEAT_MAX_COMPLETION: 0.99, // Cap heartbeat progress at 99% of estimate (reduce visible stall)

  // FFmpeg log silence monitoring (detects stalled conversions by checking log activity)
  /** Timeout threshold for FFmpeg log silence. Warn after 20 seconds without log activity. */
  LOG_SILENCE_TIMEOUT_MS: 20_000, // Warn if no FFmpeg logs for 20s
  /** Interval for checking FFmpeg log activity. Set to 5 seconds. */
  LOG_SILENCE_CHECK_INTERVAL_MS: 5_000,
  /** Strike threshold for log silence. After 3 silence checks in a row, abort as stalled. */
  LOG_SILENCE_MAX_STRIKES: 3, // After 3 silence intervals, abort as stalled

  // FFmpeg log buffer configuration (ring buffer for log history)
  /** Maximum number of FFmpeg log entries to keep in memory (ring buffer). Set to 100 entries. */
  FFMPEG_LOG_BUFFER_SIZE: 100, // Maximum number of log entries to keep

  // Adaptive watchdog timeout multipliers (scales base timeout based on video complexity)
  WATCHDOG_MULTIPLIERS: {
    /** Timeout multiplier for 4K and higher resolution (3840×2160+). Increases by 5x due to processing complexity. */
    RESOLUTION_4K: 5.0, // 5x timeout for 4K+ video (3840x2160+)
    /** Timeout multiplier for Full HD resolution (1920×1080+). Increases by 2x. */
    RESOLUTION_FHD: 2.0, // 2x timeout for FHD (1920x1080+)
    /** Timeout multiplier for long videos (>5 minutes duration). Increases by 2x. */
    LONG_DURATION: 2.0, // 2x timeout for videos >5min
    /** Timeout multiplier for high quality conversions. Increases by 1.5x (slower encoding). */
    HIGH_QUALITY: 1.5, // 1.5x timeout for high quality settings
  },

  // WebCodecs frame extraction configuration (GPU video decoding and frame capture)
  WEBCODECS: {
    /** Image format for extracted video frames. Set to PNG for lossless quality. */
    FRAME_FORMAT: 'png',
    /** PNG compression quality for extracted frames. Set to 0.92 (92% quality). */
    FRAME_QUALITY: 0.92,
    /** Prefix for frame file names in virtual filesystem. */
    FRAME_FILE_PREFIX: 'frame_',
    /** Number of digits for frame file numbering (0-padded). Set to 6 digits (0000000-999999). */
    FRAME_FILE_DIGITS: 6,
    /** Starting frame number for sequential file naming. Set to 0. */
    FRAME_START_NUMBER: 0,
    /** Timeout for retrieving video metadata (width, height, duration). Set to 5 seconds. */
    METADATA_TIMEOUT_MS: 5000,
    /** Timeout for seeking to a specific video position. Set to 5 seconds. */
    SEEK_TIMEOUT_MS: 5000,
    /** Timeout for extracting a single frame. Set to 7 seconds. */
    FRAME_STALL_TIMEOUT_MS: 7000,
    /** Maximum total time for WebCodecs video decode operation (fail-fast if stalling). Set to 60 seconds. */
    MAX_TOTAL_DECODE_MS: 60000, // 60s max for WebCodecs decode (fail-fast if stalling)
  },
} as const;

/**
 * Type-safe access to progress range constants
 *
 * Union of progress range objects for different conversion pipelines (GIF, WebP, WebCodecs).
 * Each pipeline has its own progress breakpoints representing percentage completion at different stages.
 * Use this type to ensure progress objects are one of the predefined valid ranges.
 *
 * @example
 * const range: FFmpegProgressRange = FFMPEG_INTERNALS.PROGRESS.GIF;
 * const paletteStart = range.PALETTE_START; // 10% for GIF pipeline
 */
export type FFmpegProgressRange =
  | typeof FFMPEG_INTERNALS.PROGRESS.GIF
  | typeof FFMPEG_INTERNALS.PROGRESS.WEBP
  | typeof FFMPEG_INTERNALS.PROGRESS.WEBCODECS;

/**
 * Calculate adaptive watchdog timeout based on video characteristics
 *
 * Scales the base watchdog timeout by multiplying it with factors based on video complexity.
 * This prevents false positives (premature timeout) for demanding conversions like 4K videos
 * or high-quality encoding. Multipliers are applied cumulatively for resolution, duration,
 * and quality settings.
 *
 * **Multiplier logic**:
 * - 4K+ resolution (3840×2160): 5.0× timeout (most demanding)
 * - FHD+ resolution (1920×1080): 2.0× timeout
 * - Long duration (>5 min): 2.0× timeout
 * - High quality: 1.5× timeout (slower encoding preset)
 *
 * @param baseTimeoutMs - Base timeout in milliseconds (default: WATCHDOG_STALL_TIMEOUT_MS = 90000ms)
 * @param options - Video and conversion characteristics for calculating multipliers
 * @param options.resolution - Video resolution {width, height}. Affects multiplier for 4K/FHD detection
 * @param options.duration - Video duration in seconds. Duration >300s (5 min) applies 2.0× multiplier
 * @param options.quality - Conversion quality ('low', 'medium', 'high'). High quality applies 1.5× multiplier
 * @returns Adaptive timeout in milliseconds (rounded to nearest integer)
 *
 * @example
 * // 4K video at high quality
 * const timeout1 = calculateAdaptiveWatchdogTimeout(90000, {
 *   resolution: { width: 3840, height: 2160 },
 *   quality: 'high'
 * });
 * // Result: 90000 × 5.0 × 1.5 = 675000ms (11.25 minutes)
 *
 * @example
 * // FHD video, 10 minute duration, medium quality
 * const timeout2 = calculateAdaptiveWatchdogTimeout(90000, {
 *   resolution: { width: 1920, height: 1080 },
 *   duration: 600,
 *   quality: 'medium'
 * });
 * // Result: 90000 × 2.0 × 2.0 = 360000ms (6 minutes)
 *
 * @example
 * // Simple low-resolution video (no multipliers)
 * const timeout3 = calculateAdaptiveWatchdogTimeout(90000, {
 *   resolution: { width: 640, height: 480 },
 *   duration: 30,
 *   quality: 'low'
 * });
 * // Result: 90000 × 1.0 = 90000ms (base timeout)
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

  // Resolution-based scaling: 4K conversions are significantly more demanding
  if (options.resolution) {
    const { width, height } = options.resolution;
    const totalPixels = width * height;

    if (totalPixels >= 3840 * 2160) {
      // 4K or higher (>=3840×2160): 5.0× timeout (handles extreme processing load)
      multiplier *= FFMPEG_INTERNALS.WATCHDOG_MULTIPLIERS.RESOLUTION_4K;
    } else if (totalPixels >= 1920 * 1080) {
      // Full HD or above (>=1920×1080): 2.0× timeout
      multiplier *= FFMPEG_INTERNALS.WATCHDOG_MULTIPLIERS.RESOLUTION_FHD;
    }
  }

  // Duration-based scaling: longer videos encode slower (>5 minutes)
  if (options.duration && options.duration > 300) {
    // Videos >300s (5 minutes): 2.0× timeout (accounts for longer processing)
    multiplier *= FFMPEG_INTERNALS.WATCHDOG_MULTIPLIERS.LONG_DURATION;
  }

  // Quality-based scaling: higher quality settings use slower encoding presets
  if (options.quality === 'high') {
    // High quality: 1.5× timeout (slower preset = longer encoding time)
    multiplier *= FFMPEG_INTERNALS.WATCHDOG_MULTIPLIERS.HIGH_QUALITY;
  }

  // Calculate final adaptive timeout with cumulative multiplier
  // Example: 4K @ high quality: 90000 × 5.0 × 1.5 = 675000ms (11.25 min)
  const adaptiveTimeout = Math.round(baseTimeoutMs * multiplier);

  return adaptiveTimeout;
}
