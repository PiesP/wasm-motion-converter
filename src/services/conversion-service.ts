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

  logger.info('conversion', 'Codec-aware routing', {
    codec,
    capability: codecCapability,
    webCodecsAvailable,
    format,
  });

  // Check if codec requires WebCodecs exclusively (e.g., AV1)
  if (requiresWebCodecs(codec)) {
    const errorMessage = getCodecErrorMessage(codec, webCodecsAvailable);
    if (errorMessage) {
      logger.error('conversion', 'Codec requires WebCodecs but not available', {
        codec,
        error: errorMessage,
      });
      throw new Error(errorMessage);
    }

    // AV1: MUST use WebCodecs, error if conversion fails
    logger.info('conversion', `${codec?.toUpperCase()} requires WebCodecs, using exclusive path`);
    const result = await webcodecsConversionService.convert(
      file,
      format,
      effectiveOptions,
      resolvedMetadata
    );
    return result;
  }

  // For codecs supported by both paths or FFmpeg-only:
  // Try WebCodecs first (faster, GPU-accelerated), fall back to FFmpeg
  const skipWebCodecs = strategy.forceFFmpeg && format === 'gif';
  const webcodecsResult = skipWebCodecs
    ? null
    : await webcodecsConversionService.maybeConvert(
        file,
        format,
        effectiveOptions,
        resolvedMetadata
      );
  if (webcodecsResult) {
    return webcodecsResult;
  }

  // FFmpeg fallback
  logger.info('conversion', 'Using FFmpeg fallback path', {
    codec,
    format,
    strategy: strategy.reasons,
  });

  if (format === 'gif') {
    return ffmpegService.convertToGIF(file, effectiveOptions, resolvedMetadata);
  }

  return ffmpegService.convertToWebP(file, effectiveOptions, resolvedMetadata);
}
