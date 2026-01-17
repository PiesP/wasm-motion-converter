import type { EncoderFrame } from '@services/encoders/encoder-interface-service';
import { convertFramesToImageData } from '@services/encoders/frame-converter-service';
import {
  encodeWebPFramesInChunks,
  tryEncodeWebPWithEncoderFactory,
} from '@services/webcodecs/conversion/webp-encoding-service';
import { muxWebPFrames } from '@services/webcodecs/webp/mux-webp-frames-service';
import { validateWebPBlob } from '@services/webcodecs/webp/validate-webp-blob-service';
import { resolveAnimationDurationSeconds } from '@services/webcodecs/webp-timing-service';
import type { VideoMetadata } from '@t/conversion-types';
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
  timestampsForFactory?: number[];
  frameTimestampsForMuxer: number[];
  durationSecondsForFactory?: number;
  metadata?: VideoMetadata;
  codec?: string;
  sourceFPS?: number;
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

const logMuxerDurationAdjustment = (params: {
  metadataDuration: number;
  resolvedDuration: number;
  frameCount: number;
  fps: number;
}): void => {
  logger.info('conversion', 'Adjusted WebP animation duration to align with frame budget', params);
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
    requestedTargetFpsForDuration,
    captureDurationSeconds,
    quality,
    timestampsForFactory,
    frameTimestampsForMuxer,
    durationSecondsForFactory,
    metadata,
    codec,
    sourceFPS,
    onProgress,
    shouldCancel,
    canEncodeWebPFrames,
    setStatusPrefix,
    encodeWithFFmpegFallback,
  } = params;

  const factoryEncoded = await tryEncodeWebPWithEncoderFactory({
    frames,
    width,
    height,
    fps,
    quality,
    timestamps: timestampsForFactory,
    durationSeconds: durationSecondsForFactory,
    codec,
    sourceFPS,
    onProgress,
    shouldCancel,
  });

  if (factoryEncoded) {
    return {
      blob: factoryEncoded.blob,
      encoderBackendUsed: factoryEncoded.encoderBackendUsed,
    };
  }

  const canEncode = await canEncodeWebPFrames();
  if (!canEncode) {
    const reason = 'Canvas WebP encoding is not supported in this browser';
    logMuxerSkip(reason);

    const blob = await encodeWithFFmpegFallback(reason);
    return { blob, encoderBackendUsed: 'ffmpeg' };
  }

  logger.info('conversion', 'Using WebP muxer path with parallel frame encoding');

  // Muxer path expects ImageData frames. Only pay the GPU→CPU readback cost when
  // we actually need to fall back to the canvas encoder.
  const imageDataFrames = await convertFramesToImageData(
    frames,
    width,
    height,
    undefined,
    shouldCancel
  );

  const { encodedFrames } = await encodeWebPFramesInChunks({
    frames: imageDataFrames,
    quality,
    codec,
    onProgress,
    shouldCancel,
  });

  let fallbackReason = 'WebP muxer output failed';

  const muxDurationSeconds = resolveAnimationDurationSeconds(
    encodedFrames.length,
    requestedTargetFpsForDuration,
    metadata,
    captureDurationSeconds
  );

  if (muxDurationSeconds && metadata?.duration && muxDurationSeconds !== metadata.duration) {
    logMuxerDurationAdjustment({
      metadataDuration: metadata.duration,
      resolvedDuration: muxDurationSeconds,
      frameCount: encodedFrames.length,
      fps: requestedTargetFpsForDuration,
    });
  }

  const muxedWebP = await (async (): Promise<Blob | null> => {
    try {
      setStatusPrefix('Muxing WebP frames...');

      const result = await muxWebPFrames({
        encodedFrames,
        timestamps: frameTimestampsForMuxer.slice(0, encodedFrames.length),
        width,
        height,
        fps,
        metadata,
        durationSeconds: muxDurationSeconds,
        onProgress,
        shouldCancel,
      });

      if (!result) {
        fallbackReason = 'WebP muxer produced no output';
        logger.warn('conversion', 'WebP muxer produced no output, using FFmpeg fallback', {
          frameCount: encodedFrames.length,
        });
        return null;
      }

      const validation = await validateWebPBlob(result);
      if (!validation.valid) {
        fallbackReason = validation.reason ?? 'WebP muxer output failed validation';
        logger.warn('conversion', 'WebP muxer output failed validation, using fallback', {
          reason: validation.reason,
          frameCount: encodedFrames.length,
        });
        return null;
      }

      return result;
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      if (shouldPropagateMuxerError(errorMessage, shouldCancel)) {
        throw error;
      }

      fallbackReason = errorMessage;
      logger.warn('conversion', 'WebP muxer path failed, using FFmpeg fallback', {
        error: errorMessage,
        frameCount: encodedFrames.length,
      });
      return null;
    }
  })();

  if (muxedWebP) {
    return { blob: muxedWebP, encoderBackendUsed: 'webp-muxer' };
  }

  const blob = await encodeWithFFmpegFallback(fallbackReason);
  return { blob, encoderBackendUsed: 'ffmpeg' };
}
