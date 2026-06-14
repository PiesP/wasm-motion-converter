// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * WebCodecs Conversion Service — Streaming Unified
 *
 * All GPU conversion paths use a unified streaming pipeline:
 *
 *   WebCodecs decode → onFrame writes raw RGBA to FFmpeg VFS
 *     → FFmpeg encodes from VFS (GIF palette or WebP libwebp)
 *
 * No intermediate frame arrays are held in memory.
 * Each frame is decoded, written to VFS, and its GPU resources released
 * before the next frame begins.
 *
 * Supported formats: GIF, WebP
 * Fallback: If WebCodecs is unavailable, falls back to FFmpeg direct (CPU path).
 */

import { ffmpegService } from '@services/cpu-path/ffmpeg-pipeline-service';
import { createThrottledProgressReporter } from '@services/webcodecs/conversion/progress-reporting-service';
import { WebCodecsDecoderService } from '@services/webcodecs-decoder-service';
import type { ConversionOptions, ConversionOutputBlob, VideoMetadata } from '@t/conversion-types';
import { QUALITY_PRESETS } from '@utils/constants';
import { getErrorMessage } from '@utils/error-utils';
import { FFMPEG_INTERNALS } from '@utils/ffmpeg-constants';
import { logger } from '@utils/logger';
import { releaseDecodedFrame, resetTrackedFrames } from '@utils/memory-monitor';
import { getOptimalFPS } from '@utils/quality-optimizer';

// ── Streaming frame writer ───────────────────────────────────────────────

interface StreamingDecodeResult {
  frameCount: number;
  width: number;
  height: number;
  fps: number;
  duration: number;
  /** Concatenated raw RGBA frames — single buffer */
  rawBuffer: Uint8Array;
}

/**
 * Decode video frames via WebCodecs and write each frame's raw RGBA data
 * directly into a pre-allocated buffer in a single pass.
 *
 * First frame triggers buffer allocation (we need dimensions).
 * Each subsequent frame is written immediately and GPU resources released.
 */
async function decodeToRawBuffer(params: {
  file: File;
  targetFps: number;
  scale: number;
  metadata?: VideoMetadata;
  options: ConversionOptions;
  abortSignal?: AbortSignal;
  onProgress?: (current: number, total: number) => void;
}): Promise<StreamingDecodeResult> {
  const { file, targetFps, scale, metadata, options, abortSignal, onProgress } = params;

  const decoder = new WebCodecsDecoderService();
  let frameIndex = 0;
  let rawBuffer: Uint8Array | null = null;
  let writeOffset = 0;
  let width = 0;
  let height = 0;

  const decodeResult = await decoder.decodeToFrames({
    file,
    targetFps,
    scale,
    frameFormat: 'rgba',
    frameQuality: FFMPEG_INTERNALS.WEBCODECS.FRAME_QUALITY,
    framePrefix: FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_PREFIX,
    frameDigits: FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_DIGITS,
    frameStartNumber: FFMPEG_INTERNALS.WEBCODECS.FRAME_START_NUMBER,
    trimStartSeconds: options.trimStart,
    captureMode: 'auto',
    codec: metadata?.codec,
    quality: options.quality,
    shouldCancel: abortSignal
      ? () => abortSignal.aborted
      : () => ffmpegService.isCancellationRequested(),
    onProgress,
    onFrame: async (frame) => {
      if (abortSignal?.aborted) throw new Error('Conversion cancelled by user');
      if (!frame.imageData) throw new Error('WebCodecs did not provide raw frame data.');

      const w = frame.imageData.width;
      const h = frame.imageData.height;
      const frameBytes = w * h * 4;

      // First frame: allocate buffer for all frames
      if (rawBuffer === null) {
        width = w;
        height = h;
        // Estimate total frames from duration and fps
        const estimatedFrames = Math.max(10, Math.ceil((metadata?.duration ?? 10) * targetFps));
        rawBuffer = new Uint8Array(frameBytes * estimatedFrames);
      }

      // Grow buffer if estimate was too low
      if (writeOffset + frameBytes > rawBuffer.length) {
        const grown = new Uint8Array(rawBuffer.length * 2);
        grown.set(rawBuffer);
        rawBuffer = grown;
      }

      // Copy frame data and release GPU resource immediately
      const rgba = new Uint8Array(frame.imageData.data.buffer);
      rawBuffer.set(rgba, writeOffset);
      writeOffset += frameBytes;
      frameIndex++;

      releaseDecodedFrame(frameBytes);
    },
  });

  if (frameIndex < 1) {
    throw new Error('WebCodecs decode produced no frames.');
  }

  // Trim buffer to actual size
  const finalBuffer = rawBuffer!.slice(0, writeOffset);

  return {
    frameCount: frameIndex,
    width,
    height,
    fps: targetFps,
    duration: decodeResult.duration,
    rawBuffer: finalBuffer,
  };
}

// ── Main conversion entry point ─────────────────────────────────────────

export async function convert(
  file: File,
  format: 'gif' | 'webp',
  options: ConversionOptions,
  metadata?: VideoMetadata,
  abortSignal?: AbortSignal
): Promise<ConversionOutputBlob> {
  if (abortSignal) {
    const { throwIfAborted } = await import('@utils/cancellation-context');
    throwIfAborted(abortSignal);
  }

  const { quality, scale } = options;
  const settings = format === 'gif' ? QUALITY_PRESETS.gif[quality] : QUALITY_PRESETS.webp[quality];
  const targetFps =
    metadata?.framerate && metadata.framerate > 0
      ? getOptimalFPS(metadata.framerate, quality, format)
      : 'fps' in settings
        ? settings.fps
        : 15;

  const shouldCancel = abortSignal
    ? () => abortSignal.aborted
    : () => ffmpegService.isCancellationRequested();

  const throwIfCancelled = (): void => {
    if (shouldCancel()) throw new Error('Conversion cancelled by user');
  };

  // Ensure FFmpeg is initialized
  if (!ffmpegService.isLoaded()) {
    await ffmpegService.initialize();
  }
  throwIfCancelled();

  // Setup progress reporting
  const decodeStart = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.DECODE_START;
  const decodeEnd = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.DECODE_END;

  const decodeReporter = createThrottledProgressReporter({
    startPercent: decodeStart,
    endPercent: decodeEnd,
    tickIntervalMs: 400,
    initialStatusPrefix: 'Decoding with WebCodecs...',
    throwIfCancelled,
    reportProgress: (p: number) => ffmpegService.reportProgress(p),
    reportStatus: (s: string) => ffmpegService.reportStatus(s),
  });

  ffmpegService.beginExternalConversion(metadata, quality, format, {
    enableLogSilenceCheck: false,
  });

  let externalEnded = false;
  const endConversion = () => {
    if (externalEnded) return;
    ffmpegService.endExternalConversion();
    externalEnded = true;
  };

  try {
    // ── Streaming decode → raw buffer ────────────────────────────────
    ffmpegService.reportStatus('Decoding with WebCodecs...');
    ffmpegService.reportProgress(decodeStart);

    let frameCount = 0;
    let width = 0;
    let height = 0;
    let duration = 0;
    let rawBuffer: Uint8Array | null = null;

    try {
      const result = await decodeToRawBuffer({
        file,
        targetFps,
        scale,
        metadata,
        options,
        abortSignal,
        onProgress: decodeReporter.report,
      });
      frameCount = result.frameCount;
      width = result.width;
      height = result.height;
      duration = result.duration;
      rawBuffer = result.rawBuffer;
    } catch (decodeError) {
      if (abortSignal?.aborted || isCancellationError(decodeError)) throw decodeError;

      logger.warn(
        'conversion',
        'WebCodecs streaming decode failed, falling back to FFmpeg direct',
        {
          format,
          codec: metadata?.codec,
          error: getErrorMessage(decodeError),
        }
      );

      // Fallback: FFmpeg direct (CPU path)
      endConversion();
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
      (blob as ConversionOutputBlob).encoderBackendUsed = 'ffmpeg';
      return blob as ConversionOutputBlob;
    }

    ffmpegService.reportProgress(decodeEnd);
    throwIfCancelled();

    // ── Write raw buffer to VFS and encode via FFmpeg ───────────────
    const rawFileName = 'frames.rgba';
    await ffmpegService.writeVirtualFile(rawFileName, rawBuffer!);

    ffmpegService.reportStatus(`Encoding ${format.toUpperCase()} with FFmpeg...`);
    const outputBlob = await ffmpegService.encodeFrameSequence({
      format,
      options: { quality, scale },
      frameCount,
      fps: targetFps,
      durationSeconds: duration,
      frameFiles: [],
      frameInput: {
        kind: 'rawvideo',
        fileName: rawFileName,
        width,
        height,
        pixelFormat: 'rgba',
      },
    });

    if (shouldCancel()) throw new Error('Conversion cancelled by user');

    const completionProgress =
      format === 'gif'
        ? FFMPEG_INTERNALS.PROGRESS.GIF.COMPLETE
        : FFMPEG_INTERNALS.PROGRESS.WEBP.COMPLETE;
    ffmpegService.reportProgress(completionProgress);

    const outputBlobWithMetadata = outputBlob as ConversionOutputBlob;
    outputBlobWithMetadata.encoderBackendUsed = 'ffmpeg-rawvideo-streaming';
    outputBlobWithMetadata.wasTranscoded = true;

    endConversion();
    return outputBlobWithMetadata;
  } catch (error) {
    if (abortSignal?.aborted || isCancellationError(error)) {
      throw error;
    }

    logger.error('conversion', 'Streaming conversion failed', {
      format,
      codec: metadata?.codec,
      error: getErrorMessage(error),
    });

    // Last-resort fallback: FFmpeg direct
    try {
      endConversion();
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
      (blob as ConversionOutputBlob).encoderBackendUsed = 'ffmpeg';
      return blob as ConversionOutputBlob;
    } catch (_fallbackError) {
      throw error; // Throw original error
    }
  } finally {
    try {
      endConversion();
    } catch (endError) {
      logger.warn('conversion', 'Error during endConversion cleanup', {
        error: getErrorMessage(endError),
      });
    }

    if (!externalEnded) {
      try {
        ffmpegService.getMonitoring()?.forceCleanupAll();
      } catch (monitoringError) {
        logger.warn('conversion', 'Force cleanup failed (non-critical)', {
          error: getErrorMessage(monitoringError),
        });
      }
    }

    resetTrackedFrames();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function isCancellationError(error: unknown): boolean {
  const msg = getErrorMessage(error).toLowerCase();
  return msg.includes('cancelled by user') || msg.includes('called ffmpeg.terminate()');
}

export function cleanup(): void {
  resetTrackedFrames();
}

export function scheduleWorkerPoolIdleCleanup(): void {
  // No-op: worker pool removed, all encoding via FFmpeg VFS
}
