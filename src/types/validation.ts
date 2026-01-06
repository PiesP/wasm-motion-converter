/**
 * Validation Types
 *
 * Type definitions for video file validation, including severity levels,
 * validation warnings, and validation results. Used during the video analysis
 * phase to detect potential issues before conversion begins.
 */

/**
 * Validation warning severity level
 *
 * - `info`: Informational message, no action required
 * - `warning`: Potential issue, but conversion can proceed
 * - `error`: Critical issue, conversion may fail or produce poor results
 *
 * @example
 * const severity: ValidationSeverity = 'warning';
 */
export type ValidationSeverity = 'info' | 'warning' | 'error';

/**
 * Validation warning with user-facing message
 *
 * Represents a single validation issue detected during video analysis.
 * Includes severity level, message, optional details, suggested action,
 * and whether user confirmation is required before proceeding.
 *
 * @example
 * const warning: ValidationWarning = {
 *   severity: 'warning',
 *   message: 'Video duration is very long (10 minutes)',
 *   details: 'Long videos may take several minutes to convert',
 *   suggestedAction: 'Consider trimming the video or reducing quality',
 *   requiresConfirmation: true
 * };
 */
export interface ValidationWarning {
  /** Severity level of the warning */
  severity: ValidationSeverity;
  /** User-friendly warning message */
  message: string;
  /** Additional context or explanation */
  details?: string;
  /** Recommended action to resolve or mitigate the issue */
  suggestedAction?: string;
  /** Whether user must confirm before proceeding */
  requiresConfirmation: boolean;
}

/**
 * Duration validation result
 *
 * Result of validating video duration. Includes whether the duration is
 * acceptable, the actual duration value, estimated frame count for conversion
 * planning, and any warnings about the duration.
 *
 * @example
 * const result: DurationValidationResult = {
 *   valid: true,
 *   duration: 5.5,
 *   estimatedFrames: 165,
 *   warnings: [
 *     {
 *       severity: 'info',
 *       message: 'Video duration: 5.5 seconds',
 *       requiresConfirmation: false
 *     }
 *   ]
 * };
 */
export interface DurationValidationResult {
  /** Whether duration is within acceptable limits */
  valid: boolean;
  /** Video duration in seconds */
  duration: number;
  /** Estimated number of frames (duration * framerate) */
  estimatedFrames?: number;
  /** Warnings related to duration */
  warnings: ValidationWarning[];
}

/**
 * Complete validation result for video file
 *
 * Comprehensive validation result including overall validity, detected format
 * and codec, duration information, estimated frame count, and all collected
 * warnings. Used to decide whether to allow conversion and what warnings to
 * display to the user.
 *
 * @example
 * const result: ValidationResult = {
 *   isValid: true,
 *   format: 'mp4',
 *   codec: 'h264',
 *   duration: 8.5,
 *   estimatedFrames: 255,
 *   warnings: [
 *     {
 *       severity: 'info',
 *       message: 'Video format is supported',
 *       requiresConfirmation: false
 *     }
 *   ]
 * };
 */
export interface ValidationResult {
  /** Whether video passed validation and can be converted */
  isValid: boolean;
  /** Detected video format (e.g., 'mp4', 'webm', 'mov') */
  format?: string;
  /** Detected video codec (e.g., 'h264', 'vp9', 'hevc') */
  codec?: string;
  /** Video duration in seconds */
  duration?: number;
  /** Estimated frame count for conversion planning */
  estimatedFrames?: number;
  /** All validation warnings (info, warning, error) */
  warnings: ValidationWarning[];
}
