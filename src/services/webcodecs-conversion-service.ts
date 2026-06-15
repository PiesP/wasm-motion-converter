// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * FFmpeg Direct Conversion Service
 *
 * Path planner selected this route for WebCodecs-native codecs.
 * Despite the "gpu" path label, this service delegates to FFmpeg
 * for the full decode+encode pipeline. The path planner chose this
 * route because the codec is WebCodecs-native, but the actual
 * conversion goes through FFmpeg directly (no WebCodecs decode).
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
 * Convert video using FFmpeg direct path.
 * The path planner selected this route because the codec is WebCodecs-native,
 * but the actual conversion uses FFmpeg for the full decode+encode pipeline.
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

    logger.error('conversion', 'FFmpeg direct path failed', {
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
