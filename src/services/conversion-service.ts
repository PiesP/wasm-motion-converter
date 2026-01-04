import type { ConversionFormat, ConversionOptions, VideoMetadata } from '../types/conversion-types';
import { ffmpegService } from './ffmpeg-service';
import { webcodecsConversionService } from './webcodecs-conversion-service';
import { logger } from '../utils/logger';

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

  const webcodecsResult = await webcodecsConversionService.maybeConvert(
    file,
    format,
    options,
    resolvedMetadata
  );
  if (webcodecsResult) {
    return webcodecsResult;
  }

  if (format === 'gif') {
    return ffmpegService.convertToGIF(file, options, resolvedMetadata);
  }

  return ffmpegService.convertToWebP(file, options, resolvedMetadata);
}
