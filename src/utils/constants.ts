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

/**
 * Codecs requiring advanced hardware acceleration or special handling.
 * These codecs benefit significantly from GPU decoding via WebCodecs.
 * Used by isComplexCodec() to determine if WebCodecs decode path is preferred.
 */
export const COMPLEX_CODECS = ['hevc', 'h265', 'hvc1', 'hev1', 'vp9', 'vp09', 'av1', 'av01'];

/**
 * Codecs with reliable WebCodecs hardware decode support across modern browsers.
 * These codecs can use the GPU path (WebCodecs decode) for better performance.
 *
 * 2026 browser support data:
 * - H.264 (AVC): ~99% decode, ~95% encode — universal support
 * - VP9: ~97% decode, ~90% encode — all major browsers
 * - AV1: ~91.5% decode, ~88% encode — Chrome/Firefox/Safari 14+
 * - HEVC: ~85% decode (hardware dependent) — Safari/Edge/Chrome (no Firefox)
 *
 * Source: webcodecsfundamentals.org codec-analysis-2026 (1M+ devices)
 */
export const WEBCODECS_NATIVE_CODECS = [
  'h264',
  'h.264',
  'avc',
  'avc1',
  'avc3',
  'vp8',
  'vp08',
  'vp9',
  'vp09',
  'av1',
  'av01',
  'hevc',
  'h265',
  'hvc1',
  'hev1',
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
// CONVERSION QUALITY PRESETS
// ============================================================================

/**
 * Quality presets for GIF and WebP conversions.
 *
 * GIF Presets (gifenc quantize):
 * - `low`: 10 FPS, 64 colors (smallest file, lowest quality)
 * - `medium`: 15 FPS, 128 colors (balanced quality and size)
 * - `high`: 20 FPS, 256 colors (max quality)
 *
 * WebP Presets (wasm-webp):
 * - `low`: 10 FPS, 50 quality
 * - `medium`: 15 FPS, 75 quality
 * - `high`: 20 FPS, 95 quality
 */
export const QUALITY_PRESETS = {
  gif: {
    low: { fps: 10, colors: 64 },
    medium: { fps: 15, colors: 128 },
    high: { fps: 20, colors: 256 },
  },
  webp: {
    low: { fps: 10, quality: 50 },
    medium: { fps: 15, quality: 75 },
    high: { fps: 20, quality: 95 },
  },
} as const;

/**
 * Get the target FPS for a given quality preset.
 */
export function getTargetFps(quality: 'low' | 'medium' | 'high'): number {
  return QUALITY_PRESETS.gif[quality].fps;
}

// ============================================================================
// MEMORY / PIXEL THRESHOLDS
// ============================================================================

/**
 * Maximum total pixel count threshold for browser conversion.
 *
 * Videos exceeding this threshold (width × height × framerate × duration)
 * are likely to cause memory issues in the browser.
 */
export const MAX_TOTAL_PIXEL_COUNT = 500_000_000;

// ============================================================================
// TIMEOUT CONFIGURATION
// ============================================================================
// ============================================================================

interface TimeoutConfig {
  baseTimeout: number;
  perSecondMultiplier: number;
  maxTimeout: number;
}

export const TIMEOUT_CONFIG: Record<string, TimeoutConfig> = {
  webp: {
    baseTimeout: 120_000,
    perSecondMultiplier: 10_000,
    maxTimeout: 600_000,
  },
  gif: {
    baseTimeout: 90_000,
    perSecondMultiplier: 5_000,
    maxTimeout: 360_000,
  },
};

// ============================================================================
// WebP FORMAT CONSTRAINTS (project-defined safety limits, not from WebP spec)
// ============================================================================

/** Maximum animation duration safety limit: 900 seconds (15 minutes) */
export const WEBP_MAX_DURATION_MS = 900_000;

/** Maximum frame count safety limit: 9000 frames */
export const WEBP_MAX_FRAMES = 9000;

/** Maximum duration in seconds for WebP animation. */
export const WEBP_ANIMATION_MAX_DURATION_SECONDS = WEBP_MAX_DURATION_MS / 1000;

/** Minimum frame duration in milliseconds for WebP (spec floor). */
export const MIN_WEBP_FRAME_DURATION_MS = 8;

/** Maximum frame duration value (24-bit ceiling): 0xFFFFFF ms. */
export const MAX_WEBP_DURATION_24BIT = 0xffffff;

/** Minimum interval (ms) between forced keyframes during similarity-based dedup.
 * Prevents aggressive dedup from dropping all frames in high-FPS sources.
 * E.g. 60fps source at 15fps target with static scenes: at least 1 frame every 500ms. */
export const MIN_FRAME_INTERVAL_MS = 500;

/** Transparent black background for WebP animations (RGBA). */
export const WEBP_BACKGROUND_COLOR = { r: 0, g: 0, b: 0, a: 0 } as const;

/**
 * Threshold for detecting significant FPS downsampling.
 * If source FPS exceeds target FPS by more than this ratio, use uniform frame durations
 * to avoid stuttering from uneven timestamp capture.
 */
export const FPS_DOWNSAMPLING_THRESHOLD = 1.05;

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
