/**
 * FFmpeg Service
 *
 * High-level wrapper around FFmpegPipeline for backward compatibility.
 * Provides the original FFmpegService API while delegating to the new
 * modular architecture.
 *
 * This service maintains compatibility with existing code while benefiting
 * from the refactored modular structure (core, vfs, monitoring, encoder, pipeline).
 *
 * @module services/ffmpeg-service
 */

import type { ConversionOptions, ConversionOutputBlob, VideoMetadata } from '@t/conversion-types';
import {
  type FFmpegInputOverride,
  type FrameSequenceParams,
  FFmpegPipeline,
} from './cpu-path/ffmpeg-pipeline';

/**
 * FFmpeg Service
 *
 * Backward-compatible wrapper around FFmpegPipeline.
 * Maintains the original API while using the new modular architecture.
 */
class FFmpegService {
  private pipeline: FFmpegPipeline;
  private progressCallback: ((progress: number) => void) | null = null;
  private statusCallback: ((message: string) => void) | null = null;

  constructor() {
    this.pipeline = new FFmpegPipeline();
  }

  /**
   * Check if FFmpeg is loaded
   */
  isLoaded(): boolean {
    return this.pipeline.isLoaded();
  }

  /**
   * Check if currently initializing
   */
  isInitializing(): boolean {
    return this.pipeline.isInitializing();
  }

  /**
   * Prefetch FFmpeg core assets in background
   */
  prefetchCoreAssets(): Promise<void> {
    return this.pipeline.prefetchCoreAssets();
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
    return this.pipeline.initialize(onProgress, onStatus);
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
    return this.pipeline.getVideoMetadata(file);
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
   * @returns GIF blob
   */
  async convertToGIF(
    file: File,
    options: ConversionOptions,
    metadata?: VideoMetadata,
    inputOverride?: FFmpegInputOverride
  ): Promise<ConversionOutputBlob> {
    return this.pipeline.convertToGIF(file, options, metadata, inputOverride, {
      onProgress: (progress) => {
        this.reportProgress(progress);
      },
      onStatusUpdate: (message) => {
        this.reportStatus(message);
      },
      shouldCancel: () => this.isCancellationRequested(),
    });
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
   * @returns WebP blob
   */
  async convertToWebP(
    file: File,
    options: ConversionOptions,
    metadata?: VideoMetadata,
    inputOverride?: FFmpegInputOverride
  ): Promise<ConversionOutputBlob> {
    return this.pipeline.convertToWebP(file, options, metadata, inputOverride, {
      onProgress: (progress) => {
        this.reportProgress(progress);
      },
      onStatusUpdate: (message) => {
        this.reportStatus(message);
      },
      shouldCancel: () => this.isCancellationRequested(),
    });
  }

  /**
   * Encode frame sequence to GIF or WebP
   *
   * Encodes a sequence of frames (already written to VFS) to GIF or WebP.
   * Used by WebCodecs path for GPU-decoded frames.
   *
   * @param params Frame sequence parameters
   * @returns Encoded blob (GIF or WebP)
   */
  async encodeFrameSequence(params: FrameSequenceParams): Promise<Blob> {
    return this.pipeline.encodeFrameSequence(params, {
      onProgress: (progress) => {
        this.reportProgress(progress);
      },
      onStatusUpdate: (message) => {
        this.reportStatus(message);
      },
      shouldCancel: () => this.isCancellationRequested(),
    });
  }

  /**
   * Begin external conversion
   *
   * Starts monitoring for an external conversion (e.g., WebCodecs).
   *
   * @param metadata Video metadata for adaptive timeout
   * @param quality Conversion quality for adaptive timeout
   * @param format Output format (affects watchdog timeout - WebP needs longer)
   * @param options Watchdog options
   */
  beginExternalConversion(
    metadata?: VideoMetadata,
    quality?: string,
    format?: 'gif' | 'webp' | 'mp4',
    options?: { enableLogSilenceCheck?: boolean }
  ): void {
    this.pipeline.beginExternalConversion(
      metadata,
      quality as 'low' | 'medium' | 'high' | undefined,
      format,
      options
    );
  }

  /**
   * End external conversion
   *
   * Notifies monitoring that an external conversion has completed.
   */
  endExternalConversion(): void {
    this.pipeline.endExternalConversion();
  }

  /**
   * Get monitoring instance
   */
  getMonitoring() {
    return this.pipeline.getMonitoring();
  }

  /**
   * Get recent FFmpeg logs
   *
   * Returns recent FFmpeg log output for debugging and error classification.
   *
   * @returns Array of recent log entries
   */
  getRecentFFmpegLogs(): string[] {
    return this.pipeline.getRecentFFmpegLogs();
  }

  /**
   * Report progress
   *
   * @param progress Progress percentage (0-100)
   */
  reportProgress(progress: number): void {
    this.progressCallback?.(progress);
    // Do NOT call pipeline.reportProgress here - it creates infinite recursion
    // The pipeline already calls this method via the onProgress callback
  }

  /**
   * Report status
   *
   * @param message Status message
   */
  reportStatus(message: string): void {
    this.statusCallback?.(message);
    // Do NOT call pipeline.reportStatus here - it creates infinite recursion
    // The pipeline already calls this method via the onStatus callback
  }

  /**
   * Check if cancellation was requested
   */
  isCancellationRequested(): boolean {
    return this.pipeline.isCancellationRequested();
  }

  /**
   * Write file to FFmpeg VFS
   *
   * @param fileName File name in VFS
   * @param data File data
   */
  async writeVirtualFile(fileName: string, data: Uint8Array | string): Promise<void> {
    return this.pipeline.writeVirtualFile(fileName, data);
  }

  /**
   * Delete files from FFmpeg VFS
   *
   * @param fileNames Array of file names to delete
   */
  async deleteVirtualFiles(fileNames: string[]): Promise<void> {
    return this.pipeline.deleteVirtualFiles(fileNames);
  }

  /**
   * Cancel ongoing conversion
   */
  cancelConversion(): void {
    this.pipeline.cancelConversion();
  }

  /**
   * Clear cached input file
   */
  async clearCachedInput(): Promise<void> {
    return this.pipeline.clearCachedInput();
  }

  /**
   * Terminate FFmpeg
   *
   * Forcefully terminates FFmpeg instance and cleans up all resources.
   */
  terminate(): void {
    this.pipeline.terminate();
  }

  /**
   * Start progress heartbeat
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
    return this.pipeline.startProgressHeartbeat(
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
    this.pipeline.stopProgressHeartbeat(intervalId);
  }

  /**
   * Set progress callback
   *
   * @param callback Progress callback function (null to clear)
   */
  setProgressCallback(callback: ((progress: number) => void) | null): void {
    this.progressCallback = callback;
  }

  /**
   * Set status callback
   *
   * @param callback Status callback function (null to clear)
   */
  setStatusCallback(callback: ((message: string) => void) | null): void {
    this.statusCallback = callback;
  }

  /**
   * Clear progress callback
   */
  clearProgressCallback(): void {
    this.progressCallback = null;
  }

  /**
   * Clear status callback
   */
  clearStatusCallback(): void {
    this.statusCallback = null;
  }
}

/**
 * Global FFmpeg service instance
 */
const ffmpegService = new FFmpegService();

export { ffmpegService };
export type { FFmpegInputOverride, FrameSequenceParams };
