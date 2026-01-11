/**
 * Conversion Orchestrator
 *
 * Main entry point for video conversion. Replaces conversion-service.ts.
 * Coordinates path selection, strategy resolution, and execution across
 * GPU (WebCodecs) and CPU (FFmpeg) paths.
 *
 * Architecture:
 * 1. Select conversion path (GPU vs CPU vs hybrid)
 * 2. Resolve conversion strategy (FPS, scale, workers)
 * 3. Execute via appropriate path
 * 4. Return result with metadata
 */

import type { ConversionFormat, VideoMetadata } from '@t/conversion-types';
import { classifyConversionError } from '@utils/classify-conversion-error';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { getEncoderForFormat } from '../encoders/encoder-factory';
import { ffmpegService } from '../ffmpeg-service'; // Legacy service (will be replaced in Phase 4)
import { ProgressReporter } from '../shared/progress-reporter';
import type {
  ConversionMetadata,
  ConversionRequest,
  ConversionResponse,
  ConversionStatus,
  PathSelection,
} from './types';

/**
 * Conversion orchestrator class
 *
 * Stateful orchestrator that manages a single conversion operation.
 */
export class ConversionOrchestrator {
  private status: ConversionStatus = {
    isConverting: false,
    progress: 0,
    statusMessage: '',
  };

  private progressReporter: ProgressReporter | null = null;

  /**
   * Convert video using optimal path
   *
   * Main conversion function. Analyzes input, selects path, executes conversion.
   *
   * @param request - Conversion request
   * @returns Promise resolving to conversion response
   * @throws Error if conversion fails
   */
  async convertVideo(request: ConversionRequest): Promise<ConversionResponse> {
    const startTime = Date.now();

    try {
      // Update status
      this.status = {
        isConverting: true,
        progress: 0,
        statusMessage: 'Initializing conversion...',
        phase: 'initializing',
      };

      // Create progress reporter
      this.progressReporter = new ProgressReporter({
        onProgress: (progress) => {
          this.status.progress = progress;
          request.onProgress?.(progress);
        },
        onStatus: (message) => {
          this.status.statusMessage = message;
          request.onStatus?.(message);
        },
      });

      // Define phases
      this.progressReporter.definePhases([
        { name: 'initialization', weight: 1 },
        { name: 'analysis', weight: 1 },
        { name: 'conversion', weight: 18 }, // Main work
      ]);

      // Phase 1: Initialization
      this.progressReporter.startPhase('initialization', 'Initializing...');
      await this.ensureFFmpegInitialized();
      this.progressReporter.report(1.0);

      // Phase 2: Analysis
      this.progressReporter.startPhase('analysis', 'Analyzing video...');
      const metadata = await this.resolveMetadata(request.file, request.metadata);
      const pathSelection = await this.selectPath(request.file, request.format, metadata);
      this.progressReporter.report(1.0);

      logger.info('conversion', 'Starting conversion', {
        file: request.file.name,
        format: request.format,
        path: pathSelection.path,
        reason: pathSelection.reason,
        codec: metadata?.codec,
      });

      // Phase 3: Conversion
      this.progressReporter.startPhase('conversion', 'Converting...');

      const conversionMetadata: ConversionMetadata = {
        path: pathSelection.path,
        encoder: 'unknown',
        conversionTimeMs: 0,
        wasTranscoded: false,
        originalCodec: metadata?.codec,
      };

      let blob: Blob;

      // Execute based on selected path
      switch (pathSelection.path) {
        case 'gpu':
          blob = await this.convertViaGPUPath(request, metadata, conversionMetadata);
          break;

        case 'hybrid':
          blob = await this.convertViaHybridPath(request, metadata, conversionMetadata);
          break;

        default:
          blob = await this.convertViaCPUPath(request, metadata, conversionMetadata);
          break;
      }

      // Update final metadata
      conversionMetadata.conversionTimeMs = Date.now() - startTime;

      this.progressReporter.complete('Conversion complete');

      this.status = {
        isConverting: false,
        progress: 100,
        statusMessage: 'Complete',
      };

      logger.info('conversion', 'Conversion completed successfully', {
        file: request.file.name,
        format: request.format,
        path: conversionMetadata.path,
        encoder: conversionMetadata.encoder,
        durationMs: conversionMetadata.conversionTimeMs,
      });

      return {
        blob,
        metadata: conversionMetadata,
      };
    } catch (error) {
      this.status = {
        isConverting: false,
        progress: 0,
        statusMessage: 'Error',
      };

      const errorMessage = getErrorMessage(error);
      const errorContext = classifyConversionError(errorMessage, null);

      logger.error('conversion', 'Conversion failed', {
        file: request.file.name,
        format: request.format,
        error: errorMessage,
        errorType: errorContext.type,
      });

      throw error;
    } finally {
      this.progressReporter = null;
    }
  }

  /**
   * Get current conversion status
   */
  getStatus(): ConversionStatus {
    return { ...this.status };
  }

  /**
   * Cancel current conversion
   */
  cancel(): void {
    // TODO: Implement cancellation mechanism
    logger.info('conversion', 'Conversion cancelled by user');
  }

  /**
   * Ensure FFmpeg is initialized
   */
  private async ensureFFmpegInitialized(): Promise<void> {
    if (!ffmpegService.isLoaded()) {
      await ffmpegService.initialize();
    }
  }

  /**
   * Resolve video metadata
   */
  private async resolveMetadata(
    file: File,
    metadata?: VideoMetadata
  ): Promise<VideoMetadata | undefined> {
    if (metadata?.codec && metadata.codec !== 'unknown') {
      return metadata;
    }

    try {
      return await ffmpegService.getVideoMetadata(file);
    } catch (error) {
      logger.warn('conversion', 'Metadata probe failed, continuing without codec', {
        error: getErrorMessage(error),
      });
      return metadata;
    }
  }

  /**
   * Select conversion path
   */
  private async selectPath(
    _file: File,
    format: ConversionFormat,
    metadata?: VideoMetadata
  ): Promise<PathSelection> {
    // For now, use simple heuristic (will be replaced with path-selector.ts in Phase 5)
    // TODO: Implement proper PathSelector

    const codec = metadata?.codec?.toLowerCase();

    // Check if format is supported
    try {
      const encoder = await getEncoderForFormat(format);
      if (encoder) {
        logger.debug('conversion', 'Found encoder for format', {
          format,
          encoder: encoder.name,
        });
      }
    } catch (error) {
      logger.warn('conversion', 'No encoder found for format, using FFmpeg fallback', {
        format,
        error: getErrorMessage(error),
      });

      return {
        path: 'cpu',
        reason: 'No encoder available for format',
      };
    }

    // Simple path selection logic
    // WebCodecs-only codecs must use GPU path
    if (codec === 'av1' || codec === 'vp9' || codec === 'hevc') {
      return {
        path: 'hybrid', // GPU decode, FFmpeg encode (for now)
        reason: `Complex codec (${codec}) requires WebCodecs decode`,
        useDemuxer: true,
      };
    }

    // Default to CPU path for now (will be enhanced with proper path selection)
    return {
      path: 'cpu',
      reason: 'Default path selection',
    };
  }

  /**
   * Convert via GPU path (WebCodecs decode + WASM encode)
   */
  private async convertViaGPUPath(
    request: ConversionRequest,
    metadata: VideoMetadata | undefined,
    conversionMetadata: ConversionMetadata
  ) {
    logger.info('conversion', 'Executing GPU path conversion', {
      format: request.format,
    });

    // TODO: Implement GPU path using frame-extractor and encoder-factory
    // For now, fall back to CPU path
    logger.warn('conversion', 'GPU path not yet implemented, falling back to CPU');
    return this.convertViaCPUPath(request, metadata, conversionMetadata);
  }

  /**
   * Convert via hybrid path (WebCodecs decode + FFmpeg encode)
   */
  private async convertViaHybridPath(
    request: ConversionRequest,
    metadata: VideoMetadata | undefined,
    conversionMetadata: ConversionMetadata
  ) {
    logger.info('conversion', 'Executing hybrid path conversion', {
      format: request.format,
      codec: metadata?.codec,
    });

    // TODO: Implement hybrid path using frame-extractor + ffmpeg-pipeline
    // For now, fall back to CPU path
    logger.warn('conversion', 'Hybrid path not yet implemented, falling back to CPU');
    return this.convertViaCPUPath(request, metadata, conversionMetadata);
  }

  /**
   * Convert via CPU path (FFmpeg direct)
   */
  private async convertViaCPUPath(
    request: ConversionRequest,
    metadata: VideoMetadata | undefined,
    conversionMetadata: ConversionMetadata
  ): Promise<Blob> {
    logger.info('conversion', 'Executing CPU path conversion (FFmpeg direct)', {
      format: request.format,
    });

    conversionMetadata.encoder = 'ffmpeg';
    conversionMetadata.path = 'cpu';

    // Use legacy FFmpeg service (will be replaced with ffmpeg-pipeline in Phase 4)
    // Call the appropriate method based on format
    if (request.format === 'gif') {
      return await ffmpegService.convertToGIF(request.file, request.options, metadata);
    } else if (request.format === 'webp') {
      return await ffmpegService.convertToWebP(request.file, request.options, metadata);
    } else {
      throw new Error(`Unsupported format for CPU path: ${request.format}`);
    }
  }
}

/**
 * Global orchestrator instance
 */
const orchestrator = new ConversionOrchestrator();

/**
 * Convert video (convenience function)
 *
 * Main API function for video conversion. Use this instead of
 * directly instantiating ConversionOrchestrator.
 *
 * @param request - Conversion request
 * @returns Promise resolving to conversion response
 *
 * @example
 * const result = await convertVideo({
 *   file,
 *   format: 'gif',
 *   options: { quality: 'high', scale: 1.0 },
 *   onProgress: (p) => console.log(`${p}%`)
 * });
 */
export async function convertVideo(request: ConversionRequest): Promise<ConversionResponse> {
  return orchestrator.convertVideo(request);
}

/**
 * Get conversion status
 */
export function getConversionStatus(): ConversionStatus {
  return orchestrator.getStatus();
}

/**
 * Cancel current conversion
 */
export function cancelConversion(): void {
  orchestrator.cancel();
}
