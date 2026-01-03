import type {
  ConversionScale,
  ConversionSettings,
  PerformanceWarning,
  VideoMetadata,
} from '../types/conversion-types';
import {
  COMPLEX_CODECS,
  WARN_DURATION_SECONDS,
  WARN_FILE_SIZE,
  WARN_FILE_SIZE_CRITICAL,
  WARN_FILE_SIZE_HIGH,
  WARN_RESOLUTION_PIXELS,
} from '../utils/constants';
import { formatBytes } from '../utils/format-bytes';
import { formatDuration } from '../utils/format-duration';

export function checkPerformance(file: File, metadata: VideoMetadata): PerformanceWarning[] {
  const warnings: PerformanceWarning[] = [];

  if (file.size > WARN_FILE_SIZE_CRITICAL) {
    warnings.push({
      type: 'fileSize',
      severity: 'error',
      message: `File size is ${formatBytes(file.size)} (over 300MB)`,
      recommendation:
        'Large file may cause browser memory issues. Strongly recommend 50% scale or trim video length',
    });
  } else if (file.size > WARN_FILE_SIZE_HIGH) {
    warnings.push({
      type: 'fileSize',
      severity: 'warning',
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
      severity: 'warning',
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

const preferLowerScale = (current: ConversionScale, target: ConversionScale): ConversionScale =>
  current < target ? current : target;

export function getRecommendedSettings(
  file: File,
  metadata: VideoMetadata,
  current: ConversionSettings
): ConversionSettings | null {
  let changed = false;
  const next: ConversionSettings = { ...current };
  const pixels = metadata.width * metadata.height;

  if (file.size > WARN_FILE_SIZE_HIGH || metadata.duration > WARN_DURATION_SECONDS) {
    if (next.quality !== 'low') {
      next.quality = 'low';
      changed = true;
    }
  }

  if (file.size > WARN_FILE_SIZE_CRITICAL || pixels > WARN_RESOLUTION_PIXELS * 2) {
    const newScale = preferLowerScale(next.scale, 0.5);
    if (newScale !== next.scale) {
      next.scale = newScale;
      changed = true;
    }
  } else if (pixels > WARN_RESOLUTION_PIXELS) {
    const newScale = preferLowerScale(next.scale, 0.75);
    if (newScale !== next.scale) {
      next.scale = newScale;
      changed = true;
    }
  }

  return changed ? next : null;
}
