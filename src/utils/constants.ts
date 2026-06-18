// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

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

export const MAX_TOTAL_PIXEL_COUNT = 500_000_000;

export const WEBP_MAX_DURATION_MS = 900_000;
export const WEBP_MAX_FRAMES = 9000;

export const DURATION_WARNING_GIF_MEDIUM = 30_000;
export const DURATION_WARNING_GIF_LONG = 60_000;

/** GIF output pixel count threshold (921,600 = 1280×720) — warn users
 *  about large file sizes when output exceeds ~720p at 100% scale. */
export const GIF_HIGH_PIXEL_THRESHOLD = 921_600;

// ============================================================================
// FRAME RATE & TIMING CONSTANTS
// ============================================================================

/** Default FPS used when video metadata doesn't provide frame rate */
export const DEFAULT_FPS = 30;

/** GIF auto-decimation target FPS */
export const GIF_TARGET_FPS = 15;

/** WebP auto-decimation target FPS */
export const WEBP_TARGET_FPS = 20;

/** GIF encoder maximum frame delay (centiseconds → 2000ms) */
export const GIF_MAX_FRAME_DELAY_CS = 200;

/** GIF encoder minimum first frame delay in milliseconds */
export const GIF_MIN_FIRST_FRAME_DELAY_MS = 100;

/** GIF encoder minimum frame delay in milliseconds */
export const GIF_MIN_FRAME_DELAY_MS = 50;

/** GIF LZW compression ratio estimate for buffer sizing */
export const GIF_LZW_RATIO = 0.1;

/** GIF encoder maximum buffer size (32 MB) */
export const GIF_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
