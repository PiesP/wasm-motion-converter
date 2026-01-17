/**
 * Video file validation utilities for format and duration compatibility
 *
 * This module provides file validation functions for video conversion:
 * - **Format validation**: Checks file MIME type and extension against supported formats
 * - **Duration extraction**: Uses HTML5 Video API to read video metadata
 * - **Duration validation**: Enforces format-specific constraints (WebP hard limits, GIF soft warnings)
 *
 * **Key features**:
 * - Format validation with fallback chain: MIME type → extension check
 * - Safe metadata extraction with cleanup (revokes blob URLs immediately)
 * - Frame count estimation for memory/performance planning (30fps default)
 * - Format-specific limits: WebP (10s max), GIF (warnings at 30s and 60s)
 * - Graceful error handling (continues conversion if duration extraction fails)
 *
 * **Usage patterns**:
 * 1. Validate format before dropping into conversion pipeline
 * 2. Extract duration to show user estimates and constraints
 * 3. Check duration warnings to inform or block conversion attempts
 */

import type { DurationValidationResult, ValidationWarning } from '@t/validation-types';
import {
  DURATION_WARNING_GIF_LONG,
  DURATION_WARNING_GIF_MEDIUM,
  MAX_FILE_SIZE,
  SUPPORTED_VIDEO_EXTENSIONS,
  SUPPORTED_VIDEO_MIMES,
  WEBP_MAX_DURATION_MS,
  WEBP_MAX_FRAMES,
} from './constants';
import { logger } from './logger';

/**
 * Result of file validation with error message if invalid
 *
 * Represents the outcome of format validation (MIME type and extension checks).
 * If validation fails, an actionable error message is provided to display to users.
 *
 * @property valid - true if file format is supported for conversion
 * @property error - User-friendly error message if validation failed (undefined if valid)
 *
 * @example
 * const result = validateVideoFile(file);
 * if (!result.valid) {
 *   displayError(result.error); // e.g., "Unsupported format..."
 * }
 */
interface FileValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a video file for size and format compatibility
 *
 * Performs two validation checks in order:
 * 1. **File size**: Rejects files >500MB (MAX_FILE_SIZE constant)
 * 2. **Format**: Checks MIME type, then extension with fallback chain
 *
 * **MIME/extension fallback chain**:
 * - Check explicit MIME type (e.g., "video/mp4") against supported list
 * - Check filename extension (e.g., ".mp4") if MIME empty or unsupported
 * - Return error if both checks fail
 *
 * **Note**: MIME type check is case-insensitive to handle browser variations
 * and platform differences in MIME reporting.
 *
 * @param file - The File object to validate (from file input or drag-drop)
 * @returns Validation result with error message if validation fails
 *
 * @example
 * // Valid MP4 file
 * const file = new File([...], 'video.mp4', { type: 'video/mp4' });
 * const result = validateVideoFile(file);
 * // Result: { valid: true }
 *
 * @example
 * // Unsupported format (.flv)
 * const file = new File([...], 'video.flv', { type: 'video/x-flv' });
 * const result = validateVideoFile(file);
 * // Result: { valid: false, error: 'Unsupported format...' }
 */
export function validateVideoFile(file: File): FileValidationResult {
  // CHECK 1: File size limit (500MB)
  // Prevents out-of-memory issues and browser crashes on large files
  if (file.size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: 'File too large (max 500MB). Please trim or compress your video.',
    };
  }

  // CHECK 2: MIME type validation (primary format indicator)
  // Convert to lowercase for case-insensitive comparison (browser variation)
  const mimeType = file.type.toLowerCase();
  if (mimeType) {
    // Accept all video/* MIME types as fallback (covers unknown video formats)
    if (mimeType.startsWith('video/')) {
      return { valid: true };
    }
    // Check against explicit supported list (e.g., "video/quicktime" for .mov)
    if (SUPPORTED_VIDEO_MIMES.includes(mimeType)) {
      return { valid: true };
    }
  }

  // CHECK 3: Filename extension fallback (when MIME type is unreliable)
  // Some systems (e.g., web servers, S3) may not set correct MIME types
  // Extension provides additional validation signal
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (extension && SUPPORTED_VIDEO_EXTENSIONS.includes(extension)) {
    return { valid: true };
  }

  // All validation checks failed - format not supported
  return {
    valid: false,
    error:
      'Unsupported format. Please choose a common video format (MP4, MOV, WebM, MKV, AVI) or a file with a video extension.',
  };
}

/**
 * Extract video duration using HTML5 Video element and metadata API
 *
 * Creates a temporary video element, loads file as blob URL, and reads duration
 * from video metadata. Properly cleans up resources (blob URL revoked immediately).
 *
 * **Algorithm**:
 * 1. Create hidden video element
 * 2. Create blob URL from File object
 * 3. Assign blob URL to video.src
 * 4. Wait for 'loadedmetadata' event (metadata available, no full file download)
 * 5. Extract duration in seconds and convert to milliseconds
 * 6. Clean up: revoke blob URL and clear video.src
 *
 * **Error handling**: Rejects promise if video element fires 'error' event
 * (unsupported codec, corrupted file, etc). Caller must handle rejection.
 *
 * **Resource cleanup**: Blob URL is revoked in both success and error paths
 * to prevent memory leaks. This is critical for long-running apps.
 *
 * @param file - The video File object from file input or drag-drop
 * @returns Promise resolving to duration in milliseconds (e.g., 5000ms for 5s video)
 *
 * @example
 * try {
 *   const durationMs = await extractVideoDuration(file);
 *   const seconds = durationMs / 1000;
 *   logger.debug('conversion', 'Video duration detected', { seconds });
 * } catch (error) {
 *   logger.warn('conversion', 'Unreadable video format', { error });
 * }
 */
async function extractVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    // STEP 1: Create hidden video element and blob URL
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);

    // Centralized cleanup function (called in both success and error paths)
    // Critical to prevent blob URL memory leak and orphaned video element
    const cleanup = () => {
      video.src = ''; // Clear source before revoking URL
      URL.revokeObjectURL(url); // Release blob URL memory
    };

    // STEP 2: Configure video element for metadata-only loading
    // preload='metadata' tells browser to fetch only header (fast, no full download)
    video.preload = 'metadata';

    // STEP 3: Listen for 'loadedmetadata' event (duration is now available)
    // This fires when video duration and dimensions are readable from metadata
    video.onloadedmetadata = () => {
      // Duration from video.duration is in seconds, convert to milliseconds
      const duration = video.duration * 1000;
      cleanup();
      resolve(duration);
    };

    // STEP 4: Handle errors (unsupported codec, corrupted file, network failure)
    // Cleanup resources even on error to prevent memory leaks
    video.onerror = () => {
      cleanup();
      reject(new Error('Failed to extract video duration'));
    };

    // STEP 5: Assign blob URL to trigger metadata loading
    video.src = url;
  });
}

/**
 * Estimate frame count based on duration and framerate
 *
 * Calculates estimated frame count using the formula: frames = (duration / 1000) * fps
 * Uses conservative 30fps estimate for unknown framerates (typical default across platforms).
 * Frame count is useful for memory planning and performance estimation in conversion pipeline.
 *
 * @param durationMs - Duration in milliseconds (e.g., 5000ms for 5 second video)
 * @param fps - Optional known framerate (default: 30fps for unknown videos)
 * @returns Estimated frame count (rounded up to nearest integer with Math.ceil)
 *
 * @example
 * // 5 second video at unknown framerate
 * estimateFrameCount(5000); // (5000 / 1000) * 30 = 150 frames
 *
 * @example
 * // 10 second video at 60fps
 * estimateFrameCount(10000, 60); // (10000 / 1000) * 60 = 600 frames
 */
function estimateFrameCount(durationMs: number, fps = 30): number {
  // Convert milliseconds to seconds, multiply by fps, round up
  // Math.ceil ensures we don't underestimate frame count (e.g., 5.1 frames → 6 frames)
  return Math.ceil((durationMs / 1000) * fps);
}

/**
 * Validate video duration against format-specific constraints and limits
 *
 * Extracts video duration and estimated frame count, then validates against
 * format-specific requirements. WebP has strict constraints; GIF has soft warnings.
 *
 * **WebP constraints (errors with confirmation required)**:
 * - Maximum 10 seconds duration (WEBP_MAX_DURATION_MS)
 * - Maximum 240 frames estimated (WEBP_MAX_FRAMES)
 * - Either violation produces an error warning; users must explicitly confirm to proceed
 *
 * **GIF constraints (soft warnings)**:
 * - ≥60s: Warning that conversion may take 3-5 minutes and produce very large files
 * - 30-60s: Warning that conversion may take 1-2 minutes
 * - <30s: No warning (fast conversion)
 *
 * **Error handling**: If duration extraction fails (unsupported codec, corrupted file),
 * returns success with info warning. Conversion proceeds with default settings.
 * Caller should not block conversion based on extraction errors.
 *
 * @param file - The video File object
 * @param targetFormat - Target conversion format ('gif', 'webp', or other)
 * @returns Promise with duration, frame estimate, warnings, and valid flag
 *
 * @example
 * // WebP exceeds maximum duration
 * const result = await validateVideoDuration(file, 'webp');
 * // result.valid = false (duration > 10s)
 * // result.warnings[0].severity = 'error'
 *
 * @example
 * // GIF with medium length (soft warning)
 * const result = await validateVideoDuration(file, 'gif');
 * // result.valid = true (warnings don't block, even with warnings)
 * // result.warnings[0].severity = 'warning' (30-60s)
 */
export async function validateVideoDuration(
  file: File,
  targetFormat: string
): Promise<DurationValidationResult> {
  try {
    // STEP 1: Extract video metadata
    const duration = await extractVideoDuration(file);
    const estimatedFrames = estimateFrameCount(duration);
    const warnings: ValidationWarning[] = [];

    // STEP 2a: WebP validation (strict constraints; confirmation required)
    // Animated WebP has constraints that may lead to failures or invalid output.
    if (targetFormat === 'webp') {
      // Check duration limit: WebP max 10 seconds (WEBP_MAX_DURATION_MS = 10000ms)
      if (duration > WEBP_MAX_DURATION_MS) {
        warnings.push({
          severity: 'error', // Hard error - blocks conversion
          message: `Video duration (${(duration / 1000).toFixed(
            1
          )}s) exceeds WebP maximum (${WEBP_MAX_DURATION_MS / 1000}s)`,
          details: 'WebP animated format supports maximum 10 seconds of video',
          suggestedAction: 'Consider trimming the video, using GIF format, or converting to MP4',
          requiresConfirmation: true, // User must explicitly confirm/override
        });
      }

      // Check frame count limit: WebP max 240 frames (WEBP_MAX_FRAMES = 240)
      // Guards against performance/memory issues in encoding
      if (estimatedFrames > WEBP_MAX_FRAMES) {
        warnings.push({
          severity: 'error', // Hard error
          message: `Estimated frame count (${estimatedFrames}) may exceed WebP maximum (${WEBP_MAX_FRAMES} frames)`,
          details: 'Try reducing video duration or framerate',
          suggestedAction: 'Trim video to under 8 seconds or use GIF format',
          requiresConfirmation: true,
        });
      }
    }

    // STEP 2b: GIF validation (soft warnings - user can proceed despite warnings)
    // GIF conversion is slower/larger but technically possible for longer videos
    if (targetFormat === 'gif') {
      // Very long: 60+ seconds (DURATION_WARNING_GIF_LONG = 60000ms)
      // Warn about time and file size
      if (duration > DURATION_WARNING_GIF_LONG) {
        warnings.push({
          severity: 'warning', // Soft warning - user can override
          message: `Long video detected (${(duration / 1000).toFixed(1)}s)`,
          details: 'GIF conversion may take 3-5 minutes and produce large files',
          suggestedAction: 'Consider shorter clips for better results',
          requiresConfirmation: true, // Ask user to confirm before proceeding
        });
      }
      // Medium length: 30-60 seconds (DURATION_WARNING_GIF_MEDIUM = 30000ms)
      // Warn about conversion time
      else if (duration > DURATION_WARNING_GIF_MEDIUM) {
        warnings.push({
          severity: 'warning', // Soft warning
          message: `Medium-length video (${(duration / 1000).toFixed(1)}s)`,
          details: 'Conversion may take 1-2 minutes',
          suggestedAction: 'Shorter videos convert faster',
          requiresConfirmation: true,
        });
      }
    }

    // STEP 3: Determine validity: false if any ERROR warnings, true otherwise
    // (warnings with severity='warning' or 'info' don't block conversion)
    return {
      valid: warnings.filter((w) => w.severity === 'error').length === 0,
      duration,
      estimatedFrames,
      warnings,
    };
  } catch (error) {
    // ERROR HANDLING: If duration extraction fails (unsupported codec, corrupted file, network error)
    // Allow conversion to proceed with default settings.
    // The conversion service will eventually handle errors if the video is truly unreadable.
    // This approach: fail gracefully rather than blocking valid videos
    // (some obscure codecs may work in FFmpeg even if HTML5 Video API fails)
    logger.warn('general', 'Failed to extract duration, proceeding without validation', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      valid: true, // Don't block conversion on extraction failure
      duration: 0, // Unknown duration
      estimatedFrames: 0, // Unknown frame count
      warnings: [
        {
          severity: 'info', // Informational - no action required
          message: 'Unable to validate video duration',
          details: 'Conversion will proceed with default settings',
          requiresConfirmation: false, // No user interaction needed
        },
      ],
    };
  }
}
