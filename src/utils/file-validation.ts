import { MAX_FILE_SIZE, SUPPORTED_VIDEO_MIMES } from './constants';

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

  if (!SUPPORTED_VIDEO_MIMES.includes(file.type)) {
    return {
      valid: false,
      error: 'Unsupported format. Please use MP4, MOV, WebM, AVI, or MKV.',
    };
  }

  return { valid: true };
}
