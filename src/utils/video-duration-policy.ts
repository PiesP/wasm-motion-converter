// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { DurationValidationResult, ValidationWarning } from '@t/validation-types';
import { DEFAULT_FPS, WEBP_MAX_DURATION_MS, WEBP_MAX_FRAMES } from './constants';

export function estimateFrameCount(durationMs: number, fps = DEFAULT_FPS): number {
  return Math.ceil((durationMs / 1000) * fps);
}

export function assessVideoDuration(
  duration: number,
  targetFormat: string,
  fps = DEFAULT_FPS
): DurationValidationResult {
  const estimatedFrames = estimateFrameCount(duration, fps);
  const warnings: ValidationWarning[] = [];

  if (targetFormat === 'webp') {
    if (duration > WEBP_MAX_DURATION_MS) {
      warnings.push({
        severity: 'warning',
        message: `Video duration (${(duration / 1000).toFixed(
          1
        )}s) exceeds WebP safety limit (${WEBP_MAX_DURATION_MS / 1000}s)`,
        details: 'Very long WebP conversions may experience performance or file size issues',
        suggestedAction: 'Consider trimming the video for better results',
        requiresConfirmation: false,
      });
    }

    if (estimatedFrames > WEBP_MAX_FRAMES) {
      warnings.push({
        severity: 'warning',
        message: `Estimated frame count (${estimatedFrames}) exceeds WebP safety limit (${WEBP_MAX_FRAMES} frames)`,
        details: 'High frame counts may cause performance or memory issues during encoding',
        suggestedAction: 'Consider reducing video duration or framerate',
        requiresConfirmation: false,
      });
    }
  }

  return {
    valid: warnings.every((warning) => warning.severity !== 'error'),
    duration,
    estimatedFrames,
    warnings,
  };
}
