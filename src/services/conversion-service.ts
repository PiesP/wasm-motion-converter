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
import { getConversionStrategy } from '@utils/conversion-strategy';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { ffmpegService } from './ffmpeg-service';
import { webcodecsConversionService } from './webcodecs-conversion-service';
import { isWebCodecsDecodeSupported } from './webcodecs-support-service';

/**
 * Codec value indicating unknown or undetected codec
 */
const UNKNOWN_CODEC = 'unknown';

/**
 * Resolve video metadata
 *
 * If metadata is incomplete or missing codec information, probes the file
 * using FFmpeg to obtain complete metadata.
 *
 * @param file - Video file to analyze
 * @param metadata - Optional existing metadata
 * @returns Resolved metadata or undefined if probe fails
 */
const resolveMetadata = async (
  file: File,
  metadata?: VideoMetadata
): Promise<VideoMetadata | undefined> => {
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
};

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
 * @param file - Video file to convert
 * @param format - Target format (gif or webp)
 * @param options - Conversion options (quality, scale, duration)
 * @param resolvedMetadata - Resolved video metadata
 * @param strategy - Conversion strategy with overrides
 * @param webCodecsAvailable - Whether WebCodecs API is available
 * @param codec - Video codec identifier
 * @param codecCapability - Codec capability classification
 * @returns Converted video blob
 */
async function selectConversionPath(
  file: File,
  format: ConversionFormat,
  options: ConversionOptions,
  resolvedMetadata: VideoMetadata | undefined,
  strategy: ReturnType<typeof getConversionStrategy>,
  webCodecsAvailable: boolean,
  codec: string | undefined | null,
  codecCapability: ReturnType<typeof getCodecCapability>
): Promise<ConversionOutputBlob> {
  // Normalize codec to handle null case
  const normalizedCodec = codec || undefined;

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
      return webcodecsConversionService.convert(
        file,
        format as 'gif' | 'webp',
        options,
        resolvedMetadata
      );
    }

    // WebCodecs-only codec with WebP: Use WebCodecs path
    logger.info('conversion', 'WebCodecs-only codec: using WebCodecs path', {
      codec: normalizedCodec,
      format,
    });
    return webcodecsConversionService.convert(
      file,
      format as 'gif' | 'webp',
      options,
      resolvedMetadata
    );
  }

  // Priority 2: Format-specific constraints (GIF prefers direct FFmpeg)
  if (format === 'gif' && strategy.forceFFmpeg && codecCapability !== 'webcodecs-only') {
    logger.info('conversion', 'GIF format: attempting direct FFmpeg path', {
      codec: normalizedCodec,
      isFFmpegCapable: codecCapability === 'both' || codecCapability === 'ffmpeg-only',
    });
    try {
      return ffmpegService.convertToGIF(file, options, resolvedMetadata);
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
          resolvedMetadata
        );
      }

      const context = classifyConversionError(
        errorMessage,
        resolvedMetadata ?? null,
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
      resolvedMetadata
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
    return ffmpegService.convertToGIF(file, options, resolvedMetadata);
  }

  return ffmpegService.convertToWebP(file, options, resolvedMetadata);
}

/**
 * Convert video file to specified format
 *
 * Main entry point for video conversion. Handles metadata resolution,
 * FFmpeg initialization, strategy application, and optimal path selection
 * based on codec capabilities and format requirements.
 *
 * Features:
 * - Parallel FFmpeg initialization and metadata resolution
 * - Automatic strategy overrides for scale and quality
 * - Codec-aware routing to WebCodecs or FFmpeg paths
 * - Comprehensive logging for debugging and monitoring
 *
 * @param file - Input video file
 * @param format - Target format (gif or webp)
 * @param options - Conversion options (quality, scale, duration)
 * @param metadata - Optional pre-resolved video metadata
 * @returns Converted video blob
 *
 * @example
 * const blob = await convertVideo(
 *   videoFile,
 *   'gif',
 *   { quality: 'high', scale: 1.0 },
 *   videoMetadata
 * );
 */
export async function convertVideo(
  file: File,
  format: ConversionFormat,
  options: ConversionOptions,
  metadata?: VideoMetadata
): Promise<ConversionOutputBlob> {
  // Initialize FFmpeg in parallel with metadata resolution for 1-3s speedup
  const ffmpegInitPromise = ffmpegService.isLoaded()
    ? Promise.resolve()
    : ffmpegService.initialize();

  // Resolve metadata (may use FFmpeg if needed)
  const resolvedMetadata = await resolveMetadata(file, metadata);

  // Ensure FFmpeg is ready before proceeding
  await ffmpegInitPromise;

  const routingStartTime = performance.now();

  const strategy = getConversionStrategy({ file, format, metadata: resolvedMetadata });

  let effectiveOptions: ConversionOptions = { ...options };

  if (strategy.scaleOverride && strategy.scaleOverride !== effectiveOptions.scale) {
    logger.info('conversion', 'Applying strategy scale override', {
      from: effectiveOptions.scale,
      to: strategy.scaleOverride,
      reasons: strategy.reasons,
    });
    effectiveOptions = { ...effectiveOptions, scale: strategy.scaleOverride };
  }

  if (strategy.recommendedQuality && strategy.recommendedQuality !== effectiveOptions.quality) {
    logger.info('conversion', 'Applying strategy quality override', {
      from: effectiveOptions.quality,
      to: strategy.recommendedQuality,
      reasons: strategy.reasons,
    });
    effectiveOptions = { ...effectiveOptions, quality: strategy.recommendedQuality };
  }

  // Codec-aware routing: Route to optimal conversion path based on codec capabilities
  const codec = resolvedMetadata?.codec;
  const codecCapability = getCodecCapability(codec);
  const webCodecsAvailable = isWebCodecsDecodeSupported();

  logger.info('conversion', 'Codec-aware routing decision', {
    codec,
    codecCapability,
    webCodecsAvailable,
    format,
    strategyReasons: strategy.reasons,
  });

  // Log routing performance (always visible in production via performance category)
  const routingDuration = performance.now() - routingStartTime;
  const normalizedCodec = codec || UNKNOWN_CODEC;
  const selectedPath = requiresWebCodecs(codec)
    ? format === 'gif'
      ? 'webcodecs+ffmpeg-hybrid'
      : 'webcodecs'
    : strategy.forceFFmpeg
      ? 'ffmpeg'
      : webCodecsAvailable
        ? 'webcodecs-first'
        : 'ffmpeg';

  logger.performance('Codec routing decision completed', {
    durationMs: Math.round(routingDuration),
    selectedPath,
    codec: normalizedCodec,
    codecCapability,
    format,
  });

  return selectConversionPath(
    file,
    format,
    effectiveOptions,
    resolvedMetadata,
    strategy,
    webCodecsAvailable,
    codec,
    codecCapability
  );
}
