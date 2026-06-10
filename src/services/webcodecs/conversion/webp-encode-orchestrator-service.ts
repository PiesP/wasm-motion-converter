// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import { muxWebPFramesStreaming } from '@services/webcodecs/webp/mux-webp-frames-service';
import type { EncoderFrame, VideoMetadata } from '@t/conversion-types';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

type WebPEncodeParams = {
  frames: EncoderFrame[];
  width: number;
  height: number;
  fps: number;
  requestedTargetFpsForDuration: number;
  captureDurationSeconds: number;
  quality: 'low' | 'medium' | 'high';
  frameTimestampsForMuxer: number[];
  metadata?: VideoMetadata;
  codec?: string;
  onProgress: (current: number, total: number) => void;
  shouldCancel: () => boolean;
  canEncodeWebPFrames: () => Promise<boolean>;
  setStatusPrefix: (prefix: string) => void;
  encodeWithFFmpegFallback: (reason: string) => Promise<Blob>;
};

type WebPEncodeResult = {
  blob: Blob;
  encoderBackendUsed: string;
};

const logMuxerSkip = (reason: string): void => {
  logger.warn('conversion', 'Skipping WebP muxer path (preflight failed), using FFmpeg fallback', {
    reason,
  });
};

const shouldPropagateMuxerError = (message: string, shouldCancel: () => boolean): boolean => {
  if (message.includes('cancelled by user')) {
    return true;
  }
  if (shouldCancel() && message.includes('called FFmpeg.terminate()')) {
    return true;
  }
  return false;
};

export async function encodeWebPWithMuxFallback(
  params: WebPEncodeParams
): Promise<WebPEncodeResult> {
  const {
    frames,
    width,
    height,
    fps,
    captureDurationSeconds,
    quality,
    frameTimestampsForMuxer,
    metadata,
    codec,
    onProgress,
    shouldCancel,
    canEncodeWebPFrames,
    setStatusPrefix,
    encodeWithFFmpegFallback,
  } = params;

  const canEncode = await canEncodeWebPFrames();
  if (!canEncode) {
    const reason = 'Canvas WebP encoding is not supported in this browser';
    logMuxerSkip(reason);

    const blob = await encodeWithFFmpegFallback(reason);
    return { blob, encoderBackendUsed: 'ffmpeg' };
  }

  logger.info('conversion', 'Using streaming WebP encode → mux pipeline');

  // Convert EncoderFrame[] to ImageData[] first (required for streaming encoder)
  // This is the GPU→CPU readback step that was always needed
  const { convertFramesToImageData } = await import('@services/encoders/frame-converter-service');

  setStatusPrefix('Preparing frames...');
  const imageDataFrames = await convertFramesToImageData(
    frames,
    width,
    height,
    undefined,
    shouldCancel
  );

  // Release GPU resources immediately after conversion
  for (const frame of frames) {
    if (typeof ImageBitmap !== 'undefined' && frame instanceof ImageBitmap) {
      try {
        frame.close();
      } catch {
        /* ignore */
      }
    }
    if (typeof VideoFrame !== 'undefined' && frame instanceof VideoFrame) {
      try {
        frame.close();
      } catch {
        /* ignore */
      }
    }
  }

  let fallbackReason = 'WebP streaming encode failed';

  try {
    setStatusPrefix('Encoding WebP...');

    // Single-pass: encode → strip container → ANMF chunk → assemble RIFF
    const blob = await muxWebPFramesStreaming({
      frames: imageDataFrames,
      timestamps: frameTimestampsForMuxer.slice(0, imageDataFrames.length),
      width,
      height,
      fps,
      quality,
      metadata,
      durationSeconds: captureDurationSeconds,
      codec,
      onProgress,
      shouldCancel,
    });

    if (!blob) {
      fallbackReason = 'WebP streaming encode produced no output';
      logger.warn('conversion', fallbackReason, {
        frameCount: imageDataFrames.length,
      });
      const fallbackBlob = await encodeWithFFmpegFallback(fallbackReason);
      return { blob: fallbackBlob, encoderBackendUsed: 'ffmpeg' };
    }

    return { blob, encoderBackendUsed: 'webp-muxer-streaming' };
  } catch (error) {
    const errorMessage = getErrorMessage(error);

    if (shouldPropagateMuxerError(errorMessage, shouldCancel)) {
      throw error;
    }

    fallbackReason = errorMessage;
    logger.warn('conversion', 'WebP streaming encode failed, using FFmpeg fallback', {
      error: errorMessage,
      frameCount: imageDataFrames.length,
    });

    const fallbackBlob = await encodeWithFFmpegFallback(fallbackReason);
    return { blob: fallbackBlob, encoderBackendUsed: 'ffmpeg' };
  }
}
