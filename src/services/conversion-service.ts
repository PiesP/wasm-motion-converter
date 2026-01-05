import type { ConversionFormat, ConversionOptions, VideoMetadata } from '../types/conversion-types';
import {
  getCodecCapability,
  getCodecErrorMessage,
  requiresWebCodecs,
} from '../utils/codec-capabilities';
import { getConversionStrategy } from '../utils/conversion-strategy';
import { logger } from '../utils/logger';
import { ffmpegService } from './ffmpeg-service';
import { webcodecsConversionService } from './webcodecs-conversion-service';
import { isWebCodecsDecodeSupported } from './webcodecs-support';

const resolveMetadata = async (
  file: File,
  metadata?: VideoMetadata
): Promise<VideoMetadata | undefined> => {
  if (metadata?.codec && metadata.codec !== 'unknown') {
    return metadata;
  }

  try {
    if (!ffmpegService.isLoaded()) {
      await ffmpegService.initialize();
    }
    return await ffmpegService.getVideoMetadata(file);
  } catch (error) {
    logger.warn('conversion', 'Metadata probe failed, continuing without codec', {
      error: error instanceof Error ? error.message : String(error),
    });
    return metadata;
  }
};

/**
 * Smart path selection: Routes conversion based on codec+format+availability
 * Order of checks (by priority):
 * 1. Codec requirements (WebCodecs-only vs FFmpeg-supported)
 * 2. Format constraints (GIF performance vs other formats)
 * 3. Format-specific logic (WebP quality vs GIF speed)
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
): Promise<Blob> {
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
      return webcodecsConversionService.convert(file, format, options, resolvedMetadata);
    }

    // WebCodecs-only codec with WebP: Use WebCodecs path
    logger.info('conversion', 'WebCodecs-only codec: using WebCodecs path', {
      codec: normalizedCodec,
      format,
    });
    return webcodecsConversionService.convert(file, format, options, resolvedMetadata);
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('conversion', 'GIF FFmpeg path failed, attempting WebCodecs fallback', {
        codec: normalizedCodec,
        error: errorMessage,
        fallbackReason:
          codecCapability === 'both' ? 'codec supports both paths' : 'codec unsupported by FFmpeg',
      });
      if (webCodecsAvailable) {
        return webcodecsConversionService.convert(file, format, options, resolvedMetadata);
      }
      throw error;
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
      format,
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

export async function convertVideo(
  file: File,
  format: ConversionFormat,
  options: ConversionOptions,
  metadata?: VideoMetadata
): Promise<Blob> {
  const resolvedMetadata = await resolveMetadata(file, metadata);
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
