// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Conversion Types
 *
 * Type definitions for video conversion operations, including formats, quality
 * settings, conversion results, and error handling.
 * These types are used throughout the conversion pipeline to ensure type safety.
 */

/**
 * Supported output formats
 *
 * - `gif`: Animated GIF format (widely supported, larger file sizes)
 * - `webp`: Animated WebP format (better compression, modern browsers)
 * @example
 * const format: ConversionFormat = 'gif';
 */
export type ConversionFormat = 'gif' | 'webp';

/** Runtime-available list of all ConversionFormat values (single source of truth) */
export const CONVERSION_FORMATS: readonly ConversionFormat[] = ['gif', 'webp'] as const;

/**
 * Conversion quality levels
 *
 * - `low`: Fastest conversion, lower quality (e.g., fewer colors for GIF)
 * - `medium`: Balanced quality and speed
 * - `high`: Best quality, slower conversion (e.g., full color palette for GIF)
 *
 * @example
 * const quality: ConversionQuality = 'high';
 */
export type ConversionQuality = 'low' | 'medium' | 'high';

/** Runtime-available list of all ConversionQuality values */
export const CONVERSION_QUALITIES: readonly ConversionQuality[] = [
  'low',
  'medium',
  'high',
] as const;

/**
 * Video scaling factor
 *
 * - `0.5`: Half size (25% of original pixels)
 * - `0.75`: Three-quarters size (56% of original pixels)
 * - `1.0`: Original size (100% of original pixels)
 *
 * Scaling down can significantly reduce conversion time and output file size.
 *
 * @example
 * const scale: ConversionScale = 0.75;
 */
export type ConversionScale = 0.5 | 0.75 | 1.0;

/** Runtime-available list of all ConversionScale values */
export const CONVERSION_SCALES: readonly ConversionScale[] = [0.5, 0.75, 1.0] as const;

/**
 * Smart frame skip mode — controls similarity-based frame deduplication.
 *
 * - `off`: No similarity-based skipping (fixed FPS decimation only)
 * - `low`: Conservative — only skip near-identical frames (hamming ≤ 2)
 * - `medium`: Balanced — skip noise-level changes (hamming ≤ 3, recommended)
 * - `high`: Aggressive — skip slow changes too (hamming ≤ 5)
 *
 * When enabled, consecutive similar frames are merged and their durations
 * are accumulated into the next kept frame, preserving timing accuracy.
 */
export type SmartFrameSkipMode = 'off' | 'low' | 'medium' | 'high';

/** Runtime-available list of all SmartFrameSkipMode values */
export const SMART_FRAME_SKIP_MODES: readonly SmartFrameSkipMode[] = [
  'off',
  'low',
  'medium',
  'high',
] as const;

/**
 * User-selected conversion settings
 *
 * Complete configuration for video conversion including output format,
 * quality level, and scaling factor. These settings are persisted to
 * localStorage and used for all conversions.
 *
 * @example
 * const settings: ConversionSettings = {
 *   format: 'gif',
 *   quality: 'high',
 *   scale: 1.0
 * };
 */
export interface ConversionSettings {
  /** Output format (gif or webp) */
  format: ConversionFormat;
  /** Quality level (low, medium, high) */
  quality: ConversionQuality;
  /** Scaling factor (0.5, 0.75, 1.0) */
  scale: ConversionScale;
  /** Trim start in seconds (0 = beginning of video) */
  trimStart: number;
  /** Trim end in seconds (0 = end of video) */
  trimEnd: number;
  /** Smart frame skip mode — similarity-based frame deduplication */
  smartFrameSkip: SmartFrameSkipMode;
}

/**
 * Conversion result with metadata
 *
 * Complete record of a successful conversion including the output blob,
 * original file information, conversion settings, and performance metrics.
 * Results are stored in conversion stores for download and preview.
 *
 * @example
 * const result: ConversionResult = {
 *   id: crypto.randomUUID(),
 *   outputBlob: new Blob([...], { type: 'image/gif' }),
 *   originalName: 'video.mp4',
 *   originalSize: 1024000,
 *   createdAt: performance.now(),
 *   settings: { format: 'gif', quality: 'high', scale: 1.0 },
 *   conversionDurationSeconds: 12.5
 * };
 */
export interface ConversionResult {
  /** Unique identifier (UUID) */
  id: string;
  /** Converted video blob */
  outputBlob: Blob;
  /** Original video filename */
  originalName: string;
  /** Original file size in bytes */
  originalSize: number;
  /** Timestamp when conversion completed */
  createdAt: number;
  /** Settings used for this conversion */
  settings: ConversionSettings;
  /** Time taken to convert (seconds) */
  conversionDurationSeconds?: number;
}

/**
 * Conversion error classification
 *
 * Categories of errors that can occur during conversion, used to provide
 * context-specific error messages and suggestions to the user.
 *
 * - `memory`: Out of memory or memory limit reached
 * - `format`: Unsupported video format
 * - `codec`: Unsupported video codec
 * - `general`: Other errors (catch-all)
 */
export type ConversionErrorType = 'memory' | 'format' | 'codec' | 'timeout' | 'general';

/** Structured error code for programmatic handling */
export type ErrorCode =
  | 'CODEC_NOT_SUPPORTED'
  | 'OUT_OF_MEMORY'
  | 'DECODER_ERROR'
  | 'ENCODER_ERROR'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'CORRUPT_OUTPUT'
  | 'UNKNOWN';

/**
 * Detailed error context for conversion failures
 *
 * Extended error information including type classification, original error
 * message, timestamp, suggested resolution, and diagnostic data (settings,
 * conversion phase). Used to provide user-friendly error
 * messages and debugging information.
 */
export interface ErrorContext {
  /** Error type classification */
  type: ConversionErrorType;
  /** Structured error code for programmatic handling */
  code: ErrorCode;
  /** Original error message */
  originalError: string;
  /** When error occurred (milliseconds since epoch) */
  timestamp: number;
  /** User-friendly suggestion for resolution */
  suggestion?: string;
  /** Settings used for failed conversion */
  conversionSettings?: ConversionSettings;
  /** Which phase of conversion failed (e.g., 'decoding', 'encoding') */
  phase?: string;
  /** FFmpeg log lines for debugging (optional) */
  ffmpegLogs?: string[];
}
/**
 *
 * Video file properties extracted during analysis phase. Used to validate
 * the video, calculate timeouts, detect performance issues, and provide
 * information to the user.
 *
 * @example
 * const metadata: VideoMetadata = {
 *   width: 1920,
 *   height: 1080,
 *   duration: 10.5,
 *   codec: 'h264',
 *   framerate: 30,
 *   bitrate: 5000000
 * };
 */
export interface VideoMetadata {
  /** Video width in pixels */
  width: number;
  /** Video height in pixels */
  height: number;
  /** Video duration in seconds */
  duration: number;
  /** Video codec (e.g., 'h264', 'vp9', 'hevc') */
  codec: string;
  /** Frame rate (frames per second) */
  framerate: number;
  /** Video bitrate (bits per second) */
  bitrate: number;
}

// ---------------------------------------------------------------------------
// Pipeline types (phase, progress, request)
// ---------------------------------------------------------------------------

/** Callback type for conversion progress updates (shared across all encoders) */
export type ProgressCallback = (progress: ConversionProgress) => void;

export interface ConversionRequest {
  inputBuffer: ArrayBuffer;
  fileName: string;
  format: ConversionFormat;
  quality: ConversionQuality;
  scale: number;
  trimStart: number;
  trimEnd: number;
  maxMemoryMB: number;
  /** Force frame decimation (overrides auto-decimation) */
  forceDecimation?: number;
  /** Smart frame skip mode — similarity-based frame deduplication */
  smartFrameSkip?: SmartFrameSkipMode;
}

/** Pipeline phase identifier (short form for internal use) */
export type ConversionPhase = 'demux' | 'decode' | 'encode' | 'assemble';

/** Human-readable phase labels for UI display */
export const PHASE_LABELS: Record<ConversionPhase, string> = {
  demux: 'Demux',
  decode: 'Decode',
  encode: 'Encode',
  assemble: 'Final',
} as const;

/** Progress callback phase — maps to the same values but typed separately for UI */
export type ProgressPhase = 'demuxing' | 'decoding' | 'encoding' | 'assembling';

/** Map internal phase to progress display name */
export function toProgressPhase(phase: ConversionPhase): ProgressPhase {
  switch (phase) {
    case 'demux':
      return 'demuxing';
    case 'decode':
      return 'decoding';
    case 'encode':
      return 'encoding';
    case 'assemble':
      return 'assembling';
  }
}

/** Map progress display name to internal phase */
export function fromProgressPhase(phase: ProgressPhase): ConversionPhase {
  switch (phase) {
    case 'demuxing':
      return 'demux';
    case 'decoding':
      return 'decode';
    case 'encoding':
      return 'encode';
    case 'assembling':
      return 'assemble';
  }
}

export interface ConversionProgress {
  phase: ProgressPhase;
  progress: number;
  fps: number;
  etaSeconds: number | null;
  memoryMB: number;
  currentFrame?: number;
  totalFrames?: number;
  outputFrames?: number;
  elapsedMs?: number;
}
