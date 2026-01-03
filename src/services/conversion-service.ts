import type { ConversionFormat, ConversionOptions } from '../types/conversion-types';
import { ffmpegService } from './ffmpeg-service';

export async function convertVideo(
  file: File,
  format: ConversionFormat,
  options: ConversionOptions
): Promise<Blob> {
  console.log('[Conversion Service] Starting conversion:', { format, options });

  if (format === 'gif') {
    const result = await ffmpegService.convertToGIF(file, options);
    console.log('[Conversion Service] GIF conversion completed');
    return result;
  }

  const result = await ffmpegService.convertToWebP(file, options);
  console.log('[Conversion Service] WebP conversion completed');
  return result;
}
