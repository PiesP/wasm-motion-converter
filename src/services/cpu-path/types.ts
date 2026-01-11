/**
 * CPU Path Type Definitions
 *
 * Core interfaces for the FFmpeg-based CPU fallback path.
 * Defines contracts between FFmpeg core, VFS, encoding, and monitoring.
 */

import type {
  ConversionFormat,
  ConversionOptions,
  ConversionOutputBlob,
  VideoMetadata,
} from '../../types/conversion-types';

/**
 * FFmpeg conversion request
 */
export interface FFmpegConversionRequest {
  /** Input video file */
  file: File;
  /** Output format */
  format: ConversionFormat;
  /** Conversion options */
  options: ConversionOptions;
  /** Video metadata (optional) */
  metadata?: VideoMetadata;
  /** Progress callback (0-100) */
  onProgress?: (progress: number) => void;
  /** Status message callback */
  onStatus?: (message: string) => void;
  /** Cancellation check */
  shouldCancel?: () => boolean;
}

/**
 * FFmpeg frame sequence encoding request
 */
export interface FFmpegFrameSequenceRequest {
  /** Frame files in VFS (e.g., ['frame_000001.png', ...]) */
  frameFiles: string[];
  /** Output format */
  format: ConversionFormat;
  /** Frame width */
  width: number;
  /** Frame height */
  height: number;
  /** Frames per second */
  fps: number;
  /** Conversion options */
  options: ConversionOptions;
  /** Progress callback (0-100) */
  onProgress?: (progress: number) => void;
  /** Cancellation check */
  shouldCancel?: () => boolean;
}

/**
 * FFmpeg core interface
 *
 * Manages FFmpeg initialization and low-level operations.
 */
export interface FFmpegCore {
  /**
   * Check if FFmpeg is loaded
   */
  isLoaded(): boolean;

  /**
   * Initialize FFmpeg (load WASM, start workers)
   */
  initialize(): Promise<void>;

  /**
   * Execute FFmpeg command
   */
  exec(args: string[], options?: FFmpegExecOptions): Promise<void>;

  /**
   * Get FFmpeg logs
   */
  getLogs(): string[];

  /**
   * Terminate FFmpeg (cleanup)
   */
  terminate(): Promise<void>;
}

/**
 * FFmpeg exec options
 */
export interface FFmpegExecOptions {
  /** Timeout in milliseconds */
  timeout?: number;
  /** Progress callback */
  onProgress?: (progress: number) => void;
  /** Log callback */
  onLog?: (message: string) => void;
}

/**
 * FFmpeg VFS interface
 *
 * Manages virtual filesystem operations.
 */
export interface FFmpegVFS {
  /**
   * Write file to VFS
   */
  writeFile(filename: string, data: Uint8Array): Promise<void>;

  /**
   * Read file from VFS
   */
  readFile(filename: string): Promise<Uint8Array>;

  /**
   * Delete file from VFS
   */
  deleteFile(filename: string): Promise<void>;

  /**
   * List files in VFS
   */
  listFiles(): Promise<string[]>;

  /**
   * Clear all files from VFS
   */
  clearFiles(): Promise<void>;
}

/**
 * FFmpeg encoder interface
 *
 * Handles direct video encoding operations.
 */
export interface FFmpegEncoder {
  /**
   * Convert video file to target format
   */
  convertVideo(request: FFmpegConversionRequest): Promise<ConversionOutputBlob>;

  /**
   * Encode frame sequence to target format
   */
  encodeFrameSequence(
    request: FFmpegFrameSequenceRequest
  ): Promise<ConversionOutputBlob>;
}

/**
 * FFmpeg monitoring interface
 *
 * Handles watchdog, heartbeat, and progress tracking.
 */
export interface FFmpegMonitor {
  /**
   * Start watchdog timer
   */
  startWatchdog(timeoutMs: number, onTimeout: () => void): void;

  /**
   * Reset watchdog (extend timeout)
   */
  resetWatchdog(): void;

  /**
   * Stop watchdog
   */
  stopWatchdog(): void;

  /**
   * Start heartbeat monitoring
   */
  startHeartbeat(intervalMs: number, onHeartbeat: () => void): void;

  /**
   * Stop heartbeat
   */
  stopHeartbeat(): void;

  /**
   * Parse progress from FFmpeg logs
   */
  parseProgress(logs: string[]): number;
}

/**
 * FFmpeg pipeline interface
 *
 * High-level orchestration of FFmpeg operations.
 */
export interface FFmpegPipeline {
  /**
   * Convert video via direct FFmpeg path
   */
  convert(request: FFmpegConversionRequest): Promise<ConversionOutputBlob>;

  /**
   * Encode pre-extracted frames
   */
  encodeFrames(request: FFmpegFrameSequenceRequest): Promise<ConversionOutputBlob>;

  /**
   * Check if FFmpeg is ready
   */
  isReady(): boolean;

  /**
   * Initialize FFmpeg if needed
   */
  ensureInitialized(): Promise<void>;
}
