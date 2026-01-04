import { MAX_FILE_SIZE, SUPPORTED_VIDEO_EXTENSIONS, SUPPORTED_VIDEO_MIMES } from './constants';

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
