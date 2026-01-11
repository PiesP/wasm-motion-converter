/**
 * Path Selector
 *
 * Codec-aware routing logic for selecting optimal conversion path:
 * - GPU Path (WebCodecs): Fast, hardware-accelerated decoding for modern codecs
 * - CPU Path (FFmpeg): Universal fallback with broader codec support
 * - Hybrid Path: WebCodecs decode + FFmpeg encode for specific combinations
 *
 * Routing Priority:
 * 1. Codec requirements (WebCodecs-only codecs like AV1)
 * 2. Format constraints (GIF prefers direct FFmpeg for performance)
 * 3. WebCodecs-first for other formats when available
 * 4. FFmpeg fallback for all remaining cases
 *
 * Features:
 * - Automatic fallback on path failure
 * - Strategy-based routing (forceFFmpeg override)
 * - Comprehensive error context enrichment
 * - Detailed logging for debugging
 *
 * @module orchestration/path-selector
 */

import type {
  ConversionFormat,
  ConversionOptions,
  ConversionOutputBlob,
  VideoMetadata,
} from '@t/conversion-types';
import { classifyConversionError } from '@utils/classify-conversion-error';
import {
  getCodecCapability,
  getCodecErrorMessage,
  requiresWebCodecs,
} from '@utils/codec-capabilities';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { ffmpegService } from '../ffmpeg-service';
import { webcodecsConversionService } from '../webcodecs-conversion-service';
import type { ConversionStrategy } from './strategy-resolver';

/**
 * Path selection parameters
 */
export interface PathSelectionParams {
  file: File;
  format: ConversionFormat;
  options: ConversionOptions;
  metadata?: VideoMetadata;
  strategy: ConversionStrategy;
  webCodecsAvailable: boolean;
}

/**
 * Select optimal conversion path based on codec and format
 *
 * Smart path selection that routes conversion based on codec capabilities,
 * format constraints, and WebCodecs availability. Implements a priority-based
 * decision tree to optimize for performance and compatibility.
 *
 * Priority order:
 * 1. Codec requirements (WebCodecs-only codecs like AV1)
 * 2. Format constraints (GIF prefers direct FFmpeg for performance)
 * 3. WebCodecs-first for other formats when available
 * 4. FFmpeg fallback for all remaining cases
 *
 * @param params Path selection parameters
 * @returns Converted video blob
 * @throws Error if conversion fails on all paths
 */
export async function selectConversionPath(
  params: PathSelectionParams
): Promise<ConversionOutputBlob> {
  const { file, format, options, metadata, strategy, webCodecsAvailable } = params;

  // Normalize codec to handle null/undefined
  const codec = metadata?.codec || undefined;
  const normalizedCodec = codec || undefined;
  const codecCapability = getCodecCapability(codec);

  // Priority 1: Handle WebCodecs-only codecs (e.g., AV1)
  if (requiresWebCodecs(normalizedCodec)) {
    if (!webCodecsAvailable) {
      const errorMessage = getCodecErrorMessage(normalizedCodec, webCodecsAvailable);
      logger.error('conversion', 'WebCodecs-only codec unavailable', {
        codec: normalizedCodec,
        format,
        error: errorMessage,
      });
      throw new Error(errorMessage ?? 'WebCodecs not available');
    }

    // Special case: AV1 + GIF requires WebCodecs decoding + FFmpeg encoding
    // This is the only valid path for this combination
    if (format === 'gif') {
      logger.info('conversion', 'WebCodecs-only codec with GIF: using hybrid path', {
        codec: normalizedCodec,
        reasons: ['AV1/WebCodecs-only codec cannot use direct FFmpeg GIF path'],
      });
      return webcodecsConversionService.convert(file, format as 'gif' | 'webp', options, metadata);
    }

    // WebCodecs-only codec with WebP: Use WebCodecs path
    logger.info('conversion', 'WebCodecs-only codec: using WebCodecs path', {
      codec: normalizedCodec,
      format,
    });
    return webcodecsConversionService.convert(file, format as 'gif' | 'webp', options, metadata);
  }

  // Priority 2: Format-specific constraints (GIF prefers direct FFmpeg)
  if (format === 'gif' && strategy.forceFFmpeg && codecCapability !== 'webcodecs-only') {
    logger.info('conversion', 'GIF format: attempting direct FFmpeg path', {
      codec: normalizedCodec,
      isFFmpegCapable: codecCapability === 'both' || codecCapability === 'ffmpeg-only',
    });
    try {
      return await ffmpegService.convertToGIF(file, options, metadata);
    } catch (error) {
      // If FFmpeg fails for GIF, fallback to WebCodecs path
      const errorMessage = getErrorMessage(error);
      logger.warn('conversion', 'GIF FFmpeg path failed, attempting WebCodecs fallback', {
        codec: normalizedCodec,
        error: errorMessage,
        fallbackReason:
          codecCapability === 'both' ? 'codec supports both paths' : 'codec unsupported by FFmpeg',
      });

      if (webCodecsAvailable) {
        return webcodecsConversionService.convert(
          file,
          format as 'gif' | 'webp',
          options,
          metadata
        );
      }

      // No fallback available, enrich and rethrow error
      const context = classifyConversionError(
        errorMessage,
        metadata ?? null,
        { format, quality: options.quality, scale: options.scale },
        ffmpegService.getRecentFFmpegLogs()
      );

      if (error instanceof Error) {
        (error as unknown as { errorContext?: unknown }).errorContext ??= context;
        throw error;
      }

      const enrichedError = new Error(errorMessage);
      (enrichedError as unknown as { errorContext?: unknown }).errorContext = context;
      throw enrichedError;
    }
  }

  // Priority 3: WebCodecs-first for other formats if available
  if (!strategy.forceFFmpeg && webCodecsAvailable) {
    logger.info('conversion', 'Attempting WebCodecs path (GPU-accelerated)', {
      codec: normalizedCodec,
      format,
    });
    const result = await webcodecsConversionService.maybeConvert(
      file,
      format as 'gif' | 'webp',
      options,
      metadata
    );
    if (result) {
      return result;
    }
    logger.info('conversion', 'WebCodecs path unavailable, falling back to FFmpeg', {
      codec: normalizedCodec,
      format,
    });
  }

  // Final fallback: FFmpeg path
  logger.info('conversion', 'Using FFmpeg path', {
    codec: normalizedCodec,
    format,
    reason: strategy.forceFFmpeg ? 'strategy enforced' : 'WebCodecs unavailable or unsupported',
  });

  if (format === 'gif') {
    return ffmpegService.convertToGIF(file, options, metadata);
  }

  if (format === 'webp') {
    return ffmpegService.convertToWebP(file, options, metadata);
  }

  throw new Error(`Unsupported format: ${format}`);
}

/**
 * Resolve video metadata
 *
 * If metadata is incomplete or missing codec information, probes the file
 * using FFmpeg to obtain complete metadata.
 *
 * @param file Video file to analyze
 * @param metadata Optional existing metadata
 * @returns Resolved metadata or undefined if probe fails
 */
export async function resolveMetadata(
  file: File,
  metadata?: VideoMetadata
): Promise<VideoMetadata | undefined> {
  const UNKNOWN_CODEC = 'unknown';

  if (metadata?.codec && metadata.codec !== UNKNOWN_CODEC) {
    return metadata;
  }

  try {
    if (!ffmpegService.isLoaded()) {
      await ffmpegService.initialize();
    }
    return await ffmpegService.getVideoMetadata(file);
  } catch (error) {
    logger.warn('conversion', 'Metadata probe failed, continuing without codec', {
      error: getErrorMessage(error),
    });
    return metadata;
  }
}
