/**
 * FFmpeg Service
 *
 * Thin singleton wrapper around FFmpegPipeline for backward compatibility.
 * All substantive logic lives in the pipeline module.
 */

import {
  type FFmpegInputOverride,
  FFmpegPipeline,
  type FrameSequenceParams,
} from '@services/cpu-path/ffmpeg-pipeline-service';
import type { ConversionOptions, ConversionOutputBlob, VideoMetadata } from '@t/conversion-types';

class FFmpegService {
  private pipeline: FFmpegPipeline;

  constructor() {
    this.pipeline = new FFmpegPipeline();
  }

  isLoaded(): boolean {
    return this.pipeline.isLoaded();
  }

  isInitializing(): boolean {
    return this.pipeline.isInitializing();
  }

  prefetchCoreAssets(): Promise<void> {
    return this.pipeline.prefetchCoreAssets();
  }

  async initialize(
    onProgress?: (progress: number) => void,
    onStatus?: (message: string) => void
  ): Promise<void> {
    return this.pipeline.initialize(onProgress, onStatus);
  }

  async getVideoMetadata(file: File): Promise<VideoMetadata> {
    return this.pipeline.getVideoMetadata(file);
  }

  async convertToGIF(
    file: File,
    options: ConversionOptions,
    metadata?: VideoMetadata,
    inputOverride?: FFmpegInputOverride
  ): Promise<ConversionOutputBlob> {
    return this.pipeline.convertToGIF(file, options, metadata, inputOverride, {
      onProgress: (progress) => this.reportProgress(progress),
      onStatusUpdate: (message) => this.reportStatus(message),
      shouldCancel: () => this.isCancellationRequested(),
    });
  }

  async convertToWebP(
    file: File,
    options: ConversionOptions,
    metadata?: VideoMetadata,
    inputOverride?: FFmpegInputOverride
  ): Promise<ConversionOutputBlob> {
    return this.pipeline.convertToWebP(file, options, metadata, inputOverride, {
      onProgress: (progress) => this.reportProgress(progress),
      onStatusUpdate: (message) => this.reportStatus(message),
      shouldCancel: () => this.isCancellationRequested(),
    });
  }

  async encodeFrameSequence(params: FrameSequenceParams): Promise<Blob> {
    return this.pipeline.encodeFrameSequence(params, {
      onProgress: (progress) => this.reportProgress(progress),
      onStatusUpdate: (message) => this.reportStatus(message),
      shouldCancel: () => this.isCancellationRequested(),
    });
  }

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

  endExternalConversion(): void {
    this.pipeline.endExternalConversion();
  }
  getMonitoring() {
    return this.pipeline.getMonitoring();
  }
  getRecentFFmpegLogs(): string[] {
    return this.pipeline.getRecentFFmpegLogs();
  }

  setProgressCallback(cb: ((p: number) => void) | null): void {
    this.pipeline.setProgressCallback(cb);
  }
  setStatusCallback(cb: ((m: string) => void) | null): void {
    this.pipeline.setStatusCallback(cb);
  }
  reportProgress(p: number): void {
    this.pipeline.reportProgress(p);
  }
  reportStatus(m: string): void {
    this.pipeline.reportStatus(m);
  }

  isCancellationRequested(): boolean {
    return this.pipeline.isCancellationRequested();
  }

  async writeVirtualFile(fn: string, data: Uint8Array | string): Promise<void> {
    return this.pipeline.writeVirtualFile(fn, data);
  }
  async deleteVirtualFiles(fns: string[]): Promise<void> {
    return this.pipeline.deleteVirtualFiles(fns);
  }
  cancelConversion(): void {
    this.pipeline.cancelConversion();
  }
  async clearCachedInput(): Promise<void> {
    return this.pipeline.clearCachedInput();
  }
  terminate(): void {
    this.pipeline.terminate();
  }

  startProgressHeartbeat(sp: number, ep: number, eds: number): ReturnType<typeof setInterval> {
    return this.pipeline.startProgressHeartbeat(sp, ep, eds);
  }
  stopProgressHeartbeat(id: ReturnType<typeof setInterval> | null): void {
    this.pipeline.stopProgressHeartbeat(id);
  }
}

/**
 * Global FFmpeg service instance
 */
const ffmpegService = new FFmpegService();

export { ffmpegService };
