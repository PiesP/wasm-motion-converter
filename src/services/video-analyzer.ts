import { ffmpegService } from './ffmpeg-service';
import type { VideoMetadata } from '../types/conversion-types';

export function analyzeVideo(file: File): Promise<VideoMetadata> {
  return ffmpegService.getVideoMetadata(file);
}

export function analyzeVideoQuick(file: File): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Video metadata loading timed out'));
    }, 5000);

    const cleanup = () => {
      clearTimeout(timeoutId);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    };

    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const metadata: VideoMetadata = {
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        codec: 'unknown',
        framerate: 0,
        bitrate: 0,
      };
      cleanup();
      resolve(metadata);
    };
    video.onerror = () => {
      cleanup();
      reject(new Error('Failed to load video metadata'));
    };

    video.src = url;
  });
}
