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
  /** aHash dedup stats: frames skipped (0 if FFmpeg fallback was used) */
  dedupSkippedFrames?: number;
  /** aHash dedup stats: total frames evaluated (0 if FFmpeg fallback was used) */
  dedupTotalFrames?: number;
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

  let fallbackReason = 'WebP streaming encode failed';

  try {
    setStatusPrefix('Encoding WebP...');

    // Single-pass: encode → strip container → ANMF chunk → assemble RIFF
    const streamingResult = await muxWebPFramesStreaming({
      frames: frames,
      timestamps: frameTimestampsForMuxer.slice(0, frames.length),
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

    if (!streamingResult.blob) {
      fallbackReason = 'WebP streaming encode produced no output';
      logger.warn('conversion', fallbackReason, {
        frameCount: frames.length,
      });
      const fallbackBlob = await encodeWithFFmpegFallback(fallbackReason);
      return { blob: fallbackBlob, encoderBackendUsed: 'ffmpeg', dedupSkippedFrames: streamingResult.skippedFrames, dedupTotalFrames: streamingResult.totalFrames };
    }

    return { blob: streamingResult.blob, encoderBackendUsed: 'webp-muxer-streaming', dedupSkippedFrames: streamingResult.skippedFrames, dedupTotalFrames: streamingResult.totalFrames };
  } catch (error) {
    const errorMessage = getErrorMessage(error);

    if (shouldPropagateMuxerError(errorMessage, shouldCancel)) {
      throw error;
    }

    fallbackReason = errorMessage;
    logger.warn('conversion', 'WebP streaming encode failed, using FFmpeg fallback', {
      error: errorMessage,
      frameCount: frames.length,
    });

    const fallbackBlob = await encodeWithFFmpegFallback(fallbackReason);
    return { blob: fallbackBlob, encoderBackendUsed: 'ffmpeg' };
  }
}
