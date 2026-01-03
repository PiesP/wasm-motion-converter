import { ffmpegService } from './ffmpeg-service';
import type { VideoMetadata } from '../types/conversion-types';

export async function analyzeVideo(file: File): Promise<VideoMetadata> {
  return await ffmpegService.getVideoMetadata(file);
}
