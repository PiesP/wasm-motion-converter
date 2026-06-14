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
import { getErrorMessage } from '@utils/error-utils';
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

    const outputBlob = blob as ConversionOutputBlob;
    outputBlob.encoderBackendUsed = 'ffmpeg';

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

import { logger } from '@utils/logger';

function isCancellationError(error: unknown): boolean {
  const msg = getErrorMessage(error).toLowerCase();
  return msg.includes('cancelled by user') || msg.includes('called ffmpeg.terminate()');
}

export function cleanup(): void {
  resetTrackedFrames();
}

export function scheduleWorkerPoolIdleCleanup(): void {
  // No-op: worker pool removed
}
