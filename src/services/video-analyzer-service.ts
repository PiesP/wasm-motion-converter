import type { VideoMetadata } from '@t/conversion-types';
import { ffmpegService } from './ffmpeg-service';

/**
 * Analyze video file using FFmpeg to extract comprehensive metadata
 * Provides accurate codec, framerate, and bitrate information
 * Uses FFmpeg probe for deep inspection of video container
 *
 * @param file - Input video file to analyze
 * @returns Complete video metadata including codec details
 *
 * @example
 * const metadata = await analyzeVideo(file);
 * logger.info('conversion', 'Video metadata analyzed', {
 *   width: metadata.width,
 *   height: metadata.height,
 *   framerate: metadata.framerate,
 * });
 */
export function analyzeVideo(file: File): Promise<VideoMetadata> {
  return ffmpegService.getVideoMetadata(file);
}
