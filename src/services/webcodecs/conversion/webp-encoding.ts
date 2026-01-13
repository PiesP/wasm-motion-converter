import type { ConversionOptions } from '@t/conversion-types';
import { QUALITY_PRESETS } from '@utils/constants';
import { getErrorMessage } from '@utils/error-utils';
import { isHardwareCacheValid } from '@utils/hardware-profile';
import { logger } from '@utils/logger';
import { cacheWebPChunkSize, getCachedWebPChunkSize } from '@utils/session-cache';

import { EncoderFactory } from '@services/encoders/encoder-factory';
import { createWebPFrameEncoder } from '@services/webcodecs/webp/webp-frame-encoder';
import { validateWebPBlob } from '@services/webcodecs/webp/validate-webp-blob';

export async function tryEncodeWebPWithEncoderFactory(params: {
  frames: ImageData[];
  width: number;
  height: number;
  fps: number;
  quality: ConversionOptions['quality'];
  timestamps?: number[];
  durationSeconds?: number;
  codec?: string;
  sourceFPS?: number;
  onProgress?: (current: number, total: number) => void;
  shouldCancel?: () => boolean;
}): Promise<{ blob: Blob; encoderBackendUsed: string } | null> {
  const {
    frames,
    width,
    height,
    fps,
    quality,
    timestamps,
    durationSeconds,
    codec,
    sourceFPS,
    onProgress,
    shouldCancel,
  } = params;

  if (frames.length === 0) {
    return null;
  }

  try {
    const encoder = await EncoderFactory.getEncoder('webp', {
      preferWorkers: true,
      quality,
    });

    if (!encoder) {
      return null;
    }

    // Respect encoder constraints (defensive).
    const maxFramesAllowed = encoder.capabilities.maxFrames;
    if (maxFramesAllowed && frames.length > maxFramesAllowed) {
      logger.warn('conversion', 'Skipping worker WebP encoder due to maxFrames constraint', {
        encoder: encoder.name,
        frameCount: frames.length,
        maxFramesAllowed,
      });
      return null;
    }

    if (
      encoder.capabilities.maxDimension &&
      Math.max(width, height) > encoder.capabilities.maxDimension
    ) {
      logger.warn('conversion', 'Skipping worker WebP encoder due to maxDimension constraint', {
        encoder: encoder.name,
        width,
        height,
        maxDimension: encoder.capabilities.maxDimension,
      });
      return null;
    }

    if (shouldCancel?.()) {
      throw new Error('Conversion cancelled by user');
    }

    const safeTimestamps = timestamps ? timestamps.slice(0, frames.length) : undefined;

    const blob = await encoder.encode({
      frames,
      width,
      height,
      fps,
      quality,
      timestamps: safeTimestamps,
      durationSeconds,
      codec,
      sourceFPS,
      onProgress,
      shouldCancel,
    });

    if (!blob) {
      return null;
    }

    const validation = await validateWebPBlob(blob);
    if (!validation.valid) {
      logger.warn('conversion', 'EncoderFactory WebP output failed validation', {
        encoder: encoder.name,
        reason: validation.reason ?? 'validation_failed',
        frameCount: frames.length,
      });
      return null;
    }

    return { blob, encoderBackendUsed: encoder.name };
  } catch (error) {
    if (shouldCancel?.()) {
      throw error;
    }

    logger.warn('conversion', 'EncoderFactory WebP encoding failed; falling back to muxer', {
      error: getErrorMessage(error),
    });
    return null;
  }
}

export async function encodeWebPFramesInChunks(params: {
  frames: ImageData[];
  quality: ConversionOptions['quality'];
  codec?: string;
  onProgress?: (current: number, total: number) => void;
  shouldCancel?: () => boolean;
}): Promise<{ encodedFrames: Uint8Array[]; chunkSizeUsed: number }> {
  const { frames, quality, codec, onProgress, shouldCancel } = params;

  if (frames.length === 0) {
    return { encodedFrames: [], chunkSizeUsed: 0 };
  }

  const webpQualityRatio = QUALITY_PRESETS.webp[quality].quality / 100;
  const encodeFrame = createWebPFrameEncoder(webpQualityRatio);

  const hwConcurrency = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  const cachedChunkSize = getCachedWebPChunkSize();
  const chunkSize =
    cachedChunkSize && isHardwareCacheValid()
      ? cachedChunkSize
      : Math.min(20, Math.max(10, hwConcurrency * 2));

  logger.info('conversion', 'Encoding WebP frames with canvas encoder', {
    frameCount: frames.length,
    chunkSize,
    cached: Boolean(cachedChunkSize && isHardwareCacheValid()),
    codec: codec ?? 'unknown',
  });

  const encodedFrames: Uint8Array[] = [];
  const totalFrames = frames.length;

  for (let i = 0; i < totalFrames; i += chunkSize) {
    if (shouldCancel?.()) {
      throw new Error('Conversion cancelled by user');
    }

    const chunk = frames.slice(i, Math.min(i + chunkSize, totalFrames));
    const encodedChunk = await Promise.all(chunk.map((frame) => encodeFrame(frame)));
    encodedFrames.push(...encodedChunk);

    onProgress?.(encodedFrames.length, totalFrames);
  }

  if (!cachedChunkSize && encodedFrames.length > 0) {
    cacheWebPChunkSize(chunkSize);
    logger.info('conversion', 'Cached WebP chunk size for future conversions', {
      chunkSize,
    });
  }

  return { encodedFrames, chunkSizeUsed: chunkSize };
}
