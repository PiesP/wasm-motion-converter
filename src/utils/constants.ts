/**
 * Application Configuration Constants
 *
 * Centralized configuration for file size limits, timeouts, codec support,
 * video format specifications, quality presets, and performance thresholds.
 * All constants use UPPER_SNAKE_CASE naming convention.
 */

// ============================================================================
// FILE SIZE CONSTRAINTS (bytes)
// ============================================================================

/** Maximum file size allowed for upload (500 MB) */
export const MAX_FILE_SIZE = 500 * 1024 * 1024;

/** Warn if file size exceeds this threshold (100 MB) */
export const WARN_FILE_SIZE = 100 * 1024 * 1024;

/** Warn if file size exceeds this threshold; suggest low quality preset (200 MB) */
export const WARN_FILE_SIZE_HIGH = 200 * 1024 * 1024;

/** Warn if file size exceeds this threshold; suggest scale reduction (300 MB) */
export const WARN_FILE_SIZE_CRITICAL = 300 * 1024 * 1024;

// ============================================================================
// VIDEO RESOLUTION & DURATION THRESHOLDS
// ============================================================================

/** Warn if resolution exceeds this threshold (1920 × 1080 pixels, 2.07M pixels) */
export const WARN_RESOLUTION_PIXELS = 1920 * 1080;

/** Warn if duration exceeds this threshold (30 seconds) */
export const WARN_DURATION_SECONDS = 30;

// ============================================================================
// CODEC SUPPORT
// ============================================================================

/**
 * Codecs requiring advanced hardware acceleration or special handling.
 * These codecs benefit significantly from GPU decoding via WebCodecs.
 */
export const COMPLEX_CODECS = ['hevc', 'h265', 'hvc1', 'hev1', 'vp9', 'vp09', 'av1', 'av01'];

/**
 * Codecs with efficient GPU-accelerated decoding support via WebCodecs API.
 * These are the primary targets for hardware acceleration when available.
 */
export const WEBCODECS_ACCELERATED = [
  'av1',
  'av01',
  'hevc',
  'h265',
  'hvc1',
  'hev1',
  'vp9',
  'vp09',
  'vp8',
  'vp08',
  'h264',
  'avc1',
  'avc3',
];

// ============================================================================
// SUPPORTED VIDEO FORMATS
// ============================================================================

/**
 * MIME types for accepted video files.
 * Used for file input validation (accept attribute) and format detection.
 */
export const SUPPORTED_VIDEO_MIMES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-msvideo',
  'video/x-matroska',
  'video/x-m4v',
  'video/ogg',
  'video/mpeg',
  'video/mp2t',
  'video/x-ms-wmv',
  'video/x-flv',
];

/**
 * File extensions for accepted video formats.
 * Used for filename-based validation as fallback.
 */
export const SUPPORTED_VIDEO_EXTENSIONS = [
  'mp4',
  'mov',
  'webm',
  'avi',
  'mkv',
  'm4v',
  'ogv',
  'mpg',
  'mpeg',
  'ts',
  'mts',
  'm2ts',
  'wmv',
  'flv',
];

// ============================================================================
// FFmpeg CORE CONFIGURATION
// ============================================================================

/** FFmpeg.wasm core version (multithreaded build) */
export const FFMPEG_CORE_VERSION = '0.12.6';

/**
 * CDN URLs for FFmpeg core files (JavaScript, WebAssembly, workers).
 * Uses npm and unpkg mirrors for redundancy and global availability.
 */
export const FFMPEG_CORE_BASE_URLS = [
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@${FFMPEG_CORE_VERSION}/dist/esm`,
  `https://unpkg.com/@ffmpeg/core-mt@${FFMPEG_CORE_VERSION}/dist/esm`,
];

// ============================================================================
// CONVERSION QUALITY PRESETS
// ============================================================================

/**
 * Quality presets for GIF and WebP conversions.
 *
 * **GIF Presets:**
 * - `low`: 10 FPS, 128 colors (smallest file, lowest quality)
 * - `medium`: 15 FPS, 256 colors (balanced quality and size)
 * - `high`: 24 FPS, 256 colors (maximum quality and fluidity)
 *
 * **WebP Presets:**
 * - `low`: 10 FPS, 70% quality, compression 3 (fastest, smallest)
 * - `medium`: 15 FPS, 85% quality, compression 4 (balanced)
 * - `high`: 24 FPS, 95% quality, compression 6 (best quality, slowest)
 *
 * @note GIF palettegen filter's `stats_mode` parameter is not supported in
 * FFmpeg.wasm 5.1.4. FFmpeg uses its default statistics mode which works correctly.
 */
export const QUALITY_PRESETS = {
  gif: {
    low: { fps: 12, colors: 128 },
    medium: { fps: 20, colors: 256 },
    high: { fps: 30, colors: 256 },
  },
  webp: {
    low: { fps: 10, quality: 70, preset: 'default', compressionLevel: 3, method: 4 },
    medium: { fps: 15, quality: 85, preset: 'default', compressionLevel: 4, method: 5 },
    high: { fps: 24, quality: 95, preset: 'default', compressionLevel: 6, method: 6 },
  },
} as const;

// ============================================================================
// TIMEOUT CONFIGURATIONS (milliseconds)
// ============================================================================

/** Timeout for FFmpeg initialization and library loading (90 seconds) */
export const TIMEOUT_FFMPEG_INIT = 90_000;

/** Timeout for each FFmpeg core asset download from CDN (90 seconds) */
export const TIMEOUT_FFMPEG_DOWNLOAD = 90_000;

/** Timeout for worker isolation check via SharedArrayBuffer (10 seconds) */
export const TIMEOUT_FFMPEG_WORKER_CHECK = 10_000;

/** Timeout for video metadata analysis (30 seconds) */
export const TIMEOUT_VIDEO_ANALYSIS = 30_000;

/**
 * @deprecated Use `TIMEOUT_CONFIG` with `calculateTimeout()` instead.
 * Kept for backward compatibility. Default conversion timeout (60 seconds).
 */
export const TIMEOUT_CONVERSION = 60_000;

// ============================================================================
// DYNAMIC TIMEOUT CONFIGURATION
// ============================================================================

/**
 * Format-specific timeout configuration for adaptive timeout calculation.
 *
 * Timeout formula: `baseTimeout + (videoDurationSeconds * perSecondMultiplier)`
 * Result is capped at `maxTimeout`.
 *
 * **WebP (fastest codec):**
 * - Base: 60s, per-second: 6s, max: 120s
 * - A 10s video gets 60 + 60 = 120s timeout
 *
 * **GIF (slowest format, Gifsicle tier):**
 * - Base: 90s, per-second: 2s, max: 360s (6 minutes)
 * - A 60s video gets 90 + 120 = 210s timeout
 *
 * **MP4 (medium speed):**
 * - Base: 60s, per-second: 2s, max: 180s (3 minutes)
 * - A 30s video gets 60 + 60 = 120s timeout
 */
export interface TimeoutConfig {
  /** Base timeout in milliseconds */
  baseTimeout: number;
  /** Additional time per second of video duration (milliseconds) */
  perSecondMultiplier: number;
  /** Maximum timeout cap (milliseconds) */
  maxTimeout: number;
}

export const TIMEOUT_CONFIG: Record<string, TimeoutConfig> = {
  webp: {
    baseTimeout: 60_000,
    perSecondMultiplier: 6_000,
    maxTimeout: 120_000,
  },
  gif: {
    baseTimeout: 90_000,
    perSecondMultiplier: 2_000,
    maxTimeout: 360_000,
  },
  mp4: {
    baseTimeout: 60_000,
    perSecondMultiplier: 2_000,
    maxTimeout: 180_000,
  },
};

// ============================================================================
// WebP FORMAT CONSTRAINTS (from WebP specification)
// ============================================================================

/** Maximum animation duration per WebP spec: 10 seconds (10,000 ms) */
export const WEBP_MAX_DURATION_MS = 10_000;

/** Maximum frame count per WebP spec: 240 frames */
export const WEBP_MAX_FRAMES = 240;

// ============================================================================
// DURATION WARNING THRESHOLDS (milliseconds)
// ============================================================================

/**
 * Warn if GIF duration exceeds this threshold (30 seconds).
 * GIFs become very large files at this duration.
 */
export const DURATION_WARNING_GIF_MEDIUM = 30_000;

/**
 * Warn if GIF duration exceeds this threshold (60 seconds).
 * GIFs become impractically large at this duration; recommend scale reduction.
 */
export const DURATION_WARNING_GIF_LONG = 60_000;
