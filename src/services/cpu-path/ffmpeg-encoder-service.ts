// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * FFmpeg Encoder
 *
 * Direct encoding operations for GIF and WebP formats using FFmpeg.
 * Handles palette generation, frame sequence encoding, and codec transcoding.
 *
 * Features:
 * - GIF encoding with palette generation and dithering
 * - WebP encoding with timestamp support
 * - Frame sequence encoding from WebCodecs
 * - AV1/HEVC transcoding via H.264 intermediate
 * - Conversion lock to prevent concurrent operations
 *
 * @module cpu-path/ffmpeg-encoder
 */

import type { FFmpeg } from '@ffmpeg/ffmpeg';
import { getThreadingArgs } from '@services/ffmpeg/threading-service';
import type {
  ConversionOptions,
  ConversionOutputBlob,
  ConversionQuality,
  VideoMetadata,
} from '@t/conversion-types';
import { CANCELLED_MESSAGE, throwIfAborted } from '@utils/cancellation-context';
import { classifyConversionError } from '@utils/classify-conversion-error';
import { QUALITY_PRESETS } from '@utils/constants';
import { getErrorMessage } from '@utils/error-utils';
import { FFMPEG_INTERNALS } from '@utils/ffmpeg-constants';
import { logger } from '@utils/logger';
import { isMemoryCritical } from '@utils/memory-monitor';
import { performanceTracker } from '@utils/performance-tracker';
import { getOptimalFPS } from '@utils/quality-optimizer';
import { calculateTimeout, getTimeoutForFormat } from '@utils/timeout-calculator';
import { withTimeout } from '@utils/with-timeout';
import type { FFmpegCore } from './ffmpeg-core-service';
import type { FFmpegMonitoring } from './ffmpeg-monitoring-service';
import type { FFmpegVFS } from './ffmpeg-vfs-service';

/**
 * Detect frame file extension from frame file list
 * Returns 'png' or 'jpeg' based on first frame file extension
 */
function detectFrameExtension(frameFiles?: string[]): 'png' | 'jpeg' {
  if (!frameFiles || frameFiles.length === 0) {
    return 'png'; // Default to PNG for backward compatibility
  }

  const firstFrame = frameFiles[0];
  if (!firstFrame) {
    return 'png';
  }

  const extension = firstFrame.split('.').pop()?.toLowerCase();

  if (extension === 'jpg' || extension === 'jpeg') {
    return 'jpeg';
  }

  return 'png';
}

/**
 * FFmpeg input format override for transcoding operations
 */
export interface FFmpegInputOverride {
  format: 'h264';
  framerate: number;
}

/**
 * Encoder dependencies
 */
export interface EncoderDependencies {
  core: FFmpegCore;
  vfs: FFmpegVFS;
  monitoring: FFmpegMonitoring;
  onProgress?: (progress: number) => void;
  onStatusUpdate?: (message: string) => void;
  shouldCancel?: () => boolean;
}

/**
 * FFmpeg encoder
 *
 * Manages direct encoding operations for GIF and WebP formats.
 */
export class FFmpegEncoder {
  private conversionLock = false;

  private static isValidLibwebpPreset(preset: string): boolean {
    return (
      preset === 'default' ||
      preset === 'picture' ||
      preset === 'photo' ||
      preset === 'drawing' ||
      preset === 'icon' ||
      preset === 'text'
    );
  }
  private cancellationRequested = false;
  private dependencies: EncoderDependencies | null = null;

  private static readonly CANCELLED_TERMINATION_MESSAGE = 'called FFmpeg.terminate()';
  private static readonly CANCELLED_KEYWORDS = [
    CANCELLED_MESSAGE.toLowerCase(),
    'cancelled by user',
    FFmpegEncoder.CANCELLED_TERMINATION_MESSAGE,
  ];

  private getDurationMs(metadata?: VideoMetadata, options?: ConversionOptions): number | undefined {
    // Prefer analyzed metadata when available. Fall back to options.duration when
    // callers already provided it (both are expressed in seconds).
    const durationSeconds = metadata?.duration ?? options?.duration;

    if (!Number.isFinite(durationSeconds) || !durationSeconds || durationSeconds <= 0) {
      return undefined;
    }

    return Math.round(durationSeconds * 1000);
  }

  private isFFmpegProgressKeyValueLine(line: string): boolean {
    // FFmpeg `-progress pipe:1` emits key/value pairs on stdout.
    // Logging each line is extremely noisy and makes captured dev logs hard to read.
    // We keep parsing these lines for progress, but suppress their console output.
    const key = line.split('=')[0]?.trim();
    if (!key) {
      return false;
    }

    return (
      key === 'frame' ||
      key === 'fps' ||
      key === 'stream_0_0_q' ||
      key === 'bitrate' ||
      key === 'total_size' ||
      key === 'out_time_us' ||
      key === 'out_time_ms' ||
      key === 'out_time' ||
      key === 'dup_frames' ||
      key === 'drop_frames' ||
      key === 'speed' ||
      key === 'progress'
    );
  }

  /**
   * Set encoder dependencies
   */
  setDependencies(deps: EncoderDependencies): void {
    this.dependencies = deps;
  }

  /**
   * Get dependencies
   */
  private getDeps(): EncoderDependencies {
    if (!this.dependencies) {
      throw new Error('Encoder dependencies not set');
    }
    return this.dependencies;
  }

  /**
   * Update status message
   */
  private updateStatus(message: string): void {
    this.getDeps().onStatusUpdate?.(message);
  }

  /**
   * Acquire the encoder-level conversion lock.
   *
   * Typically called by FFmpegPipeline.acquireConversionLock() which keeps
   * both pipeline-level and encoder-level locks in sync.
   */
  acquireLock(): void {
    this.conversionLock = true;
    this.cancellationRequested = false;
  }

  /**
   * Release the encoder-level conversion lock.
   *
   * Typically called by FFmpegPipeline.releaseConversionLock() which releases
   * both locks together to prevent deadlocks.
   */
  releaseLock(): void {
    this.conversionLock = false;
  }

  /**
   * Check whether the encoder-level conversion lock is currently held.
   */
  isLockHeld(): boolean {
    return this.conversionLock;
  }

  /**
   * Validate that FFmpeg is properly initialized
   *
   * Checks FFmpeg state and logs diagnostic information.
   *
   * @throws Error if FFmpeg is not in valid state
   */
  private validateFFmpegState(): void {
    const { core } = this.getDeps();

    if (!core.isLoaded()) {
      logger.error('ffmpeg', 'FFmpeg validation failed: not loaded', {
        isLoaded: core.isLoaded(),
        isInitializing: core.isInitializing(),
      });
      throw new Error('FFmpeg is not loaded. Please initialize FFmpeg first.');
    }

    try {
      // This will throw if FFmpeg instance is null or invalid
      core.getFFmpeg();
      logger.debug('ffmpeg', 'FFmpeg state validation passed');
    } catch (error) {
      logger.error('ffmpeg', 'FFmpeg validation failed: instance check', {
        error: getErrorMessage(error),
      });
      throw new Error(`FFmpeg instance invalid: ${getErrorMessage(error)}`);
    }
  }

  private isCancellationError(errorMessage: string): boolean {
    const normalized = errorMessage.toLowerCase();
    return FFmpegEncoder.CANCELLED_KEYWORDS.some((keyword) => normalized.includes(keyword));
  }

  /**
   * Create FFmpeg log handler for conversion operations
   */
  private createFFmpegLogHandler(
    totalDuration?: number,
    progressStart?: number,
    progressEnd?: number
  ): (event: { type: string; message: string }) => void {
    const { monitoring } = this.getDeps();

    return ({ type, message }: { type: string; message: string }) => {
      const trimmed = message.trim();
      monitoring.updateLogActivity();

      // ffmpeg.wasm may emit a standalone "Aborted()" line on stderr even when the
      // exec call has already completed successfully. This is noisy and misleading
      // in dev logs, so we suppress it from console logging.
      if (type === 'stderr' && trimmed === 'Aborted()') {
        return;
      }

      // Suppress ultra-noisy stdout key/value lines from FFmpeg progress output.
      // These are still stored in the rolling log buffer for diagnostics.
      if (type === 'stdout' && this.isFFmpegProgressKeyValueLine(trimmed)) {
        // Still allow progress parsing below.
      } else {
        // Route raw FFmpeg stderr/stdout to the separate FFmpeg log buffer
        // to prevent verbose output from evicting important application logs.
        logger.addFfmpegLog('DEBUG', message, type);
      }

      if (type === 'fferr' || message.includes('Error') || message.includes('failed')) {
        // Warnings/errors go to BOTH buffers: main (for visibility) and FFmpeg (for diagnostics)
        logger.warn('ffmpeg', `FFmpeg warning/error: ${message}`);
        logger.addFfmpegLog('WARN', `FFmpeg warning/error: ${message}`);
      }

      // Parse progress from FFmpeg logs when native progress events don't fire
      if (totalDuration && progressStart !== undefined && progressEnd !== undefined) {
        this.parseProgressFromLog(message, totalDuration, progressStart, progressEnd);
      }
    };
  }

  /**
   * Parse progress information from FFmpeg log messages
   */
  private parseProgressFromLog(
    message: string,
    totalDuration: number,
    progressStart: number,
    progressEnd: number
  ): void {
    const { monitoring } = this.getDeps();

    // Parse time information: "time=00:01:23.45"
    const timeMatch = message.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
    if (timeMatch) {
      const hours = Number.parseInt(timeMatch[1] ?? '0', 10);
      const minutes = Number.parseInt(timeMatch[2] ?? '0', 10);
      const seconds = Number.parseFloat(timeMatch[3] ?? '0');
      const currentTime = hours * 3600 + minutes * 60 + seconds;

      const progressRatio = Math.min(currentTime / totalDuration, 1.0);
      const progressRange = progressEnd - progressStart;
      const calculatedProgress = progressStart + progressRatio * progressRange;

      monitoring.updateProgress(Math.round(calculatedProgress));
      return;
    }

    // Parse progress-format output from `-progress`.
    // Important: despite the name, FFmpeg's `out_time_ms` is historically reported in
    // microseconds (observed in ffmpeg.wasm logs: out_time_ms=1910000 for time=1.91s).
    const outTimeUsMatch = message.match(/out_time_us=(\d+)/);
    if (outTimeUsMatch) {
      const currentTime = Number.parseInt(outTimeUsMatch[1] ?? '0', 10) / 1_000_000;
      const progressRatio = Math.min(currentTime / totalDuration, 1.0);
      const progressRange = progressEnd - progressStart;
      const calculatedProgress = progressStart + progressRatio * progressRange;

      monitoring.updateProgress(Math.round(calculatedProgress));
      return;
    }

    const outTimeMatch = message.match(/out_time=(\d{2}):(\d{2}):(\d{2}\.\d{2,6})/);
    if (outTimeMatch) {
      const hours = Number.parseInt(outTimeMatch[1] ?? '0', 10);
      const minutes = Number.parseInt(outTimeMatch[2] ?? '0', 10);
      const seconds = Number.parseFloat(outTimeMatch[3] ?? '0');
      const currentTime = hours * 3600 + minutes * 60 + seconds;

      const progressRatio = Math.min(currentTime / totalDuration, 1.0);
      const progressRange = progressEnd - progressStart;
      const calculatedProgress = progressStart + progressRatio * progressRange;

      monitoring.updateProgress(Math.round(calculatedProgress));
      return;
    }

    const outTimeMsMatch = message.match(/out_time_ms=(\d+)/);
    if (outTimeMsMatch) {
      const currentTime = Number.parseInt(outTimeMsMatch[1] ?? '0', 10) / 1_000_000;
      const progressRatio = Math.min(currentTime / totalDuration, 1.0);
      const progressRange = progressEnd - progressStart;
      const calculatedProgress = progressStart + progressRatio * progressRange;

      monitoring.updateProgress(Math.round(calculatedProgress));
    }
  }

  /**
   * Build FFmpeg input arguments
   */
  private buildInputArgs(inputFileName: string, inputOverride?: FFmpegInputOverride): string[] {
    if (inputOverride) {
      logger.debug('ffmpeg', 'Using input format override', {
        format: inputOverride.format,
        framerate: inputOverride.framerate,
      });
      return [
        '-f',
        inputOverride.format,
        '-r',
        inputOverride.framerate.toString(),
        '-i',
        inputFileName,
      ];
    }

    return ['-i', inputFileName];
  }

  /**
   * Enrich conversion error with context
   *
   * Safely adds error context without causing stack overflow.
   * If error classification fails, returns the original error.
   */
  private enrichConversionError(params: {
    error: unknown;
    format: 'gif' | 'webp';
    options: ConversionOptions;
    metadata?: VideoMetadata;
  }): Error {
    const { error, format, options, metadata } = params;
    const message = getErrorMessage(error);

    // Prevent stack overflow during error handling
    try {
      const { core } = this.getDeps();

      // Safely get logs with fallback
      let ffmpegLogs: string[] | undefined;
      try {
        ffmpegLogs = core.getRecentLogs();
      } catch {
        ffmpegLogs = undefined;
      }

      const context = classifyConversionError(
        message,
        metadata ?? null,
        { format, quality: options.quality, scale: options.scale, trimStart: 0, trimEnd: 0 },
        ffmpegLogs
      );

      if (error instanceof Error) {
        (error as unknown as { errorContext?: unknown }).errorContext ??= context;
        return error;
      }

      const enriched = new Error(message);
      (enriched as unknown as { errorContext?: unknown }).errorContext = context;
      return enriched;
    } catch (enrichError) {
      // If error enrichment fails, return original error
      logger.warn('ffmpeg', 'Failed to enrich error context', {
        originalError: message,
        enrichError: getErrorMessage(enrichError),
      });

      if (error instanceof Error) {
        return error;
      }

      return new Error(message);
    }
  }

  /**
   * Execute an FFmpeg command with unified progress tracking, heartbeat, and timeout.
   *
   * Encapsulates the repeated pattern of:
   * log handler registration → heartbeat start → timeout-guarded exec → cleanup
   *
   * @param ffmpeg - FFmpeg instance
   * @param cmd - FFmpeg command array
   * @param opts - Execution options (timeout, progress range, duration for estimates)
   */
  private async executeFFmpegWithProgress(
    ffmpeg: FFmpeg,
    cmd: string[],
    opts: {
      timeout: number;
      timeoutMessage: string;
      progressStart: number;
      progressEnd: number;
      durationSeconds: number;
      onTimeout?: () => void;
    }
  ): Promise<void> {
    const { monitoring } = this.getDeps();
    const logHandler = this.createFFmpegLogHandler(
      opts.durationSeconds,
      opts.progressStart,
      opts.progressEnd
    );
    ffmpeg.on('log', logHandler);

    const heartbeat = monitoring.startProgressHeartbeat(
      opts.progressStart,
      opts.progressEnd,
      Math.max(10, Math.ceil(opts.durationSeconds * 2.5))
    );

    try {
      await withTimeout(ffmpeg.exec(cmd), opts.timeout, opts.timeoutMessage, () => {
        const { core, onStatusUpdate } = this.getDeps();
        onStatusUpdate?.('Terminating FFmpeg...');
        opts.onTimeout?.();
        core.terminate();
      });
    } finally {
      ffmpeg.off('log', logHandler);
      monitoring.stopProgressHeartbeat(heartbeat);
    }
  }

  /**
   * Read FFmpeg output file, validate it, clean up VFS files, and create a Blob.
   */
  private async readOutputAndCleanup(
    ffmpeg: FFmpeg,
    outputFileName: string,
    format: 'gif' | 'webp',
    inputFilesToDelete: string[]
  ): Promise<ConversionOutputBlob> {
    const { vfs } = this.getDeps();

    try {
      await vfs.deleteFiles(ffmpeg, inputFilesToDelete);
    } catch {
      // Non-fatal
    }

    const outputData = await vfs.readValidatedOutputFile(
      ffmpeg,
      outputFileName,
      format,
      `${format.toUpperCase()} output validation failed`
    );

    try {
      await vfs.deleteFiles(ffmpeg, [outputFileName]);
    } catch {
      // Non-fatal
    }

    return new Blob([new Uint8Array(outputData)], {
      type: format === 'gif' ? 'image/gif' : 'image/webp',
    }) as ConversionOutputBlob;
  }

  async encodeFrameSequence(params: {
    format: 'gif' | 'webp';
    options: ConversionOptions;
    frameCount: number;
    fps: number;
    durationSeconds: number;
    frameFiles?: string[];
    frameInput?:
      | {
          kind: 'image-sequence';
          frameFiles: string[];
        }
      | {
          kind: 'rawvideo';
          fileName: string;
          width: number;
          height: number;
          pixelFormat: 'rgba';
        };
    frameTimestamps?: number[];
    /** Progress offset for multi-phase pipelines (e.g., software decode = 50%) */
    progressOffset?: number;
  }): Promise<ConversionOutputBlob> {
    const {
      format,
      options,
      frameCount,
      fps,
      durationSeconds,
      frameFiles: providedFrameFiles,
      frameInput,
      progressOffset = 0,
    } = params;
    const { core, vfs } = this.getDeps();

    try {
      // Validate FFmpeg state before attempting encoding
      logger.debug('ffmpeg', 'Starting frame sequence encoding', {
        format,
        frameCount,
        fps,
        quality: options.quality,
      });

      this.validateFFmpegState();

      const ffmpeg = core.getFFmpeg();
      const outputFileName = format === 'gif' ? 'output.gif' : 'output.webp';

      // Validate frame sequence exists
      await this.validateFrameSequence(frameCount, format);

      if (format === 'gif') {
        await this.encodeFramesToGIFWithPalette(
          ffmpeg,
          outputFileName,
          { fps, frameCount, quality: options.quality },
          durationSeconds,
          providedFrameFiles,
          frameInput,
          progressOffset
        );
      } else {
        await this.encodeFramesToWebP(
          ffmpeg,
          outputFileName,
          { fps, frameCount, quality: options.quality },
          durationSeconds,
          providedFrameFiles,
          frameInput,
          progressOffset
        );
      }

      // Read + validate output (single pass to avoid double-reading the same file)
      const outputData = await vfs.readValidatedOutputFile(
        ffmpeg,
        outputFileName,
        format,
        'Output validation failed'
      );
      const blob = new Blob([new Uint8Array(outputData)], {
        type: format === 'gif' ? 'image/gif' : 'image/webp',
      }) as ConversionOutputBlob;

      // Cleanup
      const frameFilesToClean =
        frameInput?.kind === 'image-sequence' ? frameInput.frameFiles : providedFrameFiles || [];

      const additionalFilesToClean: string[] = [];
      if (frameInput?.kind === 'rawvideo') {
        additionalFilesToClean.push(frameInput.fileName);
      }
      if (frameFilesToClean.length === 0 && frameInput?.kind !== 'rawvideo') {
        // Fallback: reconstruct frame file names if not provided (old behavior for CPU path)
        for (let i = 0; i < frameCount; i++) {
          frameFilesToClean.push(`frame${i.toString().padStart(5, '0')}.png`);
        }
      }
      await vfs.handleConversionCleanup(
        ffmpeg,
        outputFileName,
        [...frameFilesToClean, ...additionalFilesToClean, FFMPEG_INTERNALS.PALETTE_FILE_NAME],
        isMemoryCritical
      );

      return blob;
    } catch (error) {
      throw this.enrichConversionError({
        error,
        format,
        options,
      });
    }
  }

  /**
   * Validate frame sequence
   */
  private async validateFrameSequence(frameCount: number, format: 'gif' | 'webp'): Promise<void> {
    logger.debug('ffmpeg', 'Validating frame sequence', {
      frameCount,
      format,
    });

    // GIF requires animation (>=2 frames), WebP supports static (1 frame)
    if (format === 'gif' && frameCount < 2) {
      throw new Error('GIF requires at least 2 frames for animation');
    }

    if (frameCount < 1) {
      throw new Error('Frame sequence must contain at least 1 frame');
    }
  }

  /**
   * Encode frames to GIF with palette generation
   */
  private async encodeFramesToGIFWithPalette(
    ffmpeg: FFmpeg,
    outputFileName: string,
    settings: { fps: number; frameCount: number; quality: ConversionQuality },
    durationSeconds: number,
    frameFiles?: string[],
    frameInput?:
      | {
          kind: 'image-sequence';
          frameFiles: string[];
        }
      | {
          kind: 'rawvideo';
          fileName: string;
          width: number;
          height: number;
          pixelFormat: 'rgba';
        },
    progressOffset = 0
  ): Promise<void> {
    const paletteFileName = FFMPEG_INTERNALS.PALETTE_FILE_NAME;
    const { fps, frameCount, quality } = settings;

    const qualitySettings = QUALITY_PRESETS.gif[quality];
    // Progress ranges shifted by offset for multi-phase pipelines
    const encodeStart = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START + progressOffset;
    const paletteEnd = 70 + progressOffset;
    const encodeEnd = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_END + progressOffset;

    const effectiveFrameInput =
      frameInput ??
      ({
        kind: 'image-sequence' as const,
        frameFiles: frameFiles || [],
      } satisfies { kind: 'image-sequence'; frameFiles: string[] });

    const buildInputArgs = (): {
      args: string[];
      frameFormatForLog: string;
    } => {
      if (effectiveFrameInput.kind === 'rawvideo') {
        const size = `${effectiveFrameInput.width}x${effectiveFrameInput.height}`;
        return {
          args: [
            '-f',
            'rawvideo',
            '-pixel_format',
            effectiveFrameInput.pixelFormat,
            '-video_size',
            size,
            '-framerate',
            fps.toString(),
            '-i',
            effectiveFrameInput.fileName,
          ],
          frameFormatForLog: `rawvideo(${effectiveFrameInput.pixelFormat},${size})`,
        };
      }

      // Detect frame file extension (PNG or JPEG) for correct FFmpeg input pattern
      const frameExtension = detectFrameExtension(effectiveFrameInput.frameFiles);
      const inputPattern = `frame_%06d.${frameExtension}`;
      return {
        args: ['-framerate', fps.toString(), '-i', inputPattern],
        frameFormatForLog: frameExtension,
      };
    };

    const { args: inputArgs, frameFormatForLog } = buildInputArgs();

    logger.info('ffmpeg', 'Generating GIF palette from frame sequence', {
      frameCount,
      fps,
      colors: qualitySettings.colors,
      frameFormat: frameFormatForLog,
    });

    // Generate palette — stats_mode=diff for low quality (focus palette on changed pixels)
    const statsMode = quality === 'low' ? ':stats_mode=diff' : '';
    const paletteThreadArgs = getThreadingArgs('filter-complex');
    // Use concat instead of spread to prevent stack overflow
    const paletteCmd = ([] as string[])
      .concat(Array.from(paletteThreadArgs))
      .concat(inputArgs)
      .concat([
        '-vf',
        `palettegen=max_colors=${qualitySettings.colors}${statsMode}`,
        '-update',
        '1',
        paletteFileName,
      ]);

    // Calculate adaptive timeout for GIF palette generation
    const gifTimeout = calculateTimeout('gif', durationSeconds * 1000);

    await this.executeFFmpegWithProgress(ffmpeg, paletteCmd, {
      timeout: gifTimeout,
      timeoutMessage: `WebCodecs GIF palette generation timed out after ${gifTimeout / 1000} seconds.`,
      progressStart: encodeStart,
      progressEnd: paletteEnd,
      durationSeconds,
    });

    // Convert frames to GIF using palette
    const conversionThreadArgs = getThreadingArgs('filter-complex');
    const ditherMode = quality === 'high' ? 'sierra2' : 'bayer';
    const bayerScale = quality === 'low' ? 3 : 2;
    const ditherConfig =
      ditherMode === 'bayer'
        ? `dither=${ditherMode}:bayer_scale=${bayerScale}:diff_mode=rectangle`
        : `dither=${ditherMode}:diff_mode=rectangle`;
    // Use concat instead of spread to prevent stack overflow
    const conversionCmd = ([] as string[])
      .concat(Array.from(conversionThreadArgs))
      .concat(inputArgs)
      .concat([
        '-i',
        paletteFileName,
        '-filter_complex',
        `paletteuse=${ditherConfig}`,
        outputFileName,
      ]);

    await this.executeFFmpegWithProgress(ffmpeg, conversionCmd, {
      timeout: gifTimeout,
      timeoutMessage: `WebCodecs GIF conversion timed out after ${gifTimeout / 1000} seconds.`,
      progressStart: paletteEnd,
      progressEnd: encodeEnd,
      durationSeconds,
    });
  }

  /**
   * Encode frames to WebP
   */
  private async encodeFramesToWebP(
    ffmpeg: FFmpeg,
    outputFileName: string,
    settings: { fps: number; frameCount: number; quality: ConversionQuality },
    durationSeconds: number,
    frameFiles?: string[],
    frameInput?:
      | {
          kind: 'image-sequence';
          frameFiles: string[];
        }
      | {
          kind: 'rawvideo';
          fileName: string;
          width: number;
          height: number;
          pixelFormat: 'rgba';
        },
    progressOffset = 0
  ): Promise<void> {
    const { fps, frameCount, quality } = settings;
    const qualitySettings = QUALITY_PRESETS.webp[quality];

    const presetArgs = FFmpegEncoder.isValidLibwebpPreset(qualitySettings.preset)
      ? (['-preset', qualitySettings.preset] as const)
      : null;

    if (!presetArgs) {
      logger.warn('ffmpeg', 'Skipping unsupported libwebp preset', {
        preset: qualitySettings.preset,
      });
    }

    // Progress ranges shifted by offset for multi-phase pipelines
    const encodeStart = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START + progressOffset;
    const encodeEnd = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_END + progressOffset;

    // Build input args — support both image-sequence and rawvideo
    let inputArgs: string[];
    let frameFormatForLog: string;

    if (frameInput?.kind === 'rawvideo') {
      const size = `${frameInput.width}x${frameInput.height}`;
      inputArgs = [
        '-f',
        'rawvideo',
        '-pixel_format',
        frameInput.pixelFormat,
        '-video_size',
        size,
        '-framerate',
        fps.toString(),
        '-i',
        frameInput.fileName,
      ];
      frameFormatForLog = `rawvideo(${frameInput.pixelFormat},${size})`;
    } else {
      // Existing image-sequence path
      const frameExtension = detectFrameExtension(frameFiles);
      const inputPattern = `frame_%06d.${frameExtension}`;
      inputArgs = ['-framerate', fps.toString(), '-i', inputPattern];
      frameFormatForLog = frameExtension;
    }

    // WebP encoding in WASM can be slow enough to hit timeouts on larger frames.
    // Use limited multithreading when cross-origin isolation is available.
    const canUseThreads = globalThis.crossOriginIsolated === true;
    const hwConcurrency = navigator.hardwareConcurrency || 2;
    const threads = canUseThreads ? Math.min(4, Math.max(2, Math.floor(hwConcurrency * 0.5))) : 1;
    const webpThreadArgs = ['-threads', threads.toString(), '-filter_threads', '1'];

    // Use concat instead of spread to prevent stack overflow
    const webpCmd = ([] as string[])
      .concat(webpThreadArgs)
      .concat(inputArgs)
      .concat(['-c:v', 'libwebp', '-lossless', '0', '-quality', qualitySettings.quality.toString()])
      .concat(presetArgs ? Array.from(presetArgs) : [])
      .concat([
        '-compression_level',
        qualitySettings.compressionLevel.toString(),
        '-method',
        qualitySettings.method.toString(),
        '-loop',
        '0',
        outputFileName,
      ]);

    logger.info('ffmpeg', 'Encoding frames directly to WebP', {
      frameCount,
      fps,
      quality: qualitySettings.quality,
      output: outputFileName,
      frameFormat: frameFormatForLog,
      durationSeconds,
      preset: qualitySettings.preset,
      compressionLevel: qualitySettings.compressionLevel,
      method: qualitySettings.method,
      threads,
      canUseThreads,
    });

    // Calculate adaptive timeout for WebP encoding (VP9/complex codec support)
    // Base: 120s, per-second: 15s, max: 360s (6 minutes)
    const webpTimeout = calculateTimeout('webp', durationSeconds * 1000);

    await this.executeFFmpegWithProgress(ffmpeg, webpCmd, {
      timeout: webpTimeout,
      timeoutMessage: `Direct WebP encoding timed out after ${webpTimeout / 1000} seconds.`,
      progressStart: encodeStart,
      progressEnd: encodeEnd,
      durationSeconds,
    });

    logger.info('ffmpeg', 'Direct WebP encoding complete');
  }

  /**
   * Convert video to GIF
   *
   * Main entry point for GIF conversion. Handles palette generation,
   * quality settings, and fallback strategies.
   */
  async convertToGIF(
    file: File,
    options: ConversionOptions,
    metadata?: VideoMetadata,
    inputOverride?: FFmpegInputOverride,
    abortSignal?: AbortSignal
  ): Promise<ConversionOutputBlob> {
    if (abortSignal) throwIfAborted(abortSignal);

    const { core, vfs, monitoring } = this.getDeps();

    try {
      const ffmpeg = core.getFFmpeg();
      const inputFileName = FFMPEG_INTERNALS.INPUT_FILE_NAME;
      const paletteFileName = FFMPEG_INTERNALS.PALETTE_FILE_NAME;
      const outputFileName = 'output.gif';

      // Ensure input file
      await vfs.ensureInputFile(ffmpeg, file);

      const quality = options.quality || 'medium';
      const scale = options.scale || 1.0;
      const fps = getOptimalFPS(metadata?.framerate || 30, quality, 'gif');

      const qualitySettings = QUALITY_PRESETS.gif[quality];
      const scaleFilter =
        scale === 1.0 ? null : `scale=iw*${scale}:ih*${scale}:flags=${SCALE_FILTERS[quality]}`;

      logger.info('ffmpeg', 'Starting GIF conversion', {
        quality,
        scale,
        fps,
        colors: qualitySettings.colors,
      });

      const conversionTimeout = getTimeoutForFormat('gif', this.getDurationMs(metadata, options));

      // Build input args
      const baseInputArgs = this.buildInputArgs(inputFileName, inputOverride);

      // Apply trim: -ss (seek) goes BEFORE -i, -t (duration) goes AFTER -i
      const inputArgs: string[] = [];
      if (options.trimStart && options.trimStart > 0) {
        inputArgs.push('-ss', options.trimStart.toFixed(3));
      }
      inputArgs.push(...baseInputArgs);
      if (options.trimEnd && options.trimEnd > 0) {
        const trimDuration = options.trimEnd - (options.trimStart ?? 0);
        if (trimDuration > 0) {
          inputArgs.push('-t', trimDuration.toFixed(3));
        }
      }

      // Generate palette — stats_mode=diff for low quality (focus palette on changed pixels)
      const statsMode = quality === 'low' ? ':stats_mode=diff' : '';
      const paletteThreadArgs = getThreadingArgs('filter-complex');
      const paletteFilterChain = scaleFilter
        ? `${scaleFilter},fps=${fps},palettegen=max_colors=${qualitySettings.colors}${statsMode}`
        : `fps=${fps},palettegen=max_colors=${qualitySettings.colors}${statsMode}`;

      // Use concat instead of spread to prevent stack overflow
      const paletteCmd = ([] as string[])
        .concat(Array.from(paletteThreadArgs))
        .concat(inputArgs)
        .concat(['-vf', paletteFilterChain, '-update', '1', paletteFileName]);

      // Log command safely without join() to prevent stack overflow
      logger.info('ffmpeg', 'Palette generation command', {
        cmdLength: paletteCmd.length,
        cmdPreview: paletteCmd.slice(0, 5),
      });

      // Palette generation is a single-pass operation with no meaningful per-frame
      // progress from FFmpeg logs. Start from PALETTE_START so the heartbeat
      // smoothly advances the progress bar during this phase.
      monitoring.updateProgress(FFMPEG_INTERNALS.PROGRESS.GIF.PALETTE_START);

      performanceTracker.startPhase('palette-gen');
      logger.performance('Starting GIF palette generation');

      try {
        // Validate command array depth to prevent stack overflow
        const maxCmdLength = 200; // Reasonable limit for command array
        if (paletteCmd.length > maxCmdLength) {
          logger.error('ffmpeg', 'Command array too large, potential stack overflow', {
            cmdLength: paletteCmd.length,
            maxAllowed: maxCmdLength,
          });
          throw new Error(
            `FFmpeg command array too large (${paletteCmd.length} elements). ` +
              'This may indicate a configuration error.'
          );
        }

        logger.info('ffmpeg', 'Executing palette generation', {
          cmdLength: paletteCmd.length,
          timeout: conversionTimeout,
        });

        await this.executeFFmpegWithProgress(ffmpeg, paletteCmd, {
          timeout: conversionTimeout,
          timeoutMessage: `GIF palette generation timed out after ${conversionTimeout / 1000} seconds.`,
          progressStart: FFMPEG_INTERNALS.PROGRESS.GIF.PALETTE_START,
          progressEnd: FFMPEG_INTERNALS.PROGRESS.GIF.PALETTE_END,
          durationSeconds: metadata?.duration ?? 10,
        });

        logger.debug('ffmpeg', 'Palette generation command finished');
      } catch (execError) {
        // Log detailed error information
        const errorMsg = execError instanceof Error ? execError.message : String(execError);
        const errorStack = execError instanceof Error ? execError.stack : undefined;

        const deps = this.getDeps();
        const wasCancelled = this.cancellationRequested || deps.shouldCancel?.() === true;
        const wasTerminated = errorMsg.includes(FFmpegEncoder.CANCELLED_TERMINATION_MESSAGE);

        // Expected: user-initiated cancellation force-terminates FFmpeg to promptly release locks.
        // Avoid logging this as an error to keep exported logs high-signal.
        if (wasCancelled && wasTerminated) {
          logger.info('ffmpeg', 'Palette generation cancelled', {
            reason: 'user-cancel',
          });
          throw new Error(CANCELLED_MESSAGE);
        }

        logger.error('ffmpeg', 'Palette generation failed', {
          error: errorMsg,
          errorType: execError instanceof Error ? execError.constructor.name : typeof execError,
          stackPreview: errorStack?.split('\n').slice(0, 3),
        });

        // Wrap FFmpeg exec errors to prevent stack overflow during error handling
        if (
          execError instanceof Error &&
          (execError.message.includes('Maximum call stack size exceeded') ||
            execError.message.includes('stack overflow'))
        ) {
          logger.error('ffmpeg', 'Stack overflow detected in FFmpeg execution', {
            command: 'palette-gen',
            cmdLength: paletteCmd.length,
            cmdPreview: paletteCmd.slice(0, 10).join(' '),
          });
          throw new Error(
            'FFmpeg palette generation failed: stack overflow in execution. ' +
              'Try restarting the browser or using a simpler video file.'
          );
        }
        throw execError;
      }

      performanceTracker.endPhase('palette-gen');
      logger.performance('GIF palette generation complete');
      // Conversion starts at CONVERSION_START — heartbeat already advances
      // from the palette phase, so no explicit jump needed here.

      // Validate palette output before starting the main GIF encode.
      // This avoids confusing secondary errors like "palette.png: No such file or directory".
      try {
        const paletteBytes = await vfs.readFile(ffmpeg, paletteFileName);
        if (paletteBytes.byteLength === 0) {
          throw new Error('Palette file is 0 bytes');
        }
      } catch (paletteError) {
        logger.error('ffmpeg', 'Palette generation did not produce a readable palette file', {
          paletteFile: paletteFileName,
          codec: metadata?.codec,
          error: getErrorMessage(paletteError),
        });

        throw new Error(
          `GIF palette generation failed: ${paletteFileName} was not created. ` +
            'This may indicate an unsupported codec or a decode failure. ' +
            `Input codec: ${metadata?.codec ?? 'unknown'}.`
        );
      }

      if (this.cancellationRequested) {
        throw new Error(CANCELLED_MESSAGE);
      }

      // Convert to GIF using palette
      const conversionThreadArgs = getThreadingArgs('filter-complex');
      const ditherMode = quality === 'high' ? 'sierra2' : 'bayer';
      const bayerScale = quality === 'low' ? 3 : 2;
      const ditherConfig =
        ditherMode === 'bayer'
          ? `dither=${ditherMode}:bayer_scale=${bayerScale}:diff_mode=rectangle`
          : `dither=${ditherMode}:diff_mode=rectangle`;
      const gifFilterChain = scaleFilter
        ? `${scaleFilter},fps=${fps}[v];[v][1:v]paletteuse=${ditherConfig}`
        : `fps=${fps}[v];[v][1:v]paletteuse=${ditherConfig}`;

      // Use concat instead of spread to prevent stack overflow
      const gifCmd = ([] as string[])
        .concat(Array.from(conversionThreadArgs))
        .concat(inputArgs)
        .concat(['-i', paletteFileName, '-lavfi', gifFilterChain])
        .concat(Array.from(PROGRESS_LOGGING_ARGS))
        .concat([outputFileName]);

      // Log command safely without join() to prevent stack overflow
      logger.debug('ffmpeg', 'GIF conversion command', {
        cmdLength: gifCmd.length,
        cmdPreview: gifCmd.slice(0, 5),
      });

      logger.performance('Starting GIF encoding');

      try {
        await this.executeFFmpegWithProgress(ffmpeg, gifCmd, {
          timeout: conversionTimeout,
          timeoutMessage: `GIF conversion timed out after ${conversionTimeout / 1000} seconds.`,
          progressStart: FFMPEG_INTERNALS.PROGRESS.GIF.CONVERSION_START,
          progressEnd: FFMPEG_INTERNALS.PROGRESS.GIF.CONVERSION_END,
          durationSeconds: metadata?.duration ?? 10,
        });
      } catch (execError) {
        // Wrap FFmpeg exec errors to prevent stack overflow during error handling
        if (
          execError instanceof Error &&
          execError.message === 'Maximum call stack size exceeded'
        ) {
          logger.error('ffmpeg', 'Stack overflow detected in FFmpeg execution', {
            command: 'gif-encode',
            cmdLength: gifCmd.length,
          });
          throw new Error('FFmpeg GIF encoding failed: stack overflow in execution');
        }
        throw execError;
      }

      // Read + validate output, clean up VFS, create blob
      const blob = await this.readOutputAndCleanup(ffmpeg, outputFileName, 'gif', [
        inputFileName,
        paletteFileName,
      ]);

      logger.performance('GIF encoding complete');

      monitoring.updateProgress(FFMPEG_INTERNALS.PROGRESS.GIF.COMPLETE);
      logger.info('ffmpeg', 'GIF conversion completed successfully', {
        outputSize: blob.size,
      });

      // Cleanup remaining VFS temp files (AV1 transcode intermediates, etc.)
      await vfs.handleConversionCleanup(ffmpeg, outputFileName, [], isMemoryCritical);

      return blob;
    } catch (error) {
      throw this.enrichConversionError({
        error,
        format: 'gif',
        options,
        metadata,
      });
    }
  }

  /**
   * Convert video to WebP
   *
   * Main entry point for WebP conversion. Handles quality settings,
   * scaling, and fallback strategies.
   */
  async convertToWebP(
    file: File,
    options: ConversionOptions,
    metadata?: VideoMetadata,
    inputOverride?: FFmpegInputOverride,
    abortSignal?: AbortSignal
  ): Promise<ConversionOutputBlob> {
    if (abortSignal) throwIfAborted(abortSignal);

    const { core, vfs, monitoring } = this.getDeps();

    try {
      const ffmpeg = core.getFFmpeg();
      const inputFileName = FFMPEG_INTERNALS.INPUT_FILE_NAME;
      const outputFileName = 'output.webp';

      // Ensure input file
      await vfs.ensureInputFile(ffmpeg, file);

      const quality = options.quality || 'medium';
      const scale = options.scale || 1.0;
      const fps = getOptimalFPS(metadata?.framerate || 30, quality, 'webp');

      const qualitySettings = QUALITY_PRESETS.webp[quality];
      const scaleFilter =
        scale === 1.0 ? null : `scale=iw*${scale}:ih*${scale}:flags=${SCALE_FILTERS[quality]}`;

      const presetArgs = FFmpegEncoder.isValidLibwebpPreset(qualitySettings.preset)
        ? (['-preset', qualitySettings.preset] as const)
        : null;

      if (!presetArgs) {
        logger.warn('ffmpeg', 'Skipping unsupported libwebp preset', {
          preset: qualitySettings.preset,
        });
      }

      logger.info('ffmpeg', 'Starting WebP conversion', {
        quality,
        scale,
        fps,
      });

      const conversionTimeout = getTimeoutForFormat('webp', this.getDurationMs(metadata, options));

      // Build input args
      const baseInputArgs = this.buildInputArgs(inputFileName, inputOverride);

      // Apply trim: -ss (seek) goes BEFORE -i, -t (duration) goes AFTER -i
      const inputArgs: string[] = [];
      if (options.trimStart && options.trimStart > 0) {
        inputArgs.push('-ss', options.trimStart.toFixed(3));
      }
      inputArgs.push(...baseInputArgs);
      if (options.trimEnd && options.trimEnd > 0) {
        const trimDuration = options.trimEnd - (options.trimStart ?? 0);
        if (trimDuration > 0) {
          inputArgs.push('-t', trimDuration.toFixed(3));
        }
      }

      if (this.cancellationRequested) {
        throw new Error(CANCELLED_MESSAGE);
      }

      // Try main conversion
      try {
        const isH264Input = inputOverride?.format === 'h264';
        const webpThreadArgs = getThreadingArgs(
          scaleFilter || isH264Input ? 'scale-filter' : 'simple'
        );

        const webpFilterArgs = scaleFilter ? `${scaleFilter},fps=${fps}` : `fps=${fps}`;

        // Use concat instead of spread to prevent stack overflow
        const webpCmd = ([] as string[])
          .concat(Array.from(webpThreadArgs))
          .concat(inputArgs)
          .concat([
            '-vf',
            webpFilterArgs,
            '-c:v',
            'libwebp',
            '-lossless',
            '0',
            '-quality',
            qualitySettings.quality.toString(),
          ])
          .concat(presetArgs ? Array.from(presetArgs) : [])
          .concat([
            '-compression_level',
            qualitySettings.compressionLevel.toString(),
            '-method',
            qualitySettings.method.toString(),
            '-loop',
            '0',
          ])
          .concat(Array.from(PROGRESS_LOGGING_ARGS))
          .concat([outputFileName]);

        // Log command safely without join() to prevent stack overflow
        logger.info('ffmpeg', 'WebP conversion command', {
          cmdLength: webpCmd.length,
          cmdPreview: webpCmd.slice(0, 5),
        });

        performanceTracker.startPhase('webp-encode');
        logger.performance('Starting WebP encoding');

        try {
          // Validate command array depth to prevent stack overflow
          const maxCmdLength = 200; // Reasonable limit for command array
          if (webpCmd.length > maxCmdLength) {
            logger.error('ffmpeg', 'Command array too large, potential stack overflow', {
              cmdLength: webpCmd.length,
              maxAllowed: maxCmdLength,
            });
            throw new Error(
              `FFmpeg command array too large (${webpCmd.length} elements). ` +
                'This may indicate a configuration error.'
            );
          }

          logger.info('ffmpeg', 'Executing WebP conversion', {
            cmdLength: webpCmd.length,
            timeout: conversionTimeout,
          });

          await this.executeFFmpegWithProgress(ffmpeg, webpCmd, {
            timeout: conversionTimeout,
            timeoutMessage: `WebP conversion timed out after ${conversionTimeout / 1000} seconds.`,
            progressStart: FFMPEG_INTERNALS.PROGRESS.WEBP.CONVERSION_START,
            progressEnd: FFMPEG_INTERNALS.PROGRESS.WEBP.CONVERSION_END,
            durationSeconds: metadata?.duration ?? 30,
          });

          logger.debug('ffmpeg', 'WebP conversion completed successfully');
        } catch (execError) {
          // Log detailed error information
          const errorMsg = execError instanceof Error ? execError.message : String(execError);
          const errorStack = execError instanceof Error ? execError.stack : undefined;

          logger.error('ffmpeg', 'WebP conversion failed', {
            error: errorMsg,
            errorType: execError instanceof Error ? execError.constructor.name : typeof execError,
            stackPreview: errorStack?.split('\n').slice(0, 3),
          });

          // Wrap FFmpeg exec errors to prevent stack overflow during error handling
          if (
            execError instanceof Error &&
            (execError.message.includes('Maximum call stack size exceeded') ||
              execError.message.includes('stack overflow'))
          ) {
            logger.error('ffmpeg', 'Stack overflow detected in FFmpeg execution', {
              command: 'webp-encode',
              cmdLength: webpCmd.length,
              cmdPreview: webpCmd.slice(0, 10),
            });
            throw new Error(
              'FFmpeg WebP encoding failed: stack overflow in execution. ' +
                'Try restarting the browser or using a simpler video file.'
            );
          }
          throw execError;
        }

        performanceTracker.endPhase('webp-encode');
        logger.performance('WebP encoding complete');
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        const wasCancelled = this.isCancellationError(errorMessage);

        if (!wasCancelled) {
          logger.warn('ffmpeg', 'WebP conversion failed, will attempt cleanup');
        } else {
          logger.debug('ffmpeg', 'WebP conversion cancelled by user');
        }
        throw error;
      }

      // Read + validate output, clean up VFS, create blob
      const blob = await this.readOutputAndCleanup(ffmpeg, outputFileName, 'webp', [inputFileName]);

      monitoring.updateProgress(FFMPEG_INTERNALS.PROGRESS.WEBP.COMPLETE);
      logger.info('ffmpeg', 'WebP conversion completed successfully', {
        outputSize: blob.size,
      });

      // Cleanup remaining VFS temp files
      await vfs.handleConversionCleanup(ffmpeg, outputFileName, [], isMemoryCritical);

      return blob;
    } catch (error) {
      throw this.enrichConversionError({
        error,
        format: 'webp',
        options,
        metadata,
      });
    }
  }

  /**
   * Cancel ongoing conversion
   */
  cancelConversion(): void {
    const { monitoring } = this.getDeps();
    if (!monitoring.isActive()) {
      return;
    }
    this.cancellationRequested = true;
    this.updateStatus('Cancelling conversion...');
    // Cancellation is handled via flag; monitoring stops when conversion ends
  }

  /**
   * Check if cancellation was requested
   */
  isCancellationRequested(): boolean {
    return this.cancellationRequested;
  }

  /**
   * Reset cancellation state.
   *
   * External conversions (e.g., WebCodecs decode/encode) can request cancellation via the
   * shared FFmpeg monitoring pipeline. When a new conversion starts, we must clear the
   * previous cancellation flag so subsequent operations can proceed.
   */
  resetCancellation(): void {
    this.cancellationRequested = false;
  }
}

const PROGRESS_LOGGING_ARGS = ['-progress', '-', '-loglevel', 'info'] as const;

const SCALE_FILTERS: Record<ConversionQuality, string> = {
  high: 'lanczos',
  medium: 'bicubic',
  low: 'bilinear',
};
