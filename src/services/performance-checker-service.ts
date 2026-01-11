import {
  COMPLEX_CODECS,
  WARN_DURATION_SECONDS,
  WARN_FILE_SIZE,
  WARN_FILE_SIZE_CRITICAL,
  WARN_FILE_SIZE_HIGH,
  WARN_RESOLUTION_PIXELS,
} from '@utils/constants';
import { formatBytes } from '@utils/format-bytes';
import { formatDuration } from '@utils/format-duration';

import type {
  ConversionScale,
  ConversionSettings,
  PerformanceWarning,
  VideoMetadata,
} from '@t/conversion-types';

/**
 * Scale factor: 50% of original resolution
 */
const SCALE_50_PERCENT = 0.5;

/**
 * Scale factor: 75% of original resolution
 */
const SCALE_75_PERCENT = 0.75;

/**
 * Resolution multiplier for GIF-specific scale recommendations
 */
const GIF_RESOLUTION_MULTIPLIER = 1.5;

/**
 * Resolution multiplier for critical scale recommendations
 */
const CRITICAL_RESOLUTION_MULTIPLIER = 2;

/**
 * Check video file and metadata for performance issues
 * Analyzes file size, resolution, duration, and codec complexity
 * Returns warnings with severity levels and actionable recommendations
 *
 * @param file - Input video file
 * @param metadata - Video metadata (width, height, duration, codec)
 * @returns Array of performance warnings with recommendations
 *
 * @example
 * const warnings = checkPerformance(file, metadata);
 * warnings.forEach(w => console.log(`${w.severity}: ${w.message}`));
 */
export function checkPerformance(file: File, metadata: VideoMetadata): PerformanceWarning[] {
  const warnings: PerformanceWarning[] = [];

  if (file.size > WARN_FILE_SIZE_CRITICAL) {
    warnings.push({
      type: 'fileSize',
      severity: 'critical',
      message: `File size is ${formatBytes(file.size)} (over 300MB)`,
      recommendation:
        'Large file may cause browser memory issues. Strongly recommend 50% scale or trim video length',
    });
  } else if (file.size > WARN_FILE_SIZE_HIGH) {
    warnings.push({
      type: 'fileSize',
      severity: 'high',
      message: `File size is ${formatBytes(file.size)} (over 200MB)`,
      recommendation:
        'Consider using "Low" quality preset to reduce memory usage and improve conversion speed',
    });
  } else if (file.size > WARN_FILE_SIZE) {
    warnings.push({
      type: 'fileSize',
      severity: 'warning',
      message: `File size is ${formatBytes(file.size)} (over 100MB)`,
      recommendation: 'Consider trimming video or reducing resolution',
    });
  }

  if (metadata.width * metadata.height > WARN_RESOLUTION_PIXELS) {
    warnings.push({
      type: 'resolution',
      severity: 'high',
      message: `Resolution is ${metadata.width}x${metadata.height} (over 1080p)`,
      recommendation: 'Select 50% or 75% scale to reduce processing time',
    });
  }

  if (metadata.duration > WARN_DURATION_SECONDS) {
    warnings.push({
      type: 'duration',
      severity: 'warning',
      message: `Video is ${formatDuration(metadata.duration)} (over 30 seconds)`,
      recommendation: 'Longer videos produce large files and slow conversions',
    });
  }

  if (COMPLEX_CODECS.includes(metadata.codec.toLowerCase())) {
    warnings.push({
      type: 'codec',
      severity: 'warning',
      message: `Video uses ${metadata.codec} codec (complex compression)`,
      recommendation: 'Conversion may be slower than H.264 videos',
    });
  }

  return warnings;
}

/**
 * Select the lower of two scale values
 * Used to ensure scale recommendations don't increase current scale
 *
 * @param current - Current scale value
 * @param target - Target scale value
 * @returns The lower of the two scale values
 */
const preferLowerScale = (current: ConversionScale, target: ConversionScale): ConversionScale =>
  current < target ? current : target;

/**
 * Generate recommended settings based on performance warnings
 * Automatically adjusts quality and scale settings for optimal performance
 * Returns null if no changes are recommended
 *
 * @param file - Input video file
 * @param metadata - Video metadata (width, height, duration, codec)
 * @param current - Current conversion settings
 * @returns Updated settings if changes recommended, null otherwise
 *
 * @example
 * const recommended = getRecommendedSettings(file, metadata, currentSettings);
 * if (recommended) {
 *   console.log(`Recommend quality: ${recommended.quality}, scale: ${recommended.scale}`);
 * }
 */
export function getRecommendedSettings(
  file: File,
  metadata: VideoMetadata,
  current: ConversionSettings
): ConversionSettings | null {
  let changed = false;
  const next: ConversionSettings = { ...current };
  const pixels = metadata.width * metadata.height;
  const isGif = current.format === 'gif';

  if (file.size > WARN_FILE_SIZE_HIGH || metadata.duration > WARN_DURATION_SECONDS) {
    if (next.quality !== 'low') {
      next.quality = 'low';
      changed = true;
    }
  }

  if (isGif && metadata.duration > WARN_DURATION_SECONDS && next.quality !== 'low') {
    next.quality = 'low';
    changed = true;
  }

  if (
    file.size > WARN_FILE_SIZE_CRITICAL ||
    pixels > WARN_RESOLUTION_PIXELS * CRITICAL_RESOLUTION_MULTIPLIER
  ) {
    const newScale = preferLowerScale(next.scale, SCALE_50_PERCENT);
    if (newScale !== next.scale) {
      next.scale = newScale;
      changed = true;
    }
  } else if (pixels > WARN_RESOLUTION_PIXELS) {
    const newScale = preferLowerScale(next.scale, SCALE_75_PERCENT);
    if (newScale !== next.scale) {
      next.scale = newScale;
      changed = true;
    }
  }

  if (isGif && pixels > WARN_RESOLUTION_PIXELS * GIF_RESOLUTION_MULTIPLIER) {
    const newScale = preferLowerScale(next.scale, SCALE_50_PERCENT);
    if (newScale !== next.scale) {
      next.scale = newScale;
      changed = true;
    }
  }

  return changed ? next : null;
}
