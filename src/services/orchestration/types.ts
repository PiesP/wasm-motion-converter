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
export type ConversionPath = 'gpu' | 'cpu' | 'hybrid' | 'webav';

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
  /** Conversion path used (gpu, cpu, hybrid) */
  path: ConversionPath;
  /** Encoder name (e.g., 'modern-gif', 'libwebp-wasm', 'ffmpeg') */
  encoder: string;
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
 * Path selector interface
 *
 * Decides which conversion path to use based on codec, format, and capabilities.
 */
export interface PathSelector {
  /**
   * Select optimal conversion path
   */
  selectPath(
    file: File,
    format: ConversionFormat,
    metadata?: VideoMetadata
  ): Promise<PathSelection>;

  /**
   * Check if GPU path is available
   */
  isGPUPathAvailable(): boolean;

  /**
   * Check if codec requires specific path
   */
  requiresGPUPath(codec: string): boolean;
}

/**
 * Conversion strategy
 *
 * Resolved conversion parameters with overrides applied.
 */
export interface ConversionStrategy {
  /** Target FPS (may be adjusted from quality preset) */
  targetFps: number;
  /** Scale factor (may be adjusted for performance) */
  scale: number;
  /** Maximum frames to extract */
  maxFrames?: number;
  /** Whether to prefer workers */
  preferWorkers: boolean;
  /** Whether to use demuxer */
  useDemuxer: boolean;
}

/**
 * Strategy resolver interface
 *
 * Resolves conversion strategy with quality presets and overrides.
 */
export interface StrategyResolver {
  /**
   * Resolve conversion strategy
   */
  resolve(
    format: ConversionFormat,
    options: ConversionOptions,
    metadata?: VideoMetadata
  ): ConversionStrategy;

  /**
   * Get optimal FPS for quality level
   */
  getOptimalFPS(sourceFps: number, quality: string, format: ConversionFormat): number;
}

/**
 * Conversion orchestrator interface
 *
 * Main orchestrator that coordinates path selection, strategy, and execution.
 */
export interface ConversionOrchestrator {
  /**
   * Convert video using optimal path
   */
  convertVideo(request: ConversionRequest): Promise<ConversionResponse>;

  /**
   * Get current conversion status
   */
  getStatus(): ConversionStatus;

  /**
   * Cancel current conversion
   */
  cancel(): void;
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

// ============================================================================
// HYBRID STRATEGY TYPES (Future Implementation)
// ============================================================================
// These types define the structure for codec-specific optimization strategies
// that will be implemented in future iterations to fine-tune conversion paths
// based on codec capabilities and performance characteristics.
// ============================================================================

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
 * Hybrid strategy configuration
 *
 * Advanced configuration for codec-aware path selection.
 * Allows per-codec, per-format routing rules.
 *
 * @example
 * ```ts
 * const strategy: HybridStrategyConfig = {
 *   enableCodecOptimization: true,
 *   codecPreferences: [
 *     { codec: 'h264', format: 'gif', preferredPath: 'cpu', fallbackPath: 'gpu' },
 *     { codec: 'h264', format: 'webp', preferredPath: 'gpu', fallbackPath: 'cpu' },
 *     { codec: 'av1', format: 'gif', preferredPath: 'gpu', fallbackPath: 'cpu' }
 *   ],
 *   defaultPath: 'gpu',
 *   fallbackChain: ['gpu', 'cpu']
 * };
 * ```
 */
export interface HybridStrategyConfig {
  /** Whether to enable codec-specific optimizations */
  enableCodecOptimization: boolean;
  /** Codec-specific path preferences */
  codecPreferences: CodecPathPreference[];
  /** Default path when no specific preference matches */
  defaultPath: ConversionPath;
  /** Fallback chain if all preferred paths fail */
  fallbackChain: ConversionPath[];
}
