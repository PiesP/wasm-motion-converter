import type {
  ConversionFormat,
  ConversionOptions,
  VideoMetadata,
} from '../types/conversion-types';
import { ffmpegService } from './ffmpeg-service';

export function convertVideo(
  file: File,
  format: ConversionFormat,
  options: ConversionOptions,
  metadata?: VideoMetadata
): Promise<Blob> {
  if (format === 'gif') {
    return ffmpegService.convertToGIF(file, options, metadata);
  }

  return ffmpegService.convertToWebP(file, options, metadata);
}
