// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * WebCodecs Conversion Service — Streaming Unified
 *
 * GPU path selection (WebCodecs-native codec detection) routes to
 * FFmpeg direct encode. The path planner already selected the optimal
 * route; FFmpeg handles the full pipeline internally.
 *
 * Supported formats: GIF, WebP
 */

import { ffmpegService } from '@services/cpu-path/ffmpeg-pipeline-service';
import type { ConversionOptions, ConversionOutputBlob, VideoMetadata } from '@t/conversion-types';
import { createConversionOutputBlob } from '@t/conversion-types';
import { isCancellationError } from '@utils/cancellation-context';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { resetTrackedFrames } from '@utils/memory-monitor';

/**
 * Convert video using GPU-selected FFmpeg path.
 * The path planner already verified WebCodecs is viable for this codec.
 * FFmpeg handles decode + encode internally (streaming built-in).
 */
export async function convert(
  file: File,
  format: 'gif' | 'webp',
  options: ConversionOptions,
  metadata?: VideoMetadata,
  abortSignal?: AbortSignal
): Promise<ConversionOutputBlob> {
  if (abortSignal?.aborted) {
    throw new Error('Conversion cancelled by user');
  }

  if (!ffmpegService.isLoaded()) {
    await ffmpegService.initialize();
  }

  ffmpegService.beginExternalConversion(metadata, options.quality, format, {
    enableLogSilenceCheck: false,
  });

  let externalEnded = false;
  const endConversion = () => {
    if (externalEnded) return;
    ffmpegService.endExternalConversion();
    externalEnded = true;
  };

  try {
    const blob =
      format === 'gif'
        ? await ffmpegService.convertToGIF(
            file,
            options,
            metadata,
            undefined,
            undefined,
            abortSignal
          )
        : await ffmpegService.convertToWebP(
            file,
            options,
            metadata,
            undefined,
            undefined,
            abortSignal
          );

    const outputBlob = createConversionOutputBlob(blob, { encoderBackendUsed: 'ffmpeg' });

    endConversion();
    return outputBlob;
  } catch (error) {
    if (abortSignal?.aborted || isCancellationError(error)) {
      throw error;
    }

    logger.error('conversion', 'GPU path failed', {
      format,
      codec: metadata?.codec,
      error: getErrorMessage(error),
    });
    throw error;
  } finally {
    try {
      endConversion();
    } catch {
      /* non-fatal */
    }
    resetTrackedFrames();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

export function cleanup(): void {
  resetTrackedFrames();
}
