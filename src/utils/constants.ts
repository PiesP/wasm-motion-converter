// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import { getRuntimeDepVersion } from '@utils/cdn-config';

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
 */
export const COMPLEX_CODECS = ['hevc', 'h265', 'hvc1', 'hev1', 'vp9', 'vp09', 'av1', 'av01'];

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
export const FFMPEG_CORE_VERSION = getRuntimeDepVersion('@ffmpeg/core-mt');

/**
 * CDN URLs for FFmpeg core files (JavaScript, WebAssembly, workers).
 * Uses npm and unpkg mirrors for redundancy and global availability.
 *
 * @deprecated Use the unified CDN system from @utils/cdn-config instead.
 * FFmpeg loading now uses all 3 CDN providers (esm.sh, jsdelivr, unpkg).
 * This constant is kept for backward compatibility only.
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
    // WASM-optimized settings for libwebp encoding in FFmpeg
    // Lower method & compressionLevel prevent encoding stalls in WASM environment
    // VP9/complex codec optimization: Reduced quality (75→55 for medium) to prevent GPU saturation
    low: {
      fps: 10,
      quality: 50,
      // libwebp preset values are limited to: default/picture/photo/drawing/icon/text
      // ("fast" is NOT a valid libwebp preset and causes FFmpeg to fail.)
      preset: 'picture',
      compressionLevel: 2,
      method: 2,
    },
    medium: {
      fps: 15,
      quality: 55,
      preset: 'picture',
      compressionLevel: 2,
      method: 2,
    },
    high: {
      fps: 20,
      quality: 70,
      preset: 'default',
      compressionLevel: 3,
      method: 3,
    },
  },
} as const;

// ============================================================================
// TIMEOUT CONFIGURATIONS (milliseconds)
// ============================================================================

/** Timeout for FFmpeg initialization and library loading (90 seconds) */
export const TIMEOUT_FFMPEG_INIT = 90_000;

/** Timeout for worker isolation check via SharedArrayBuffer (10 seconds) */
export const TIMEOUT_FFMPEG_WORKER_CHECK = 10_000;

/** Timeout for video metadata analysis (30 seconds) */
export const TIMEOUT_VIDEO_ANALYSIS = 30_000;

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
 */
interface TimeoutConfig {
  /** Base timeout in milliseconds */
  baseTimeout: number;
  /** Additional time per second of video duration (milliseconds) */
  perSecondMultiplier: number;
  /** Maximum timeout cap (milliseconds) */
  maxTimeout: number;
}

export const TIMEOUT_CONFIG: Record<string, TimeoutConfig> = {
  webp: {
    // WASM WebP encoding is much slower than expected (VP9 stalls at 90%)
    // 5.75s video took ~120s+ with frame encoding stalls (queue saturation)
    // VP9/complex codec workaround: Longer timeout + reduced quality settings
    baseTimeout: 120_000, // 2 minutes base (increased from 90s)
    perSecondMultiplier: 15_000, // 15s per second (increased from 10s)
    maxTimeout: 360_000, // 6 minutes max (increased from 3 minutes)
  },
  gif: {
    // GIF encoding via palette generation + Gifsicle is generally faster than WebP
    // Keep baseline but monitor for VP9 codec performance
    baseTimeout: 90_000,
    perSecondMultiplier: 2_000,
    maxTimeout: 360_000,
  },
};

// ============================================================================
// WebP FORMAT CONSTRAINTS (from WebP specification)
// ============================================================================

/** Maximum animation duration per WebP spec: 10 seconds (10,000 ms) */
export const WEBP_MAX_DURATION_MS = 10_000;

/** Maximum frame count per WebP spec: 240 frames */
export const WEBP_MAX_FRAMES = 240;

/** Maximum duration in seconds for WebP animation. */
export const WEBP_ANIMATION_MAX_DURATION_SECONDS = WEBP_MAX_DURATION_MS / 1000;

/** Minimum frame duration in milliseconds for WebP (spec floor). */
export const MIN_WEBP_FRAME_DURATION_MS = 8;

/** Maximum frame duration value (24-bit ceiling): 0xFFFFFF ms. */
export const MAX_WEBP_DURATION_24BIT = 0xffffff;

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
