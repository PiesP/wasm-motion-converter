/**
 * Orchestration Type Definitions
 *
 * Core interfaces for conversion orchestration, path selection, and strategy.
 * Defines the main conversion API and routing logic.
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
export type ConversionPath = 'gpu' | 'cpu' | 'webav';

/**
 * Conversion request
 *
 * Main API for video conversion. This is the primary interface used by
 * the UI layer (conversion-store.ts).
 */
export interface ConversionRequest {
  /** Input video file */
  file: File;
  /** Output format (gif, webp, mp4) */
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
  /** Conversion path used (gpu, cpu, webav) */
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
  /** Whether to use demuxer (for GPU path) */
  useDemuxer?: boolean;
  /** Whether to use workers (for encoding) */
  useWorkers?: boolean;
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

/**
 * Codec-specific path preference
 *
 * Defines optimal conversion path for specific codec + format combinations.
 * This enables fine-grained control over routing decisions.
 *
 * @example
 * ```ts
 * const h264WebpPreference: CodecPathPreference = {
 *   codec: 'h264',
 *   format: 'webp',
 *   preferredPath: 'gpu',
 *   fallbackPath: 'cpu',
 *   reason: 'H.264 hardware decode + FFmpeg libwebp faster than CPU direct'
 * };
 * ```
 */
export interface CodecPathPreference {
  /** Codec identifier (e.g., 'h264', 'av1', 'vp9') */
  codec: string;
  /** Target format (gif, webp, mp4) */
  format: ConversionFormat;
  /** Preferred conversion path */
  preferredPath: ConversionPath;
  /** Fallback path if preferred fails */
  fallbackPath: ConversionPath;
  /** Reason for preference (for logging) */
  reason: string;
  /** Optional performance metrics */
  benchmarks?: {
    /** Average conversion time in seconds */
    avgTimeSeconds: number;
    /** Success rate (0-1) */
    successRate: number;
  };
}

/**
 * Strategy decision reasoning
 *
 * Provides detailed information about why a particular conversion path was selected.
 * Used for dev mode logging and debugging.
 */
export interface StrategyReasoning {
  /** The conversion path that was selected */
  decision: ConversionPath;
  /** Factors that influenced the decision */
  factors: {
    /** Whether the codec is supported by the selected path */
    codecSupport: boolean;
    /** Whether the container format is supported */
    containerSupport: boolean;
    /** Whether hardware acceleration is available */
    hardwareAcceleration: boolean;
    /** Best-effort per-codec hardware decode hint (null when unknown / not probed). */
    codecHardwareDecodeHint?: boolean | null;
    /** Whether the WebCodecs decode environment is available. */
    webcodecsDecodeSupport: boolean;
    /** Whether GIF GPU preflight checks passed (gif only). */
    gifGpuEligible?: boolean;
    /** Whether this path succeeded before for this codec+format */
    historicalSuccess: boolean;
    /** Performance benchmark in milliseconds (if available) */
    performanceBenchmark?: number;
  };
  /** Alternative paths that were considered but rejected */
  alternativesConsidered: Array<{
    /** The alternative path */
    path: ConversionPath;
    /** Why this path was not selected */
    rejectionReason: string;
  }>;
}
