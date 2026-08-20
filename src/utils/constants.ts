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

/** Maximum codec-private decoder configuration retained or sent to a Worker. */
export const MAX_CODEC_DESCRIPTION_BYTES = 1 * BYTES_PER_MB;

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

/** Maximum number of frames that may be emitted into one GIF output. */
export const GIF_MAX_OUTPUT_FRAMES = 9_000;
/** Maximum cumulative GIF bytes retained by gifenc. */
export const GIF_MAX_OUTPUT_BYTES = 256 * BYTES_PER_MB;

/** Aggregate frame-pipeline and WebP-finalization memory envelope. */
export const CONVERSION_MEMORY_BUDGET_BYTES = 512 * BYTES_PER_MB;

/** A quarter of the envelope is reserved for encoded demux packets. */
export const DEMUX_MEMORY_BUDGET_RATIO = 0.25;
export const DEMUX_MEMORY_BUDGET_BYTES = CONVERSION_MEMORY_BUDGET_BYTES * DEMUX_MEMORY_BUDGET_RATIO;

/** Three eighths of the envelope are reserved for live frame processing. */
export const FRAME_PIPELINE_MEMORY_BUDGET_BYTES = CONVERSION_MEMORY_BUDGET_BYTES * 0.375;

/**
 * Maximum animated WebP bytes. Finalization retains the Blob source while
 * materializing the returned ArrayBuffer, so reserve two output-sized copies.
 */
export const WEBP_MAX_OUTPUT_BYTES =
  (CONVERSION_MEMORY_BUDGET_BYTES -
    DEMUX_MEMORY_BUDGET_BYTES -
    FRAME_PIPELINE_MEMORY_BUDGET_BYTES) /
  2;

// ============================================================================
// FRAME RATE & TIMING CONSTANTS
// ============================================================================

/** Default FPS used when video metadata doesn't provide frame rate */
export const DEFAULT_FPS = 30;

/** GIF auto-decimation target FPS — quality-dependent.
 *  low:    8fps — aggressive decimation, smallest files, noticeable choppiness
 *  medium: 12fps — balanced motion vs file size for typical screen viewing
 *  high:   20fps — smooth motion approaching cinematic feel, larger files
 *
 *  Scale no longer affects frame rate (scaleBoost removed).
 *  Scale controls resolution; quality controls both encoding fidelity and frame rate.
 *  With MIN_OUTPUT_FPS=3 guard, worst-case output is 3fps. */
export const GIF_TARGET_FPS: Record<ConversionQuality, number> = {
  low: 8,
  medium: 12,
  high: 20,
};

/** WebP auto-decimation target FPS — quality-dependent.
 *  WebP has better compression than GIF, so target FPS can be higher
 *  at each quality level while maintaining reasonable file sizes.
 *  low:    12fps
 *  medium: 18fps
 *  high:   30fps — near-source smoothness for 30fps content */
export const WEBP_TARGET_FPS: Record<ConversionQuality, number> = {
  low: 12,
  medium: 18,
  high: 30,
};

/**
 * Canonical lossy WebP quality on libwebp's 0-100 scale.
 * Browser Canvas encoders receive the same values normalized to 0-1.
 */
export const WEBP_QUALITY_PERCENT: Readonly<Record<ConversionQuality, number>> = {
  low: 60,
  medium: 75,
  high: 85,
};

export function getCanvasWebpQuality(quality: ConversionQuality): number {
  return WEBP_QUALITY_PERCENT[quality] / 100;
}

/** Minimum output FPS guard — ensures output never drops below this.
 *  Applied after decimation calculation to prevent excessively choppy output
 *  even with low quality + high source FPS combinations. */
export const MIN_OUTPUT_FPS = 3;

/** Target FPS used only when the pre-conversion memory check is critical. */
export const MEMORY_PRESSURE_TARGET_FPS = 15;

/** GIF encoder maximum frame delay (centiseconds → 2000ms) */
export const GIF_MAX_FRAME_DELAY_CS = 200;

/** GIF encoder minimum first frame delay in milliseconds.
 *  Set to 20ms — the minimum safe delay for GIF viewers (sub-20ms frames
 *  may be skipped by some renderers). Previously 100ms which caused
 *  noticeable positive timing drift after the tail-accumulation fix. */

/** GIF encoder minimum frame delay in milliseconds.
 *  Set to 20ms — the minimum safe delay for GIF viewers (sub-20ms frames
 *  may be skipped by some renderers). Previously 50ms which was an
 *  arbitrary constraint from legacy browser behavior. Modern browsers
 *  (Firefox, Chrome, Safari) all support 20ms (2cs) = 50fps. */
export const GIF_MIN_FRAME_DELAY_MS = 20;

/** GIF LZW compression ratio estimate for buffer sizing */
export const GIF_LZW_RATIO = 0.1;

/** GIF encoder maximum initial buffer estimate (32 MB) */
export const GIF_MAX_BUFFER_BYTES = 32 * BYTES_PER_MB;

// ============================================================================
// TIMEOUT CONSTANTS (milliseconds)
// ============================================================================

/** Max time before a worker task is considered stalled (30 seconds) */
export const WORKER_TIMEOUT_MS = 30_000;

/** Absolute WebP encoder worker cap to bound Canvas and in-flight frame memory. */
export const WEBP_WORKER_MAX_COUNT = 4;

/** Max time for pipeline worker conversion (5 minutes) */
export const WORKER_PIPELINE_TIMEOUT_MS = 5 * 60 * 1000;

/** Max time without progress update before stall detection fires (60 seconds) */
export const STALL_DETECTION_TIMEOUT_MS = 60_000;

/** VP8 FourCC (big-endian: "VP8 " = 0x56503820) */
export const VP8_FOURCC = 0x56503820;

/** VP8L FourCC (big-endian: "VP8L" = 0x5650384c) */
export const VP8L_FOURCC = 0x5650384c;

/** VP8X FourCC (big-endian: "VP8X" = 0x56503858) */
export const VP8X_FOURCC = 0x56503858;

// ============================================================================
// MEMORY THRESHOLD CONSTANTS
// ============================================================================

/** Memory usage percentage considered critical (>80%) */
export const MEMORY_CRITICAL_THRESHOLD = 80;

/** Ratio of estimated-to-available memory that triggers critical warning (90%) */
export const MEMORY_CRITICAL_RATIO = 0.9;

/** Ratio of estimated-to-available memory that triggers standard warning (60%) */
export const MEMORY_WARNING_RATIO = 0.6;

/**
 * Heuristic ratio used to estimate JS heap limit from deviceMemory when
 * performance.memory is unavailable. ~25% of device RAM is a conservative
 * estimate of available JS heap.
 */
export const DEVICE_MEMORY_HEAP_RATIO = 0.25;

/** Default available memory assumption when detection fails (1024 MB) */
export const MEMORY_DEFAULT_AVAILABLE_MB = 1024;

/** Default max memory allocation for worker pipeline (MB) */
export const WORKER_MAX_MEMORY_MB = CONVERSION_MEMORY_BUDGET_BYTES / BYTES_PER_MB;

/**
 * Maximum pixels in one decoded frame under the default worker memory budget.
 *
 * A live task retains a power-of-two RGB pool buffer plus a decoded surface,
 * RGBA staging, and Canvas storage. Twenty bytes per pixel conservatively
 * covers that rounded peak, and the frame-concurrency gate shares this budget.
 */
export const MAX_FRAME_PIXEL_COUNT = Math.floor(FRAME_PIPELINE_MEMORY_BUDGET_BYTES / 20);

/** Minimum allowed maxMemoryMB for worker pipeline */
export const WORKER_MIN_MEMORY_MB = 128;

/** Maximum allowed maxMemoryMB for worker pipeline */
export const WORKER_MAX_MEMORY_LIMIT_MB = WORKER_MAX_MEMORY_MB;

// ============================================================================
// PROGRESS PHASE CONSTANTS
// ============================================================================

/** Phase-weighted progress max values for conversion pipeline */
export const PROGRESS_PHASE = {
  DEMUX_MAX: 3,
  DECODE_MAX: 73,
  ENCODE_MAX: 93,
} as const;

/** Phase-weighted progress ranges derived from PROGRESS_PHASE max values */
export const PROGRESS_PHASE_RANGES = {
  DECODE_RANGE: PROGRESS_PHASE.DECODE_MAX - PROGRESS_PHASE.DEMUX_MAX,
  ENCODE_RANGE: PROGRESS_PHASE.ENCODE_MAX - PROGRESS_PHASE.DECODE_MAX,
} as const;

// ============================================================================
// ENCODER CONSTANTS
// ============================================================================

/** Maximum FPS clamp for decimation calculation guard */
export const FPS_CLAMP_MAX = 120;

// ============================================================================
// ETA & THROTTLING CONSTANTS
// ============================================================================

/** ETA maximum reasonable value in seconds (1 hour) */
export const ETA_CAP_SECONDS = 3600;

/** Maximum number of progress samples for ETA sliding window */
export const ETA_MAX_SAMPLES = 30;

/** Minimum progress throttling interval in milliseconds */
export const PROGRESS_THROTTLE_MS = 100;

// ============================================================================
// OUTPUT SIZE ESTIMATION CONSTANTS
// ============================================================================

/** Conservative bytes-per-pixel estimate for GIF LZW compression */
export const GIF_BPP_CONSERVATIVE = 0.18;

/** GIF palette overhead per frame in bytes (256 colors × 3 bytes + header) */
export const GIF_PALETTE_OVERHEAD_PER_FRAME = 800;

/** WebP container overhead per frame in bytes (ANMF chunk header) */
export const WEBP_OVERHEAD_PER_FRAME = 32;

// ============================================================================
// LOCALISATION CONSTANTS
// ============================================================================

/** localStorage key used to persist the user's locale preference */
export const LOCALE_STORAGE_KEY = 'dropconvert.locale';
