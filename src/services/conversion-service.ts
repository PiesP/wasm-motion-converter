import type { ConversionFormat, ConversionOptions } from '../types/conversion-types';
import { ffmpegService } from './ffmpeg-service';

export function convertVideo(
  file: File,
  format: ConversionFormat,
  options: ConversionOptions
): Promise<Blob> {
  if (format === 'gif') {
    return ffmpegService.convertToGIF(file, options);
  }

  return ffmpegService.convertToWebP(file, options);
}
