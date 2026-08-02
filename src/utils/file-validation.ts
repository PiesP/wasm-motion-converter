// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

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

import { getErrorMessage, isCancellationError } from '@piesp/browser-core/error';
import type { TranslationKeys } from '@t/i18n-types';
import type { DurationValidationResult } from '@t/validation-types';
import { MAX_FILE_SIZE, SUPPORTED_VIDEO_EXTENSIONS, SUPPORTED_VIDEO_MIMES } from './constants';
import { logger } from './logger';
import { assessVideoDuration } from './video-duration-policy';

type TFunction = <K extends keyof TranslationKeys>(
  key: K,
  params?: Record<string, string | number>
) => TranslationKeys[K];

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
 * const result = validateVideoFile(file, t);
 * if (!result.valid) {
 *   displayError(result.error); // e.g., "Unsupported format..."
 * }
 */
interface FileValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Detects video file format by inspecting magic bytes.
 *
 * Checks for common container signatures (MP4/ISOBMFF, WebM/Matroska, AVI).
 * Returns true if a known video signature is detected.
 *
 * @param file - The File object to inspect
 * @returns true if the file matches a known video signature
 */
async function detectVideoMagicBytes(file: File): Promise<boolean> {
  try {
    const header = file.slice(0, 12);
    const buffer = await header.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    if (bytes.length < 8) return false;

    // MP4/ISOBMFF: ftyp at offset 4, or general ISO base media header
    const ftypSignature =
      bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
    if (ftypSignature) return true;

    // Some MP4s start with 'moov' at offset 4
    const moovSignature =
      bytes[4] === 0x6d && bytes[5] === 0x6f && bytes[6] === 0x6f && bytes[7] === 0x76;
    if (moovSignature) return true;

    // Matroska/WebM: EBML header 0x1A 0x45 0xDF 0xA3
    const ebmlSignature =
      bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    if (ebmlSignature) return true;

    // AVI: RIFF at offset 0, AVI at offset 8
    const riffSignature =
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    const aviSignature =
      bytes[8] === 0x41 && bytes[9] === 0x56 && bytes[10] === 0x49 && bytes[11] === 0x20;
    if (riffSignature && aviSignature) return true;

    // OGG: 'OggS' at offset 0
    const oggSignature =
      bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;
    if (oggSignature) return true;

    // MPEG-TS: sync byte 0x47 at offset 0
    const mpegTsSignature = bytes[0] === 0x47;
    if (mpegTsSignature) return true;

    return false;
  } catch {
    // File read failed — don't block, let downstream handle
    return false;
  }
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
 * @param t - Translation function for error messages
 * @returns Validation result with error message if validation fails
 *
 * @example
 * // Valid MP4 file
 * const file = new File([...], 'video.mp4', { type: 'video/mp4' });
 * const result = validateVideoFile(file, t);
 * // Result: { valid: true }
 *
 * @example
 * // Unsupported format (.flv)
 * const file = new File([...], 'video.flv', { type: 'video/x-flv' });
 * const result = validateVideoFile(file, t);
 * // Result: { valid: false, error: 'Unsupported format...' }
 */
export async function validateVideoFile(file: File, t: TFunction): Promise<FileValidationResult> {
  // CHECK 1: File size limit (500MB)
  // Prevents out-of-memory issues and browser crashes on large files
  if (file.size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: t('validation.fileTooLarge'),
    };
  }

  // CHECK 2: MIME type validation (primary format indicator)
  // Convert to lowercase for case-insensitive comparison (browser variation)
  const mimeType = file.type.toLowerCase();
  if (mimeType) {
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

  // CHECK 3b: Magic bytes validation — defense-in-depth against extension spoofing.
  // If MIME is empty and extension check failed, inspect file signature
  // to detect video files that were renamed or have missing/invalid extensions.
  // This prevents malicious files with renamed extensions from passing validation.
  if (!mimeType) {
    const detected = await detectVideoMagicBytes(file);
    if (detected) {
      return { valid: true };
    }
  }

  // CHECK 4: Reject files with a video/* MIME type but unsupported extension.
  // This catches cases where the browser reports a generic video/* type for
  // formats we cannot handle (e.g., some AVI variants, FLV, WMV).
  if (mimeType?.startsWith('video/')) {
    return {
      valid: false,
      error: t('validation.unsupportedMimeType', { mimeType }),
    };
  }

  // All validation checks failed - format not supported
  return {
    valid: false,
    error: t('validation.unsupportedFormat'),
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
async function extractVideoDuration(file: File, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    // STEP 1: Create hidden video element and blob URL
    const video = document.createElement('video');
    // Blob URLs (URL.createObjectURL) are always same-origin, so no crossOrigin
    // attribute is needed. If this function is ever adapted for remote video
    // URLs, add crossOrigin="anonymous" (or appropriate) before src assignment.
    const url = URL.createObjectURL(file);

    // Timeout guard (M6 fix): reject if metadata doesn't load within 5 seconds.
    // Prevents hanging indefinitely on corrupt files that fire neither
    // loadedmetadata nor error events.
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Video duration extraction timed out after 5s'));
    }, 5000);

    // Centralized cleanup function (called in both success and error paths)
    // Critical to prevent blob URL memory leak and orphaned video element
    const cleanup = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      video.src = ''; // Clear source before revoking URL
      URL.revokeObjectURL(url); // Release blob URL memory
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException('Cancelled', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    // STEP 2: Configure video element for metadata-only loading
    // preload='metadata' tells browser to fetch only header (fast, no full download)
    video.preload = 'metadata';

    // Track whether loadedmetadata fired, for edge-case error detection.
    // Some browsers fire the error event *before* loadedmetadata on certain
    // corrupt files; without this flag the error handler would be correct
    // but we guard against the reverse (error fires instead of loadedmetadata).
    let metadataLoaded = false;

    // STEP 3: Listen for 'loadedmetadata' event (duration is now available)
    // This fires when video duration and dimensions are readable from metadata
    video.onloadedmetadata = () => {
      if (settled) return;
      settled = true;
      metadataLoaded = true;
      // Duration from video.duration is in seconds, convert to milliseconds
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        cleanup();
        reject(new Error('Invalid video duration'));
        return;
      }
      const duration = video.duration * 1000;
      cleanup();
      resolve(duration);
    };

    // STEP 4: Handle errors (unsupported codec, corrupted file, network failure)
    // Cleanup resources even on error to prevent memory leaks.
    // If loadedmetadata already fired successfully, errors at this point are
    // from later playback (e.g. corrupted seek), and the promise is already
    // resolved — the error is ignored.
    video.onerror = () => {
      if (metadataLoaded || settled) return; // Already resolved duration
      settled = true;
      cleanup();
      reject(new Error('Failed to extract video duration'));
    };

    // STEP 5: Assign blob URL to trigger metadata loading
    video.src = url;
  });
}

/**
 * Validate video duration against format-specific constraints and limits
 *
 * Extracts video duration and estimated frame count, then validates against
 * format-specific requirements. WebP has strict constraints; GIF has no warnings.
 *
 * **WebP constraints (soft warnings)**:
 * - Maximum 900 seconds duration (WEBP_MAX_DURATION_MS)
 * - Maximum 9000 frames estimated (WEBP_MAX_FRAMES)
 * - Either violation produces a warning; users can proceed without confirmation
 *
 * **GIF**: No warnings — conversion proceeds directly.
 *
 * @param file - The video File object
 * @param targetFormat - Target conversion format ('gif', 'webp', or other)
 * @param t - Translation function for warning messages
 * @param fps - Known framerate from video metadata (default: 30fps fallback)
 * @returns Promise with duration, frame estimate, warnings, and valid flag
 *
 * @example
 * // WebP exceeds maximum duration
 * const result = await validateVideoDuration(file, 'webp', t);
 * // result.valid = true (warnings don't block)
 * // result.warnings[0].severity = 'warning'
 */
export async function validateVideoDuration(
  file: File,
  targetFormat: string,
  t: TFunction,
  fps?: number,
  signal?: AbortSignal
): Promise<DurationValidationResult> {
  try {
    // STEP 1: Extract video metadata
    const duration = await extractVideoDuration(file, signal);
    return assessVideoDuration(duration, targetFormat, fps);
  } catch (error) {
    if (isCancellationError(error)) throw error;
    // ERROR HANDLING: If duration extraction fails (unsupported codec, corrupted file, network error)
    // Allow conversion to proceed with default settings.
    // The conversion service will eventually handle errors if the video is truly unreadable.
    // This approach: fail gracefully rather than blocking valid videos
    // (some obscure codecs may work in FFmpeg even if HTML5 Video API fails)
    logger.warn('general', 'Failed to extract duration, proceeding without validation', {
      error: getErrorMessage(error),
    });
    return {
      valid: true, // Don't block conversion on extraction failure
      duration: 0, // Unknown duration
      estimatedFrames: 0, // Unknown frame count
      warnings: [
        {
          severity: 'info', // Informational - no action required
          message: t('validation.noValidation'),
          details: t('validation.noValidationDetail'),
          requiresConfirmation: false, // No user interaction needed
        },
      ],
    };
  }
}
