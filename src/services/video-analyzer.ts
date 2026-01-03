import { ffmpegService } from './ffmpeg-service';
import type { VideoMetadata } from '../types/conversion-types';

export function analyzeVideo(file: File): Promise<VideoMetadata> {
  return ffmpegService.getVideoMetadata(file);
}
