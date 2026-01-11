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
import type {
  ConversionOptions,
  ConversionOutputBlob,
  ConversionQuality,
  VideoMetadata,
} from '@t/conversion-types';
import { classifyConversionError } from '@utils/classify-conversion-error';
import { QUALITY_PRESETS, TIMEOUT_CONVERSION } from '@utils/constants';
import { getErrorMessage } from '@utils/error-utils';
import { FFMPEG_INTERNALS } from '@utils/ffmpeg-constants';
import { logger } from '@utils/logger';
import { isMemoryCritical } from '@utils/memory-monitor';
import { performanceTracker } from '@utils/performance-tracker';
import { getOptimalFPS } from '@utils/quality-optimizer';
import { getTimeoutForFormat } from '@utils/timeout-calculator';
import { withTimeout } from '@utils/with-timeout';
import { getProgressLoggingArgs } from '../ffmpeg/args';
import { getScaleFilter } from '../ffmpeg/filters';
import { getThreadingArgs } from '../ffmpeg/threading';
import type { FFmpegCore } from './ffmpeg-core';
import type { FFmpegMonitoring } from './ffmpeg-monitoring';
import type { FFmpegVFS } from './ffmpeg-vfs';

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
  private cancellationRequested = false;
  private dependencies: EncoderDependencies | null = null;

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
   * Acquire conversion lock to prevent concurrent conversions
   */
  private acquireConversionLock(): boolean {
    if (this.conversionLock) {
      logger.warn('conversion', 'Conversion already in progress, rejecting concurrent request', {
        locked: this.conversionLock,
      });
      return false;
    }
    this.conversionLock = true;
    logger.debug('conversion', 'Conversion lock acquired');
    return true;
  }

  /**
   * Release conversion lock
   */
  private releaseConversionLock(): void {
    this.conversionLock = false;
    logger.debug('conversion', 'Conversion lock released');
  }

  /**
   * Create FFmpeg log handler for conversion operations
   */
  private createFFmpegLogHandler(
    totalDuration?: number,
    progressStart?: number,
    progressEnd?: number
  ): (event: { type: string; message: string }) => void {
    const { core, monitoring } = this.getDeps();

    return ({ type, message }: { type: string; message: string }) => {
      monitoring.updateLogActivity();
      logger.debug('ffmpeg', `[${type}] ${message}`);
      core.addLogEntry(type, message);

      if (type === 'fferr' || message.includes('Error') || message.includes('failed')) {
        logger.warn('ffmpeg', `FFmpeg warning/error: ${message}`);
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

    // Parse progress-format output: "out_time_ms=1234"
    const outTimeMsMatch = message.match(/out_time_ms=(\d+)/);
    if (outTimeMsMatch) {
      const currentTime = Number.parseInt(outTimeMsMatch[1] ?? '0', 10) / 1000;
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
      logger.debug('conversion', 'Using input format override', {
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
   */
  private enrichConversionError(params: {
    error: unknown;
    format: 'gif' | 'webp';
    options: ConversionOptions;
    metadata?: VideoMetadata;
  }): Error {
    const { error, format, options, metadata } = params;
    const { core } = this.getDeps();
    const message = getErrorMessage(error);

    const context = classifyConversionError(
      message,
      metadata ?? null,
      { format, quality: options.quality, scale: options.scale },
      core.getRecentLogs()
    );

    if (error instanceof Error) {
      (error as unknown as { errorContext?: unknown }).errorContext ??= context;
      return error;
    }

    const enriched = new Error(message);
    (enriched as unknown as { errorContext?: unknown }).errorContext = context;
    return enriched;
  }

  /**
   * Encode frame sequence to GIF or WebP
   *
   * Encodes pre-extracted frames from WebCodecs to final format.
   * Used by hybrid GPU decode + FFmpeg encode path.
   *
   * @param params - Encoding parameters
   * @returns Converted video blob
   */
  async encodeFrameSequence(params: {
    format: 'gif' | 'webp';
    options: ConversionOptions;
    frameCount: number;
    fps: number;
    durationSeconds: number;
    frameTimestamps?: number[];
  }): Promise<ConversionOutputBlob> {
    const { format, options, frameCount, fps, durationSeconds } = params;
    const { core, vfs } = this.getDeps();

    if (!this.acquireConversionLock()) {
      throw new Error('Another conversion is already in progress');
    }

    try {
      const ffmpeg = core.getFFmpeg();
      const outputFileName = format === 'gif' ? 'output.gif' : 'output.webp';

      // Validate frame sequence exists
      await this.validateFrameSequence(frameCount, format);

      if (format === 'gif') {
        await this.encodeFramesToGIFWithPalette(
          ffmpeg,
          outputFileName,
          { fps, frameCount, quality: options.quality },
          durationSeconds
        );
      } else {
        await this.encodeFramesToWebP(
          ffmpeg,
          outputFileName,
          { fps, frameCount, quality: options.quality },
          durationSeconds
        );
      }

      // Validate output
      const validation = await vfs.validateOutputFile(ffmpeg, outputFileName, format);
      if (!validation.valid) {
        throw new Error(
          `Output validation failed: ${validation.reason || 'Unknown validation error'}`
        );
      }

      // Read output
      const outputData = await vfs.readFile(ffmpeg, outputFileName);
      const blob = new Blob([new Uint8Array(outputData)], {
        type: format === 'gif' ? 'image/gif' : 'image/webp',
      }) as ConversionOutputBlob;

      // Cleanup
      const frameFiles: string[] = [];
      for (let i = 0; i < frameCount; i++) {
        frameFiles.push(`frame${i.toString().padStart(5, '0')}.png`);
      }
      await vfs.handleConversionCleanup(
        ffmpeg,
        outputFileName,
        [...frameFiles, FFMPEG_INTERNALS.PALETTE_FILE_NAME],
        isMemoryCritical
      );

      return blob;
    } catch (error) {
      throw this.enrichConversionError({
        error,
        format,
        options,
      });
    } finally {
      this.releaseConversionLock();
    }
  }

  /**
   * Validate frame sequence
   */
  private async validateFrameSequence(frameCount: number, format: 'gif' | 'webp'): Promise<void> {
    logger.debug('conversion', 'Validating frame sequence', {
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
    durationSeconds: number
  ): Promise<void> {
    const { monitoring } = this.getDeps();

    const paletteFileName = FFMPEG_INTERNALS.PALETTE_FILE_NAME;
    const { fps, frameCount, quality } = settings;

    const qualitySettings = QUALITY_PRESETS.gif[quality];
    const encodeStart = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START;
    const paletteEnd = 70;
    const encodeEnd = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_END;

    logger.info('conversion', 'Generating GIF palette from frame sequence', {
      frameCount,
      fps,
      colors: qualitySettings.colors,
    });

    // Generate palette
    const paletteThreadArgs = getThreadingArgs('filter-complex');
    const inputPattern = 'frame%05d.png';
    const paletteCmd = [
      ...paletteThreadArgs,
      '-framerate',
      fps.toString(),
      '-i',
      inputPattern,
      '-vf',
      `palettegen=max_colors=${qualitySettings.colors}`,
      '-update',
      '1',
      paletteFileName,
    ];

    const paletteLogHandler = this.createFFmpegLogHandler(durationSeconds, encodeStart, paletteEnd);
    ffmpeg.on('log', paletteLogHandler);

    const paletteHeartbeat = monitoring.startProgressHeartbeat(
      encodeStart,
      paletteEnd,
      Math.max(15, Math.min(durationSeconds, 45))
    );

    try {
      await withTimeout(
        ffmpeg.exec(paletteCmd),
        TIMEOUT_CONVERSION,
        `WebCodecs GIF palette generation timed out after ${TIMEOUT_CONVERSION / 1000} seconds.`,
        () => this.getDeps().onStatusUpdate?.('Terminating FFmpeg...')
      );
    } finally {
      ffmpeg.off('log', paletteLogHandler);
      monitoring.stopProgressHeartbeat(paletteHeartbeat);
    }

    // Convert frames to GIF using palette
    const conversionThreadArgs = getThreadingArgs('filter-complex');
    const ditherMode = quality === 'high' ? 'sierra2_4a' : 'bayer';
    const conversionCmd = [
      ...conversionThreadArgs,
      '-framerate',
      fps.toString(),
      '-i',
      inputPattern,
      '-i',
      paletteFileName,
      '-filter_complex',
      `paletteuse=dither=${ditherMode}`,
      outputFileName,
    ];

    const conversionLogHandler = this.createFFmpegLogHandler(
      durationSeconds,
      paletteEnd,
      encodeEnd
    );
    ffmpeg.on('log', conversionLogHandler);

    const conversionHeartbeat = monitoring.startProgressHeartbeat(
      paletteEnd,
      encodeEnd,
      Math.max(20, Math.min(durationSeconds * 1.2, 60))
    );

    try {
      await withTimeout(
        ffmpeg.exec(conversionCmd),
        TIMEOUT_CONVERSION,
        `WebCodecs GIF conversion timed out after ${TIMEOUT_CONVERSION / 1000} seconds.`,
        () => this.getDeps().onStatusUpdate?.('Terminating FFmpeg...')
      );
    } finally {
      ffmpeg.off('log', conversionLogHandler);
      monitoring.stopProgressHeartbeat(conversionHeartbeat);
    }
  }

  /**
   * Encode frames to WebP
   */
  private async encodeFramesToWebP(
    ffmpeg: FFmpeg,
    outputFileName: string,
    settings: { fps: number; frameCount: number; quality: ConversionQuality },
    durationSeconds: number
  ): Promise<void> {
    const { monitoring } = this.getDeps();

    const { fps, frameCount, quality } = settings;
    const qualitySettings = QUALITY_PRESETS.webp[quality];

    const encodeStart = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START;
    const encodeEnd = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_END;

    const inputPattern = 'frame%05d.png';
    const webpThreadArgs = getThreadingArgs('simple');

    const webpCmd = [
      ...webpThreadArgs,
      '-framerate',
      fps.toString(),
      '-i',
      inputPattern,
      '-c:v',
      'libwebp',
      '-lossless',
      '0',
      '-quality',
      qualitySettings.quality.toString(),
      '-preset',
      qualitySettings.preset,
      '-compression_level',
      qualitySettings.compressionLevel.toString(),
      '-method',
      qualitySettings.method.toString(),
      '-loop',
      '0',
      outputFileName,
    ];

    logger.info('conversion', 'Encoding PNG frames directly to WebP', {
      frameCount,
      fps,
      quality: qualitySettings.quality,
      output: outputFileName,
    });

    const webpLogHandler = this.createFFmpegLogHandler(durationSeconds, encodeStart, encodeEnd);
    ffmpeg.on('log', webpLogHandler);

    const webpHeartbeat = monitoring.startProgressHeartbeat(
      encodeStart,
      encodeEnd,
      Math.max(15, Math.min(durationSeconds, 45))
    );

    try {
      await withTimeout(
        ffmpeg.exec(webpCmd),
        TIMEOUT_CONVERSION,
        `Direct WebP encoding timed out after ${TIMEOUT_CONVERSION / 1000} seconds.`,
        () => this.getDeps().onStatusUpdate?.('Terminating FFmpeg...')
      );
    } finally {
      ffmpeg.off('log', webpLogHandler);
      monitoring.stopProgressHeartbeat(webpHeartbeat);
    }

    logger.info('conversion', 'Direct WebP encoding complete');
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
    inputOverride?: FFmpegInputOverride
  ): Promise<ConversionOutputBlob> {
    const { core, vfs, monitoring } = this.getDeps();

    if (!this.acquireConversionLock()) {
      throw new Error('Another conversion is already in progress');
    }

    performanceTracker.startPhase('conversion');

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
      const scaleFilter = getScaleFilter(quality, scale);

      logger.info('conversion', 'Starting GIF conversion', {
        quality,
        scale,
        fps,
        colors: qualitySettings.colors,
      });

      const conversionTimeout = getTimeoutForFormat('gif');

      monitoring.updateProgress(FFMPEG_INTERNALS.PROGRESS.GIF.PALETTE_START);

      // Build input args
      const inputArgs = this.buildInputArgs(inputFileName, inputOverride);

      // Generate palette
      const paletteThreadArgs = getThreadingArgs('filter-complex');
      const paletteFilterChain = scaleFilter
        ? `${scaleFilter},fps=${fps},palettegen=max_colors=${qualitySettings.colors}`
        : `fps=${fps},palettegen=max_colors=${qualitySettings.colors}`;

      const paletteCmd = [
        ...paletteThreadArgs,
        ...inputArgs,
        '-vf',
        paletteFilterChain,
        '-update',
        '1',
        paletteFileName,
      ];

      logger.debug('ffmpeg', 'Palette generation command', { cmd: paletteCmd.join(' ') });

      const paletteHeartbeat = monitoring.startProgressHeartbeat(
        FFMPEG_INTERNALS.PROGRESS.GIF.PALETTE_START,
        FFMPEG_INTERNALS.PROGRESS.GIF.PALETTE_END,
        30
      );

      performanceTracker.startPhase('palette-gen');
      logger.performance('Starting GIF palette generation');

      try {
        try {
          await withTimeout(
            ffmpeg.exec(paletteCmd),
            conversionTimeout,
            `GIF palette generation timed out after ${conversionTimeout / 1000} seconds.`,
            () => this.getDeps().onStatusUpdate?.('Terminating FFmpeg...')
          );
        } catch (execError) {
          // Wrap FFmpeg exec errors to prevent stack overflow during error handling
          if (
            execError instanceof Error &&
            execError.message === 'Maximum call stack size exceeded'
          ) {
            logger.error('ffmpeg', 'Stack overflow detected in FFmpeg execution', {
              command: 'palette-gen',
              cmdLength: paletteCmd.length,
            });
            throw new Error('FFmpeg palette generation failed: stack overflow in execution');
          }
          throw execError;
        }
      } finally {
        monitoring.stopProgressHeartbeat(paletteHeartbeat);
      }

      performanceTracker.endPhase('palette-gen');
      logger.performance('GIF palette generation complete');
      monitoring.updateProgress(FFMPEG_INTERNALS.PROGRESS.GIF.CONVERSION_START);

      if (this.cancellationRequested) {
        throw new Error('Conversion cancelled by user');
      }

      // Convert to GIF using palette
      const conversionThreadArgs = getThreadingArgs('filter-complex');
      const ditherMode = quality === 'high' ? 'sierra2_4a' : 'bayer';
      const gifFilterChain = scaleFilter
        ? `${scaleFilter},fps=${fps}[v];[v][1:v]paletteuse=dither=${ditherMode}`
        : `fps=${fps}[v];[v][1:v]paletteuse=dither=${ditherMode}`;

      const gifCmd = [
        ...conversionThreadArgs,
        ...inputArgs,
        '-i',
        paletteFileName,
        '-lavfi',
        gifFilterChain,
        ...getProgressLoggingArgs(),
        outputFileName,
      ];

      logger.debug('ffmpeg', 'GIF conversion command', { cmd: gifCmd.join(' ') });

      logger.performance('Starting GIF encoding');

      try {
        try {
          await withTimeout(
            ffmpeg.exec(gifCmd),
            conversionTimeout,
            `GIF conversion timed out after ${conversionTimeout / 1000} seconds.`,
            () => this.getDeps().onStatusUpdate?.('Terminating FFmpeg...')
          );
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
          logger.warn('conversion', 'GIF conversion failed, will attempt cleanup');
          throw execError;
        }
      } catch (error) {
        logger.warn('conversion', 'GIF conversion failed, will attempt cleanup');
        throw error;
      }

      logger.performance('GIF encoding complete');

      // Validate output
      const validation = await vfs.validateOutputFile(ffmpeg, outputFileName, 'gif');
      if (!validation.valid) {
        throw new Error(
          `GIF output validation failed: ${validation.reason || 'Unknown validation error'}`
        );
      }

      // Read output
      const outputData = await vfs.readFile(ffmpeg, outputFileName);
      const blob = new Blob([new Uint8Array(outputData)], {
        type: 'image/gif',
      }) as ConversionOutputBlob;

      monitoring.updateProgress(FFMPEG_INTERNALS.PROGRESS.GIF.COMPLETE);
      logger.info('conversion', 'GIF conversion completed successfully', {
        outputSize: blob.size,
      });

      // Cleanup
      await vfs.handleConversionCleanup(
        ffmpeg,
        outputFileName,
        [paletteFileName],
        isMemoryCritical
      );

      return blob;
    } catch (error) {
      throw this.enrichConversionError({
        error,
        format: 'gif',
        options,
        metadata,
      });
    } finally {
      this.releaseConversionLock();
      performanceTracker.endPhase('conversion');
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
    inputOverride?: FFmpegInputOverride
  ): Promise<ConversionOutputBlob> {
    const { core, vfs, monitoring } = this.getDeps();

    if (!this.acquireConversionLock()) {
      throw new Error('Another conversion is already in progress');
    }

    performanceTracker.startPhase('conversion');

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
      const scaleFilter = getScaleFilter(quality, scale);

      logger.info('conversion', 'Starting WebP conversion', {
        quality,
        scale,
        fps,
      });

      const conversionTimeout = getTimeoutForFormat('webp');

      monitoring.updateProgress(FFMPEG_INTERNALS.PROGRESS.WEBP.CONVERSION_START);

      // Build input args
      const inputArgs = this.buildInputArgs(inputFileName, inputOverride);

      if (this.cancellationRequested) {
        throw new Error('Conversion cancelled by user');
      }

      // Try main conversion
      try {
        const estimatedDuration = 30;
        const heartbeat = monitoring.startProgressHeartbeat(
          FFMPEG_INTERNALS.PROGRESS.WEBP.CONVERSION_START,
          FFMPEG_INTERNALS.PROGRESS.WEBP.CONVERSION_END,
          estimatedDuration
        );

        const isH264Input = inputOverride?.format === 'h264';
        const webpThreadArgs = getThreadingArgs(
          scaleFilter || isH264Input ? 'scale-filter' : 'simple'
        );

        const webpFilterArgs = scaleFilter ? `${scaleFilter},fps=${fps}` : `fps=${fps}`;

        const webpCmd = [
          ...webpThreadArgs,
          ...inputArgs,
          '-vf',
          webpFilterArgs,
          '-c:v',
          'libwebp',
          '-lossless',
          '0',
          '-quality',
          qualitySettings.quality.toString(),
          '-preset',
          qualitySettings.preset,
          '-compression_level',
          qualitySettings.compressionLevel.toString(),
          '-method',
          qualitySettings.method.toString(),
          '-loop',
          '0',
          ...getProgressLoggingArgs(),
          outputFileName,
        ];

        logger.debug('ffmpeg', 'WebP conversion command', { cmd: webpCmd.join(' ') });

        performanceTracker.startPhase('webp-encode');
        logger.performance('Starting WebP encoding');

        try {
          try {
            await withTimeout(
              ffmpeg.exec(webpCmd),
              conversionTimeout,
              `WebP conversion timed out after ${conversionTimeout / 1000} seconds.`,
              () => this.getDeps().onStatusUpdate?.('Terminating FFmpeg...')
            );
          } catch (execError) {
            // Wrap FFmpeg exec errors to prevent stack overflow during error handling
            if (
              execError instanceof Error &&
              execError.message === 'Maximum call stack size exceeded'
            ) {
              logger.error('ffmpeg', 'Stack overflow detected in FFmpeg execution', {
                command: 'webp-encode',
                cmdLength: webpCmd.length,
              });
              throw new Error('FFmpeg WebP encoding failed: stack overflow in execution');
            }
            throw execError;
          }
        } finally {
          monitoring.stopProgressHeartbeat(heartbeat);
        }

        performanceTracker.endPhase('webp-encode');
        logger.performance('WebP encoding complete');
      } catch (error) {
        logger.warn('conversion', 'WebP conversion failed, will attempt cleanup');
        throw error;
      }

      // Validate output
      const validation = await vfs.validateOutputFile(ffmpeg, outputFileName, 'webp');
      if (!validation.valid) {
        throw new Error(
          `WebP output validation failed: ${validation.reason || 'Unknown validation error'}`
        );
      }

      // Read output
      const outputData = await vfs.readFile(ffmpeg, outputFileName);
      const blob = new Blob([new Uint8Array(outputData)], {
        type: 'image/webp',
      }) as ConversionOutputBlob;

      monitoring.updateProgress(FFMPEG_INTERNALS.PROGRESS.WEBP.COMPLETE);
      logger.info('conversion', 'WebP conversion completed successfully', {
        outputSize: blob.size,
      });

      // Cleanup
      await vfs.handleConversionCleanup(ffmpeg, outputFileName, [], isMemoryCritical);

      return blob;
    } catch (error) {
      throw this.enrichConversionError({
        error,
        format: 'webp',
        options,
        metadata,
      });
    } finally {
      this.releaseConversionLock();
      performanceTracker.endPhase('conversion');
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
}

/**
 * Create FFmpeg encoder instance
 *
 * @returns New FFmpegEncoder instance
 */
export function createFFmpegEncoder(): FFmpegEncoder {
  return new FFmpegEncoder();
}
