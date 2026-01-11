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
export type ConversionPath = 'gpu' | 'cpu' | 'hybrid';

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
  getOptimalFPS(sourceFPS: number, quality: string, format: ConversionFormat): number;
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
