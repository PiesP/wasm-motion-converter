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
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { getEncoderForFormat } from '../encoders/encoder-factory';
import { ffmpegService } from '../ffmpeg-service'; // Legacy service (will be replaced in Phase 4)
import { ProgressReporter } from '../shared/progress-reporter';
import { createWebAVMP4Service } from '../webav/webav-mp4-service';
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
  private webavService = createWebAVMP4Service();

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
        case 'webav':
          blob = await this.convertViaWebAVPath(request, metadata, conversionMetadata);
          break;

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

      // Log the error without full classification (will be done in consumer)
      // to avoid redundant error processing and potential stack overflow
      logger.error('conversion', 'Conversion failed', {
        file: request.file.name,
        format: request.format,
        error: errorMessage,
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
   *
   * For complex codecs (AV1, VP9, HEVC), metadata is mandatory for proper processing.
   * This prevents issues with timeout calculation and codec detection.
   */
  private async resolveMetadata(
    file: File,
    metadata?: VideoMetadata
  ): Promise<VideoMetadata | undefined> {
    if (metadata?.codec && metadata.codec !== 'unknown') {
      return metadata;
    }

    try {
      const probed = await ffmpegService.getVideoMetadata(file);

      // For complex codecs, metadata is mandatory
      const codec = probed?.codec?.toLowerCase();
      if (codec === 'av1' || codec === 'vp9' || codec === 'hevc') {
        if (!probed || !probed.duration || probed.duration === 0) {
          throw new Error(
            `Failed to extract metadata for ${codec.toUpperCase()} codec. ` +
              'This codec requires complete metadata for processing. ' +
              'The file may be corrupted or in an unsupported format.'
          );
        }
        logger.info('conversion', 'Mandatory metadata extracted for complex codec', {
          codec: probed.codec,
          duration: probed.duration,
          resolution: `${probed.width}x${probed.height}`,
        });
      }

      return probed;
    } catch (error) {
      const errorMsg = getErrorMessage(error);

      // Re-throw if it's our mandatory metadata error
      if (errorMsg.includes('Failed to extract metadata')) {
        throw error;
      }

      logger.warn('conversion', 'Metadata probe failed, continuing without codec', {
        error: errorMsg,
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

    // WebAV path for MP4 (20x faster than FFmpeg)
    if (format === 'mp4') {
      const webavAvailable = await this.webavService.isAvailable();
      if (webavAvailable) {
        logger.info('conversion', 'Using WebAV for MP4 conversion', {
          codec,
          reason: 'WebAV available for fast MP4 encoding',
        });
        return {
          path: 'webav',
          reason: 'WebAV MP4 encoding (20x faster)',
        };
      }
      logger.warn('conversion', 'WebAV not available, falling back to FFmpeg for MP4', {
        codec,
      });
      return {
        path: 'cpu',
        reason: 'WebAV not available, using FFmpeg fallback',
      };
    }

    // ============================================================================
    // GPU-FIRST PATH SELECTION FOR GIF/WEBP
    // ============================================================================
    // Strategy: Always attempt GPU path (WebCodecs frame extraction + FFmpeg encoding)
    // for GIF/WebP formats, regardless of codec. This avoids FFmpeg direct conversion
    // timeout issues and leverages hardware-accelerated decoding.
    //
    // Benefits:
    // - WebP: 2-5s encoding (vs 90s+ timeout with FFmpeg direct)
    // - GIF: 10-15s with modern-gif (vs potential FFmpeg issues)
    // - All codecs: Hardware-accelerated frame extraction
    //
    // Fallback chain:
    // 1. GPU path (WebCodecs decode + FFmpeg/worker encode)
    // 2. CPU path (FFmpeg direct - only if GPU fails)
    //
    // Future: Hybrid strategy will add codec-specific optimizations
    // ============================================================================
    const isGifOrWebP = format === 'gif' || format === 'webp';

    if (isGifOrWebP) {
      // Force GPU path for all GIF/WebP conversions
      // GPU path handles frame extraction, then uses FFmpeg for encoding
      logger.info('conversion', 'Using GPU path for GIF/WebP (forced routing)', {
        format,
        codec: codec || 'unknown',
        reason: 'GPU path mandatory to avoid FFmpeg direct conversion issues',
        strategy: 'gpu-first with FFmpeg fallback',
      });
      return {
        path: 'gpu',
        reason: `${format.toUpperCase()}: GPU path (frame extraction) avoids timeout issues`,
        useDemuxer: true,
      };
    }

    // For other formats (not GIF/WebP), check encoder availability
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

    // Default to CPU path for unsupported codecs or other formats
    return {
      path: 'cpu',
      reason: 'Default path selection',
    };
  }

  /**
   * Convert via WebAV path (native WebCodecs MP4 encoding)
   */
  private async convertViaWebAVPath(
    request: ConversionRequest,
    metadata: VideoMetadata | undefined,
    conversionMetadata: ConversionMetadata
  ) {
    logger.info('conversion', 'Executing WebAV path conversion', {
      format: request.format,
      codec: metadata?.codec,
    });

    conversionMetadata.encoder = 'webav';
    conversionMetadata.path = 'webav';

    try {
      const blob = await this.webavService.convertToMP4(
        request.file,
        request.options,
        (progress: number) => {
          // Map 0-100 to conversion phase progress
          const phaseProgress = Math.round(progress);
          this.progressReporter?.report(phaseProgress / 100);
          request.onProgress?.(phaseProgress);
        }
      );

      logger.info('conversion', 'WebAV MP4 conversion completed', {
        outputSize: `${(blob.size / 1024 / 1024).toFixed(1)}MB`,
      });

      return blob;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      logger.error('conversion', 'WebAV MP4 conversion failed, falling back to FFmpeg', {
        error: errorMessage,
      });

      // Fall back to FFmpeg if WebAV fails
      return this.convertViaCPUPath(request, metadata, conversionMetadata);
    }
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
      codec: metadata?.codec,
    });

    // GPU path only supports GIF/WebP formats
    if (request.format !== 'gif' && request.format !== 'webp') {
      logger.warn('conversion', 'GPU path does not support this format, falling back to FFmpeg', {
        format: request.format,
      });
      return this.convertViaCPUPath(request, metadata, conversionMetadata);
    }

    // For AV1 and other WebCodecs-required codecs, use WebCodecs service
    conversionMetadata.encoder = 'webcodecs';
    conversionMetadata.path = 'gpu';

    // Use WebCodecs conversion service for GPU-accelerated decoding
    const { webcodecsConversionService } = await import('../webcodecs-conversion-service');
    const result = await webcodecsConversionService.convert(
      request.file,
      request.format,
      request.options,
      metadata
    );

    if (result) {
      return result;
    }

    // Fallback to CPU if WebCodecs fails
    logger.warn('conversion', 'GPU path (WebCodecs) failed, falling back to FFmpeg');
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
