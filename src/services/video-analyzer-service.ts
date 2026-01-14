import { ffmpegService } from './ffmpeg-service';

import type { VideoMetadata } from '@t/conversion-types';

/**
 * Timeout for video metadata loading (5 seconds)
 */
const VIDEO_METADATA_TIMEOUT_MS = 5000;

/**
 * Default codec value when codec information is unavailable
 */
const UNKNOWN_CODEC = 'unknown';

/**
 * Default numeric value for unavailable metadata fields
 */
const DEFAULT_METADATA_VALUE = 0;

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

/**
 * Quick video analysis using browser's native video element
 * Extracts basic metadata (width, height, duration) without codec details
 * Much faster than FFmpeg analysis but less comprehensive
 * Includes 5-second timeout for reliability
 *
 * @param file - Input video file to analyze
 * @returns Basic video metadata (codec will be 'unknown')
 * @throws Error if video loading fails or times out
 *
 * @example
 * try {
 *   const metadata = await analyzeVideoQuick(file);
 *   logger.info('conversion', 'Quick video analysis complete', {
 *     width: metadata.width,
 *     height: metadata.height,
 *   });
 * } catch (error) {
 *   logger.warn('conversion', 'Quick analysis failed; falling back to FFmpeg', { error });
 *   const metadata = await analyzeVideo(file);
 * }
 */
export function analyzeVideoQuick(file: File): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Video metadata loading timed out'));
    }, VIDEO_METADATA_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeoutId);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    };

    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const metadata: VideoMetadata = {
        width: video.videoWidth || DEFAULT_METADATA_VALUE,
        height: video.videoHeight || DEFAULT_METADATA_VALUE,
        duration: Number.isFinite(video.duration) ? video.duration : DEFAULT_METADATA_VALUE,
        codec: UNKNOWN_CODEC,
        framerate: DEFAULT_METADATA_VALUE,
        bitrate: DEFAULT_METADATA_VALUE,
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
