import {
  DURATION_WARNING_GIF_LONG,
  DURATION_WARNING_GIF_MEDIUM,
  MAX_FILE_SIZE,
  SUPPORTED_VIDEO_EXTENSIONS,
  SUPPORTED_VIDEO_MIMES,
  WEBP_MAX_DURATION_MS,
  WEBP_MAX_FRAMES,
} from './constants';
import type { DurationValidationResult, ValidationWarning } from '../types/validation';

/**
 * Result of file validation with error message if invalid
 */
export interface FileValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a video file for size and format compatibility
 * @param file - The File object to validate
 * @returns Validation result with error message if validation fails
 */
export function validateVideoFile(file: File): FileValidationResult {
  if (file.size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: 'File too large (max 500MB). Please trim or compress your video.',
    };
  }

  const mimeType = file.type.toLowerCase();
  if (mimeType) {
    if (mimeType.startsWith('video/')) {
      return { valid: true };
    }
    if (SUPPORTED_VIDEO_MIMES.includes(mimeType)) {
      return { valid: true };
    }
  }

  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (extension && SUPPORTED_VIDEO_EXTENSIONS.includes(extension)) {
    return { valid: true };
  }

  return {
    valid: false,
    error:
      'Unsupported format. Please choose a common video format (MP4, MOV, WebM, MKV, AVI) or a file with a video extension.',
  };
}

/**
 * Extract video duration using HTML5 Video element
 * @param file - The video File object
 * @returns Duration in milliseconds
 */
export async function extractVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);

    const cleanup = () => {
      video.src = '';
      URL.revokeObjectURL(url);
    };

    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const duration = video.duration * 1000; // Convert to ms
      cleanup();
      resolve(duration);
    };

    video.onerror = () => {
      cleanup();
      reject(new Error('Failed to extract video duration'));
    };

    video.src = url;
  });
}

/**
 * Estimate frame count based on duration
 * Uses conservative 30fps estimate for unknown framerates
 * @param durationMs - Duration in milliseconds
 * @param fps - Optional known framerate
 * @returns Estimated frame count
 */
function estimateFrameCount(durationMs: number, fps = 30): number {
  return Math.ceil((durationMs / 1000) * fps);
}

/**
 * Validate video duration against format-specific limits
 * @param file - The video File object
 * @param targetFormat - Target conversion format (gif, webp)
 * @returns Validation result with warnings
 */
export async function validateVideoDuration(
  file: File,
  targetFormat: string
): Promise<DurationValidationResult> {
  try {
    const duration = await extractVideoDuration(file);
    const estimatedFrames = estimateFrameCount(duration);
    const warnings: ValidationWarning[] = [];

    // WebP hard limits
    if (targetFormat === 'webp') {
      if (duration > WEBP_MAX_DURATION_MS) {
        warnings.push({
          severity: 'error',
          message: `Video duration (${(duration / 1000).toFixed(1)}s) exceeds WebP maximum (${WEBP_MAX_DURATION_MS / 1000}s)`,
          details: 'WebP animated format supports maximum 10 seconds of video',
          suggestedAction: 'Consider trimming the video, using GIF format, or converting to MP4',
          requiresConfirmation: true,
        });
      }

      if (estimatedFrames > WEBP_MAX_FRAMES) {
        warnings.push({
          severity: 'error',
          message: `Estimated frame count (${estimatedFrames}) may exceed WebP maximum (${WEBP_MAX_FRAMES} frames)`,
          details: 'Try reducing video duration or framerate',
          suggestedAction: 'Trim video to under 8 seconds or use GIF format',
          requiresConfirmation: true,
        });
      }
    }

    // GIF soft warnings
    if (targetFormat === 'gif') {
      if (duration > DURATION_WARNING_GIF_LONG) {
        warnings.push({
          severity: 'warning',
          message: `Long video detected (${(duration / 1000).toFixed(1)}s)`,
          details: 'GIF conversion may take 3-5 minutes and produce large files',
          suggestedAction: 'Consider shorter clips for better results',
          requiresConfirmation: true,
        });
      } else if (duration > DURATION_WARNING_GIF_MEDIUM) {
        warnings.push({
          severity: 'warning',
          message: `Medium-length video (${(duration / 1000).toFixed(1)}s)`,
          details: 'Conversion may take 1-2 minutes',
          suggestedAction: 'Shorter videos convert faster',
          requiresConfirmation: true,
        });
      }
    }

    return {
      valid: warnings.filter((w) => w.severity === 'error').length === 0,
      duration,
      estimatedFrames,
      warnings,
    };
  } catch (error) {
    // If duration extraction fails, allow conversion to proceed
    // The conversion service will handle the error
    console.warn('Failed to extract duration, proceeding without validation:', error);
    return {
      valid: true,
      duration: 0,
      estimatedFrames: 0,
      warnings: [
        {
          severity: 'info',
          message: 'Unable to validate video duration',
          details: 'Conversion will proceed with default settings',
          requiresConfirmation: false,
        },
      ],
    };
  }
}
