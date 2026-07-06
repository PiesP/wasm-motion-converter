// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Application Configuration Constants
 *
 * Centralized configuration for file size limits, timeouts, codec support,
 * video format specifications, quality presets, and performance thresholds.
 * All constants use UPPER_SNAKE_CASE naming convention.
 */

import type { ConversionQuality } from '@t/conversion-types';

// ============================================================================
// FILE SIZE CONSTRAINTS (bytes)
// ============================================================================

/** Bytes per kilobyte */
export const BYTES_PER_KB = 1024;

/** Bytes per megabyte (1024 KB) */
export const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;

/** Maximum file size allowed for upload (500 MB) */
export const MAX_FILE_SIZE = 500 * BYTES_PER_MB;

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

// ============================================================================
// FRAME RATE & TIMING CONSTANTS
// ============================================================================

/** Default FPS used when video metadata doesn't provide frame rate */
export const DEFAULT_FPS = 30;

/** GIF auto-decimation target FPS.
 *  GIF is significantly larger than WebP at the same quality.
 *  5fps with scaleBoost=3 gives ~2fps for 60fps sources (1080p → ~40MB).
 *  This is the practical limit before motion becomes choppy. */
export const GIF_TARGET_FPS = 5;

/** WebP auto-decimation target FPS — varies by quality preset.
 *  Per-frame wasm-webp encoding (~287ms/frame for 1080p) dominates
 *  conversion time; reducing output frames is the highest-ROI optimization.
 *  Unified at 8fps across all quality levels — the quality parameter
 *  affects per-frame encoding size, not speed, so it's a separate axis.
 *  With scaleBoost=3 at 100% scale, effective output FPS is ~2.7fps. */
export const WEBP_TARGET_FPS: Record<ConversionQuality, number> = {
  low: 8,
  medium: 8,
  high: 8,
};

/** GIF encoder maximum frame delay (centiseconds → 2000ms) */
export const GIF_MAX_FRAME_DELAY_CS = 200;

/** GIF encoder minimum first frame delay in milliseconds.
 *  Set to 20ms — the minimum safe delay for GIF viewers (sub-20ms frames
 *  may be skipped by some renderers). Previously 100ms which caused
 *  noticeable positive timing drift after the tail-accumulation fix. */
export const GIF_MIN_FIRST_FRAME_DELAY_MS = 20;

/** GIF encoder minimum frame delay in milliseconds.
 *  Set to 20ms — the minimum safe delay for GIF viewers (sub-20ms frames
 *  may be skipped by some renderers). Previously 50ms which was an
 *  arbitrary constraint from legacy browser behavior. Modern browsers
 *  (Firefox, Chrome, Safari) all support 20ms (2cs) = 50fps. */
export const GIF_MIN_FRAME_DELAY_MS = 20;

/** GIF LZW compression ratio estimate for buffer sizing */
export const GIF_LZW_RATIO = 0.1;

/** GIF encoder maximum buffer size (32 MB) */
export const GIF_MAX_BUFFER_BYTES = 32 * BYTES_PER_MB;

// ============================================================================
// TIMEOUT CONSTANTS (milliseconds)
// ============================================================================

/** Max time before a worker task is considered stalled (30 seconds) */
export const WORKER_TIMEOUT_MS = 30_000;

/** Max time for pipeline worker conversion (5 minutes) */
export const WORKER_PIPELINE_TIMEOUT_MS = 5 * 60 * 1000;

/** Max time without progress update before stall detection fires (60 seconds) */
export const STALL_DETECTION_TIMEOUT_MS = 60_000;

/** Default VP8 encoder bitrate — 5 Mbps for quality encoding */
export const VP8_DEFAULT_BITRATE = 5_000_000;

/** VP8 FourCC (big-endian: "VP8 " = 0x56503820) */
export const VP8_FOURCC = 0x56503820;

/** VP8L FourCC (big-endian: "VP8L" = 0x5650384c) */
export const VP8L_FOURCC = 0x5650384c;

// ============================================================================
// MEMORY THRESHOLD CONSTANTS
// ============================================================================

/** Memory usage percentage considered critical (>80%) */
export const MEMORY_CRITICAL_THRESHOLD = 80;

/** Ratio of estimated-to-available memory that triggers critical warning (90%) */
export const MEMORY_CRITICAL_RATIO = 0.9;

/** Ratio of estimated-to-available memory that triggers standard warning (60%) */
export const MEMORY_WARNING_RATIO = 0.6;

/** Default available memory assumption when detection fails (1024 MB) */
export const MEMORY_DEFAULT_AVAILABLE_MB = 1024;

/** Default max memory allocation for worker pipeline (MB) */
export const WORKER_MAX_MEMORY_MB = 512;

/** Minimum allowed maxMemoryMB for worker pipeline */
export const WORKER_MIN_MEMORY_MB = 128;

/** Maximum allowed maxMemoryMB for worker pipeline */
export const WORKER_MAX_MEMORY_LIMIT_MB = 2048;
