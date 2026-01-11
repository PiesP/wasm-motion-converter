/**
 * FFmpeg Pipeline
 *
 * High-level orchestration layer that coordinates FFmpeg modules:
 * - ffmpeg-core: Initialization and lifecycle
 * - ffmpeg-vfs: Virtual filesystem operations
 * - ffmpeg-monitoring: Watchdog, heartbeat, progress tracking
 * - ffmpeg-encoder: Direct encoding operations
 *
 * Provides a clean API for video conversion operations with proper resource
 * management, error handling, and progress reporting.
 *
 * Features:
 * - Conversion locking (prevents concurrent operations)
 * - Automatic resource cleanup
 * - Progress and status callbacks
 * - Cancellation support
 * - Memory-aware caching
 *
 * @module cpu-path/ffmpeg-pipeline
 */

import type { FFmpeg } from '@ffmpeg/ffmpeg';
import type {
  ConversionOptions,
  ConversionOutputBlob,
  ConversionQuality,
  VideoMetadata,
} from '@t/conversion-types';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { isMemoryCritical } from '@utils/memory-monitor';
import { FFmpegCore } from './ffmpeg-core';
import type { FFmpegInputOverride } from './ffmpeg-encoder';
import { FFmpegEncoder } from './ffmpeg-encoder';
import { FFmpegMonitoring } from './ffmpeg-monitoring';
import { FFmpegVFS } from './ffmpeg-vfs';

/**
 * Pipeline callbacks for conversion operations
 */
export interface PipelineCallbacks {
  /** Progress callback (0-100) */
  onProgress?: (progress: number) => void;
  /** Status message callback */
  onStatusUpdate?: (message: string) => void;
  /** Cancellation check callback */
  shouldCancel?: () => boolean;
}

/**
 * Frame sequence encoding parameters
 */
export interface FrameSequenceParams {
  format: 'gif' | 'webp';
  options: ConversionOptions;
  frameCount: number;
  fps: number;
  durationSeconds: number;
  frameFiles: string[];
  frameTimestamps?: number[]; // Optional array of frame timestamps in seconds
}

/**
 * FFmpeg Pipeline
 *
 * Orchestrates FFmpeg modules for video conversion operations.
 */
export class FFmpegPipeline {
  // Module instances
  private core: FFmpegCore;
  private vfs: FFmpegVFS;
  private monitoring: FFmpegMonitoring;
  private encoder: FFmpegEncoder;

  // Conversion state
  private conversionLock = false;
  private callbacks: PipelineCallbacks = {};

  constructor() {
    this.core = new FFmpegCore();
    this.vfs = new FFmpegVFS();
    this.monitoring = new FFmpegMonitoring();
    this.encoder = new FFmpegEncoder();

    // Wire up dependencies
    this.setupDependencies();
  }

  /**
   * Setup dependencies between modules
   */
  private setupDependencies(): void {
    // Connect monitoring callbacks
    this.monitoring.setCallbacks({
      onProgress: (progress) => {
        this.callbacks.onProgress?.(progress);
      },
      onStatus: (message) => {
        this.callbacks.onStatusUpdate?.(message);
      },
      onTerminate: () => {
        this.handleTermination();
      },
    });

    // Connect encoder dependencies
    this.encoder.setDependencies({
      core: this.core,
      vfs: this.vfs,
      monitoring: this.monitoring,
      onProgress: (progress: number) => {
        this.callbacks.onProgress?.(progress);
      },
      onStatusUpdate: (message: string) => {
        this.callbacks.onStatusUpdate?.(message);
      },
      shouldCancel: () => {
        return this.callbacks.shouldCancel?.() || false;
      },
    });
  }

  /**
   * Get FFmpeg instance (throws if not initialized)
   */
  private getFFmpeg(): FFmpeg {
    const instance = this.core.getFFmpeg();
    if (!instance) {
      throw new Error('FFmpeg not initialized');
    }
    return instance;
  }

  /**
   * Handle termination request from monitoring
   */
  private handleTermination(): void {
    logger.warn('general', 'Termination requested by monitoring system');
    this.callbacks.onStatusUpdate?.('Terminating FFmpeg due to stall...');
    this.terminate();
  }

  /**
   * Acquire conversion lock
   *
   * Prevents concurrent conversions which could interfere with each other.
   *
   * @returns True if lock acquired, false if already locked
   */
  private acquireConversionLock(): boolean {
    if (this.conversionLock) {
      logger.warn('general', 'Conversion lock already held');
      return false;
    }
    this.conversionLock = true;
    logger.debug('general', 'Conversion lock acquired');
    return true;
  }

  /**
   * Release conversion lock
   */
  private releaseConversionLock(): void {
    this.conversionLock = false;
    logger.debug('general', 'Conversion lock released');
  }

  /**
   * Check if FFmpeg is loaded
   */
  isLoaded(): boolean {
    return this.core.isLoaded();
  }

  /**
   * Check if currently initializing
   */
  isInitializing(): boolean {
    return this.core.isInitializing();
  }

  /**
   * Initialize FFmpeg
   *
   * Downloads and initializes FFmpeg WASM module with multi-threading support.
   * Safe to call multiple times - subsequent calls wait for existing initialization.
   *
   * @param onProgress Progress callback (0-100)
   * @param onStatus Status message callback
   */
  async initialize(
    onProgress?: (progress: number) => void,
    onStatus?: (message: string) => void
  ): Promise<void> {
    await this.core.initialize({ onProgress, onStatus });
  }

  /**
   * Prefetch FFmpeg core assets in background
   *
   * Downloads core files without initializing FFmpeg. Useful for preloading
   * during idle time to reduce perceived initialization latency.
   */
  prefetchCoreAssets(): Promise<void> {
    return this.core.prefetchCoreAssets();
  }

  /**
   * Get video metadata
   *
   * Analyzes video file and extracts metadata (codec, resolution, framerate, etc.)
   *
   * @param file Input video file
   * @returns Video metadata
   */
  async getVideoMetadata(file: File): Promise<VideoMetadata> {
    if (!this.isLoaded()) {
      throw new Error('FFmpeg not initialized');
    }

    return this.core.getVideoMetadata(file, (file: File) =>
      this.vfs.ensureInputFile(this.getFFmpeg(), file)
    );
  }

  /**
   * Convert video to GIF
   *
   * Converts video file to optimized GIF with palette generation.
   *
   * @param file Input video file
   * @param options Conversion options (quality, scale, etc.)
   * @param metadata Video metadata (optional, will be fetched if not provided)
   * @param inputOverride Input format override for transcoding
   * @param callbacks Progress and status callbacks
   * @returns GIF blob
   */
  async convertToGIF(
    file: File,
    options: ConversionOptions,
    metadata?: VideoMetadata,
    inputOverride?: FFmpegInputOverride,
    callbacks?: PipelineCallbacks
  ): Promise<ConversionOutputBlob> {
    // Acquire lock
    if (!this.acquireConversionLock()) {
      throw new Error('Another conversion is already in progress. Please wait for it to complete.');
    }

    // Store callbacks
    this.callbacks = callbacks || {};

    try {
      // Ensure FFmpeg is initialized
      if (!this.isLoaded()) {
        logger.warn('general', 'FFmpeg not initialized, initializing now...');
        await this.initialize(callbacks?.onProgress, callbacks?.onStatusUpdate);
      }

      // Start monitoring
      this.monitoring.startWatchdog({
        metadata,
        quality: options.quality,
        enableLogSilenceCheck: true,
      });

      // Execute conversion
      const result = await this.encoder.convertToGIF(file, options, metadata, inputOverride);

      // Stop monitoring
      this.monitoring.stopWatchdog();

      return result;
    } finally {
      // Always release lock and cleanup
      this.monitoring.stopWatchdog();
      this.releaseConversionLock();
      this.callbacks = {};
    }
  }

  /**
   * Convert video to WebP
   *
   * Converts video file to animated WebP.
   *
   * @param file Input video file
   * @param options Conversion options (quality, scale, etc.)
   * @param metadata Video metadata (optional, will be fetched if not provided)
   * @param inputOverride Input format override for transcoding
   * @param callbacks Progress and status callbacks
   * @returns WebP blob
   */
  async convertToWebP(
    file: File,
    options: ConversionOptions,
    metadata?: VideoMetadata,
    inputOverride?: FFmpegInputOverride,
    callbacks?: PipelineCallbacks
  ): Promise<ConversionOutputBlob> {
    // Acquire lock
    if (!this.acquireConversionLock()) {
      throw new Error('Another conversion is already in progress. Please wait for it to complete.');
    }

    // Store callbacks
    this.callbacks = callbacks || {};

    try {
      // Ensure FFmpeg is initialized
      if (!this.isLoaded()) {
        logger.warn('general', 'FFmpeg not initialized, initializing now...');
        await this.initialize(callbacks?.onProgress, callbacks?.onStatusUpdate);
      }

      // Start monitoring
      this.monitoring.startWatchdog({
        metadata,
        quality: options.quality,
        enableLogSilenceCheck: true,
      });

      // Execute conversion
      const result = await this.encoder.convertToWebP(file, options, metadata, inputOverride);

      // Stop monitoring
      this.monitoring.stopWatchdog();

      return result;
    } finally {
      // Always release lock and cleanup
      this.monitoring.stopWatchdog();
      this.releaseConversionLock();
      this.callbacks = {};
    }
  }

  /**
   * Encode frame sequence to GIF or WebP
   *
   * Encodes a sequence of frames (already written to VFS) to GIF or WebP.
   * Used by WebCodecs path for GPU-decoded frames.
   *
   * @param params Frame sequence parameters
   * @param callbacks Progress and status callbacks
   * @returns Encoded blob (GIF or WebP)
   */
  async encodeFrameSequence(
    params: FrameSequenceParams,
    callbacks?: PipelineCallbacks
  ): Promise<Blob> {
    // Acquire lock
    if (!this.acquireConversionLock()) {
      throw new Error('Another conversion is already in progress. Please wait for it to complete.');
    }

    // Store callbacks
    this.callbacks = callbacks || {};

    try {
      // Ensure FFmpeg is initialized
      if (!this.isLoaded()) {
        logger.warn('general', 'FFmpeg not initialized, initializing now...');
        await this.initialize(callbacks?.onProgress, callbacks?.onStatusUpdate);
      }

      // Start monitoring
      this.monitoring.startWatchdog({
        quality: params.options.quality,
        enableLogSilenceCheck: true,
      });

      // Execute encoding
      const result = await this.encoder.encodeFrameSequence(params);

      // Stop monitoring
      this.monitoring.stopWatchdog();

      return result;
    } finally {
      // Always release lock and cleanup
      this.monitoring.stopWatchdog();
      this.releaseConversionLock();
      this.callbacks = {};
    }
  }

  /**
   * Cancel ongoing conversion
   *
   * Signals cancellation to encoder. The conversion will be terminated
   * at the next safe checkpoint.
   */
  cancelConversion(): void {
    logger.info('general', 'Cancellation requested');
    this.encoder.cancelConversion();
  }

  /**
   * Write file to FFmpeg VFS
   *
   * @param fileName File name in VFS
   * @param data File data
   */
  async writeVirtualFile(fileName: string, data: Uint8Array | string): Promise<void> {
    if (!this.isLoaded()) {
      throw new Error('FFmpeg not initialized. Call initialize() first.');
    }
    await this.vfs.writeFile(this.getFFmpeg(), fileName, data);
  }

  /**
   * Delete files from FFmpeg VFS
   *
   * @param fileNames Array of file names to delete
   */
  async deleteVirtualFiles(fileNames: string[]): Promise<void> {
    if (!this.isLoaded()) {
      logger.debug('general', 'FFmpeg not initialized, skipping file deletion');
      return;
    }
    await this.vfs.deleteFiles(this.getFFmpeg(), fileNames);
  }

  /**
   * Clear cached input file
   *
   * Removes cached input file from VFS and clears cache tracking.
   * Safe to call even if FFmpeg is not initialized.
   */
  async clearCachedInput(): Promise<void> {
    if (!this.isLoaded()) {
      logger.debug('general', 'FFmpeg not initialized, skipping cache clear');
      return;
    }
    await this.vfs.clearCachedInput(this.getFFmpeg());
  }

  /**
   * Report progress manually
   *
   * Used by external callers to report progress during custom operations.
   *
   * @param progress Progress percentage (0-100)
   */
  reportProgress(progress: number): void {
    this.monitoring.updateProgress(progress, false);
  }

  /**
   * Report status manually
   *
   * Used by external callers to report status during custom operations.
   *
   * @param message Status message
   */
  reportStatus(message: string): void {
    this.callbacks.onStatusUpdate?.(message);
  }

  /**
   * Check if cancellation was requested
   */
  isCancellationRequested(): boolean {
    return this.encoder.isCancellationRequested();
  }

  /**
   * Start progress heartbeat
   *
   * Emits synthetic progress updates for long-running operations.
   *
   * @param startProgress Starting progress percentage
   * @param endProgress Ending progress percentage
   * @param estimatedDurationSeconds Estimated operation duration
   * @returns Interval ID for stopping the heartbeat
   */
  startProgressHeartbeat(
    startProgress: number,
    endProgress: number,
    estimatedDurationSeconds: number
  ): ReturnType<typeof setInterval> {
    return this.monitoring.startProgressHeartbeat(
      startProgress,
      endProgress,
      estimatedDurationSeconds
    );
  }

  /**
   * Stop progress heartbeat
   *
   * @param intervalId Interval ID from startProgressHeartbeat
   */
  stopProgressHeartbeat(intervalId: ReturnType<typeof setInterval> | null): void {
    this.monitoring.stopProgressHeartbeat(intervalId);
  }

  /**
   * Begin external conversion
   *
   * Starts monitoring for an external conversion (e.g., WebCodecs).
   * Used when encoding is handled outside FFmpeg but monitoring is still needed.
   *
   * @param metadata Video metadata for adaptive timeout
   * @param quality Conversion quality for adaptive timeout
   * @param options Watchdog options
   */
  beginExternalConversion(
    metadata?: VideoMetadata,
    quality?: ConversionQuality,
    options?: { enableLogSilenceCheck?: boolean }
  ): void {
    logger.debug('general', 'Beginning external conversion monitoring');
    this.monitoring.startWatchdog({
      metadata,
      quality,
      enableLogSilenceCheck: options?.enableLogSilenceCheck ?? false,
    });
  }

  /**
   * End external conversion
   *
   * Notifies monitoring that an external conversion has completed.
   * Resets watchdog state but doesn't stop it.
   */
  endExternalConversion(): void {
    this.monitoring.updateProgress(100, false);
  }

  /**
   * Get recent FFmpeg logs
   *
   * Returns recent FFmpeg log output for debugging and error classification.
   *
   * @returns Array of recent log entries
   */
  getRecentFFmpegLogs(): string[] {
    return this.core.getRecentLogs();
  }

  /**
   * Terminate FFmpeg
   *
   * Forcefully terminates FFmpeg instance and cleans up all resources.
   * After termination, FFmpeg must be reinitialized before use.
   */
  terminate(): void {
    logger.info('general', 'Terminating FFmpeg pipeline');

    try {
      // Stop all monitoring
      this.monitoring.stopWatchdog();
      this.monitoring.cleanupResources();

      // Terminate FFmpeg
      this.core.terminate();

      // Clear VFS state
      this.vfs.clearInputCacheTimer();
      this.vfs.clearKnownFiles();

      // Release lock if held
      if (this.conversionLock) {
        this.releaseConversionLock();
      }

      // Clear callbacks
      this.callbacks = {};

      logger.debug('general', 'FFmpeg pipeline terminated successfully');
    } catch (error) {
      const message = getErrorMessage(error);
      logger.error('general', 'Error during termination', { error: message });
    }
  }

  /**
   * Cleanup resources
   *
   * Performs non-destructive cleanup (temp files, caches) without terminating FFmpeg.
   * Safe to call between conversions.
   */
  async cleanup(): Promise<void> {
    logger.debug('general', 'Cleaning up resources');

    try {
      // Clean up temp files
      await this.vfs.cleanupTempFiles(this.core.getFFmpeg());

      // Handle input cache based on memory status
      if (isMemoryCritical()) {
        logger.debug('general', 'Memory critical - clearing cached input');
        await this.vfs.clearCachedInput(this.core.getFFmpeg());
      }

      logger.debug('general', 'Resource cleanup complete');
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn('general', 'Error during cleanup (non-critical)', { error: message });
    }
  }
}

/**
 * Create FFmpeg pipeline instance
 *
 * @returns New FFmpegPipeline instance
 */
export function createFFmpegPipeline(): FFmpegPipeline {
  return new FFmpegPipeline();
}

// Re-export types from encoder module
export type { FFmpegInputOverride } from './ffmpeg-encoder';
