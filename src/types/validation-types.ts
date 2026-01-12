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
