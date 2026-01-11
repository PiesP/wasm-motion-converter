/**
 * Conversion Types
 *
 * Type definitions for video conversion operations, including formats, quality
 * settings, conversion results, error handling, and performance warnings.
 * These types are used throughout the conversion pipeline to ensure type safety.
 */

/**
 * Supported output formats
 *
 * - `gif`: Animated GIF format (widely supported, larger file sizes)
 * - `webp`: Animated WebP format (better compression, modern browsers)
 * - `mp4`: MP4 video format (H.264, best compression, requires WebCodecs support)
 *
 * @example
 * const format: ConversionFormat = 'gif';
 */
export type ConversionFormat = 'gif' | 'webp' | 'mp4';

/**
 * Conversion quality levels
 *
 * - `low`: Fastest conversion, lower quality (e.g., fewer colors for GIF)
 * - `medium`: Balanced quality and speed
 * - `high`: Best quality, slower conversion (e.g., full color palette for GIF)
 *
 * @example
 * const quality: ConversionQuality = 'high';
 */
export type ConversionQuality = 'low' | 'medium' | 'high';

/**
 * Video scaling factor
 *
 * - `0.5`: Half size (25% of original pixels)
 * - `0.75`: Three-quarters size (56% of original pixels)
 * - `1.0`: Original size (100% of original pixels)
 *
 * Scaling down can significantly reduce conversion time and output file size.
 *
 * @example
 * const scale: ConversionScale = 0.75;
 */
export type ConversionScale = 0.5 | 0.75 | 1.0;

/**
 * User-selected conversion settings
 *
 * Complete configuration for video conversion including output format,
 * quality level, and scaling factor. These settings are persisted to
 * localStorage and used for all conversions.
 *
 * @example
 * const settings: ConversionSettings = {
 *   format: 'gif',
 *   quality: 'high',
 *   scale: 1.0
 * };
 */
export interface ConversionSettings {
  /** Output format (gif or webp) */
  format: ConversionFormat;
  /** Quality level (low, medium, high) */
  quality: ConversionQuality;
  /** Scaling factor (0.5, 0.75, 1.0) */
  scale: ConversionScale;
}

/**
 * Conversion operation options
 *
 * Extended options passed to conversion functions. Includes quality and scale
 * from settings, plus optional metadata for adaptive behavior (e.g., timeout
 * calculation based on duration).
 *
 * @example
 * const options: ConversionOptions = {
 *   quality: 'high',
 *   scale: 1.0,
 *   duration: 5.0 // 5 seconds video
 * };
 */
export interface ConversionOptions {
  /** Quality level (low, medium, high) */
  quality: ConversionQuality;
  /** Scaling factor (0.5, 0.75, 1.0) */
  scale: ConversionScale;
  /** Video duration in seconds (for adaptive timeout calculation) */
  duration?: number;
}

/**
 * Optional metadata attached to output blobs for UI display
 */
export interface ConversionBlobMetadata {
  /** Whether video was transcoded (re-encoded) */
  wasTranscoded?: boolean;
  /** Original video codec */
  originalCodec?: string;
}

/**
 * Output blob with optional conversion metadata
 */
export type ConversionOutputBlob = Blob & ConversionBlobMetadata;

/**
 * Conversion result with metadata
 *
 * Complete record of a successful conversion including the output blob,
 * original file information, conversion settings, and performance metrics.
 * Results are stored in conversion-store for download and preview.
 *
 * @example
 * const result: ConversionResult = {
 *   id: crypto.randomUUID(),
 *   outputBlob: new Blob([...], { type: 'image/gif' }),
 *   originalName: 'video.mp4',
 *   originalSize: 1024000,
 *   createdAt: Date.now(),
 *   settings: { format: 'gif', quality: 'high', scale: 1.0 },
 *   conversionDurationSeconds: 12.5,
 *   wasTranscoded: true,
 *   originalCodec: 'h264'
 * };
 */
export interface ConversionResult {
  /** Unique identifier (UUID) */
  id: string;
  /** Converted video blob */
  outputBlob: ConversionOutputBlob;
  /** Original video filename */
  originalName: string;
  /** Original file size in bytes */
  originalSize: number;
  /** Timestamp when conversion completed */
  createdAt: number;
  /** Settings used for this conversion */
  settings: ConversionSettings;
  /** Time taken to convert (seconds) */
  conversionDurationSeconds?: number;
  /** Whether video was transcoded (re-encoded) */
  wasTranscoded?: boolean;
  /** Original video codec */
  originalCodec?: string;
}

/**
 * Conversion error classification
 *
 * Categories of errors that can occur during conversion, used to provide
 * context-specific error messages and suggestions to the user.
 *
 * - `timeout`: Conversion exceeded time limit
 * - `memory`: Out of memory or memory limit reached
 * - `format`: Unsupported video format
 * - `codec`: Unsupported video codec
 * - `general`: Other errors (catch-all)
 *
 * @example
 * const errorType: ConversionErrorType = 'timeout';
 */
export type ConversionErrorType = 'timeout' | 'memory' | 'format' | 'codec' | 'general';

/**
 * Detailed error context for conversion failures
 *
 * Extended error information including type classification, original error
 * message, timestamp, suggested resolution, and diagnostic data (settings,
 * FFmpeg logs, conversion phase). Used to provide user-friendly error
 * messages and debugging information.
 *
 * @example
 * const context: ErrorContext = {
 *   type: 'timeout',
 *   originalError: 'Conversion exceeded 60s timeout',
 *   timestamp: Date.now(),
 *   suggestion: 'Try a shorter video or reduce quality settings',
 *   conversionSettings: { format: 'gif', quality: 'high', scale: 1.0 },
 *   ffmpegLogs: ['[info] Processing...', '[error] Timeout'],
 *   phase: 'encoding'
 * };
 */
export interface ErrorContext {
  /** Error type classification */
  type: ConversionErrorType;
  /** Original error message */
  originalError: string;
  /** When error occurred (milliseconds since epoch) */
  timestamp: number;
  /** User-friendly suggestion for resolution */
  suggestion?: string;
  /** Settings used for failed conversion */
  conversionSettings?: ConversionSettings;
  /** FFmpeg log output for debugging */
  ffmpegLogs?: string[];
  /** Which phase of conversion failed (e.g., 'decoding', 'encoding') */
  phase?: string;
}

/**
 * Extracted video metadata
 *
 * Video file properties extracted during analysis phase. Used to validate
 * the video, calculate timeouts, detect performance issues, and provide
 * information to the user.
 *
 * @example
 * const metadata: VideoMetadata = {
 *   width: 1920,
 *   height: 1080,
 *   duration: 10.5,
 *   codec: 'h264',
 *   framerate: 30,
 *   bitrate: 5000000
 * };
 */
export interface VideoMetadata {
  /** Video width in pixels */
  width: number;
  /** Video height in pixels */
  height: number;
  /** Video duration in seconds */
  duration: number;
  /** Video codec (e.g., 'h264', 'vp9', 'hevc') */
  codec: string;
  /** Frame rate (frames per second) */
  framerate: number;
  /** Video bitrate (bits per second) */
  bitrate: number;
}

/**
 * Performance warning types
 *
 * Categories of potential performance issues detected during video analysis.
 *
 * - `fileSize`: File size exceeds recommended limits
 * - `resolution`: Resolution too high for efficient conversion
 * - `duration`: Video duration too long
 * - `codec`: Codec requires expensive transcoding
 *
 * @example
 * const type: PerformanceWarningType = 'resolution';
 */
export type PerformanceWarningType = 'fileSize' | 'resolution' | 'duration' | 'codec';

/**
 * Performance warning severity levels
 *
 * - `critical`: Conversion likely to fail or take very long (>10min)
 * - `high`: Significant performance impact (>5min estimated)
 * - `warning`: Noticeable slowdown (>2min estimated)
 *
 * @example
 * const severity: PerformanceWarningSeverity = 'high';
 */
export type PerformanceWarningSeverity = 'critical' | 'high' | 'warning';

/**
 * Performance warning with recommendation
 *
 * Alert about potential performance issues with suggested mitigation.
 * Displayed to the user before conversion starts to manage expectations
 * and suggest optimizations.
 *
 * @example
 * const warning: PerformanceWarning = {
 *   type: 'resolution',
 *   severity: 'high',
 *   message: 'High resolution (4K) will take longer to convert',
 *   recommendation: 'Consider using 0.5 or 0.75 scale to speed up conversion'
 * };
 */
export interface PerformanceWarning {
  /** Warning category */
  type: PerformanceWarningType;
  /** Severity level */
  severity: PerformanceWarningSeverity;
  /** User-friendly warning message */
  message: string;
  /** Suggested action to improve performance */
  recommendation: string;
}
