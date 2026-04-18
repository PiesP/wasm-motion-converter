/**
 * Orchestration Type Definitions
 *
 * Core interfaces for conversion orchestration.
 * Defines the main conversion API and the simplified GPU/CPU routing logic.
 */

import type {
  ConversionFormat,
  ConversionOptions,
  ConversionOutputBlob,
  VideoMetadata,
} from '@t/conversion-types';

/**
 * Conversion path types
 */
export type ConversionPath = 'gpu' | 'cpu';

/**
 * Conversion request
 *
 * Main API for video conversion. This is the primary interface used by
 * the UI layer (conversion stores).
 */
export interface ConversionRequest {
  /** Input video file */
  file: File;
  /** Output format (gif or webp) */
  format: ConversionFormat;
  /** Conversion options (quality, scale, duration) */
  options: ConversionOptions;
  /** Optional pre-analyzed metadata */
  metadata?: VideoMetadata;
  /** Progress callback (0-100) */
  onProgress?: (progress: number) => void;
  /** Status message callback */
  onStatus?: (status: string) => void;
  /** Cancellation check */
  shouldCancel?: () => boolean;
}

/**
 * Conversion response
 *
 * Result of a successful conversion with metadata about the path taken.
 */
export interface ConversionResponse {
  /** Output blob */
  blob: ConversionOutputBlob;
  /** Conversion metadata */
  metadata: ConversionMetadata;
}

/**
 * Conversion metadata
 *
 * Information about how the conversion was performed.
 */
export interface ConversionMetadata {
  /** Conversion path used (gpu or cpu) */
  path: ConversionPath;
  /** Encoder name (e.g., 'modern-gif', 'libwebp-wasm', 'ffmpeg') */
  encoder: string;
  /** WebCodecs capture mode used during GPU decoding (best-effort; e.g., 'demuxer', 'seek'). */
  captureModeUsed?: string | null;
  /** Total conversion time in milliseconds */
  conversionTimeMs: number;
  /** Number of frames processed */
  frameCount?: number;
  /** Whether video was transcoded */
  wasTranscoded?: boolean;
  /** Original codec */
  originalCodec?: string;
}

/**
 * Path selection result
 *
 * Decision about which conversion path to use.
 */
export interface PathSelection {
  /** Selected conversion path */
  path: ConversionPath;
  /** Reason for selection (for logging) */
  reason: string;
}

/**
 * Conversion status
 */
export interface ConversionStatus {
  /** Whether conversion is in progress */
  isConverting: boolean;
  /** Current progress (0-100) */
  progress: number;
  /** Current status message */
  statusMessage: string;
  /** Current phase (e.g., 'initializing', 'decoding', 'encoding') */
  phase?: string;
}
