import { EncoderFactory } from '@services/encoders/encoder-factory-service';
import type { EncoderFrame } from '@services/encoders/encoder-interface-service';
import { validateWebPBlob } from '@services/webcodecs/webp/validate-webp-blob-service';
import { createWebPFrameEncoder } from '@services/webcodecs/webp/webp-frame-encoder-service';
import type { ConversionOptions } from '@t/conversion-types';
import { QUALITY_PRESETS } from '@utils/constants';
import { getErrorMessage } from '@utils/error-utils';
import { isHardwareCacheValid } from '@utils/hardware-profile';
import { logger } from '@utils/logger';
import { cacheWebPChunkSize, getCachedWebPChunkSize } from '@utils/session-cache';
import { withTimeout } from '@utils/with-timeout';

type WebPFactoryParams = {
  frames: EncoderFrame[];
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
};

type WebPFactoryResult = { blob: Blob; encoderBackendUsed: string };

const resolveEncodeTimeoutMs = (width: number, height: number, frameCount: number): number => {
  const megapixelFrames = (width * height * frameCount) / 1_000_000;
  return Math.min(180_000, Math.max(45_000, Math.round(30_000 + megapixelFrames * 1_500)));
};

const createProgressKeepalive = (
  onProgress: ((current: number, total: number) => void) | undefined,
  totalFrames: number
): { stop: () => void; touch: () => void } => {
  if (!onProgress) {
    return { stop: () => undefined, touch: () => undefined };
  }

  let lastProgressAt = Date.now();
  const keepalive = setInterval(() => {
    const silenceMs = Date.now() - lastProgressAt;
    if (silenceMs > 5_000) {
      onProgress(0, totalFrames);
    }
  }, 5_000);

  return {
    stop: () => clearInterval(keepalive),
    touch: () => {
      lastProgressAt = Date.now();
    },
  };
};

const resolveChunkSize = (): { chunkSize: number; cached: boolean; cachedChunkSize?: number } => {
  const hwConcurrency = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  const cachedChunkSize = getCachedWebPChunkSize();
  const cached = Boolean(cachedChunkSize && isHardwareCacheValid());

  return {
    cached,
    cachedChunkSize: cachedChunkSize ?? undefined,
    chunkSize:
      cached && cachedChunkSize ? cachedChunkSize : Math.min(20, Math.max(10, hwConcurrency * 2)),
  };
};

export async function tryEncodeWebPWithEncoderFactory(
  params: WebPFactoryParams
): Promise<WebPFactoryResult | null> {
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
    // Get best encoder based on performance ranking (Phase 1 optimization)
    // Don't specify preferWorkers - let performance score determine best encoder
    const encoder = await EncoderFactory.getEncoder('webp', {
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

    // Guard against encoder hangs (e.g., worker init/WASM fetch never resolving).
    // Use an adaptive timeout based on total work size.
    const encodeTimeoutMs = resolveEncodeTimeoutMs(width, height, frames.length);

    // Keep watchdog alive while the encoder is working but hasn't emitted progress yet.
    // The monitoring layer tracks time-since-last-progress, not strictly percent changes.
    const totalFrames = Math.max(1, frames.length);
    const keepalive = createProgressKeepalive(onProgress, totalFrames);
    const wrappedOnProgress = onProgress
      ? (current: number, total: number) => {
          keepalive.touch();
          onProgress(current, total);
        }
      : undefined;

    const blob = await withTimeout(
      encoder.encode({
        frames,
        width,
        height,
        fps,
        quality,
        timestamps: safeTimestamps,
        durationSeconds,
        codec,
        sourceFPS,
        onProgress: wrappedOnProgress,
        shouldCancel,
      }),
      encodeTimeoutMs,
      `WebP encoder (${encoder.name}) timed out after ${Math.round(encodeTimeoutMs / 1000)}s`,
      () => {
        logger.warn('conversion', 'EncoderFactory WebP encode timed out', {
          encoder: encoder.name,
          encodeTimeoutMs,
          frameCount: frames.length,
          width,
          height,
          codec: codec ?? 'unknown',
        });
      }
    ).finally(() => {
      keepalive.stop();
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

  const { chunkSize, cached, cachedChunkSize } = resolveChunkSize();

  logger.info('conversion', 'Encoding WebP frames with canvas encoder', {
    frameCount: frames.length,
    chunkSize,
    cached,
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
