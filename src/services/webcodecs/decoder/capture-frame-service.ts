/**
 * Canvas-based frame capture for WebCodecs decoding.
 */

import type { CaptureContext } from '@services/webcodecs/decoder/canvas-service';
import { canvasToBlob } from '@services/webcodecs/decoder/canvas-service';
import type { WebCodecsFrameFormat, WebCodecsFramePayload } from '@t/video-pipeline-types';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

export function formatFrameName(
  framePrefix: string,
  frameDigits: number,
  frameIndex: number,
  frameStartNumber: number,
  extension: string
): string {
  const frameNumber = frameStartNumber + frameIndex;
  const paddedNumber = frameNumber.toString().padStart(frameDigits, '0');
  return `${framePrefix}${paddedNumber}.${extension}`;
}

export type CaptureFrameState = {
  consecutiveEmptyFrames: number;
};

const formatDecision = (args: {
  frameFormat: WebCodecsFrameFormat;
  quality?: 'low' | 'medium' | 'high';
  isComplexCodec: boolean;
  frameQuality: number;
}): {
  actualFormat: WebCodecsFrameFormat;
  encodeMimeType: string;
  encodeQuality?: number;
} => {
  const { frameFormat, quality, isComplexCodec, frameQuality } = args;

  if (frameFormat === 'rgba') {
    return {
      actualFormat: 'rgba',
      encodeMimeType: 'application/octet-stream',
    };
  }

  if (frameFormat === 'bitmap') {
    return {
      actualFormat: 'bitmap',
      encodeMimeType: 'application/octet-stream',
    };
  }

  const forceJpegForComplexCodec = isComplexCodec;
  const shouldUseJpeg =
    forceJpegForComplexCodec ||
    frameFormat === 'jpeg' ||
    (frameFormat === 'png' && quality && (quality === 'low' || quality === 'medium'));

  const encodeMimeType = shouldUseJpeg ? 'image/jpeg' : 'image/png';

  const encodeQuality = shouldUseJpeg
    ? quality === 'low'
      ? 0.75
      : quality === 'medium'
        ? 0.85
        : frameQuality
    : undefined;

  const actualFormat: WebCodecsFrameFormat =
    frameFormat === 'jpeg' || shouldUseJpeg ? 'jpeg' : 'png';

  return {
    actualFormat,
    encodeMimeType,
    encodeQuality,
  };
};

export const captureFrameAndEmit = async (args: {
  video: HTMLVideoElement;
  captureContext: CaptureContext;
  index: number;
  timestamp: number;
  frameFormat: WebCodecsFrameFormat;
  frameQuality: number;
  quality?: 'low' | 'medium' | 'high';
  codec?: string;
  framePrefix: string;
  frameDigits: number;
  frameStartNumber: number;
  onFrame: (frame: WebCodecsFramePayload) => Promise<void>;
  state: CaptureFrameState;
  canvasEncodeTimeoutMs: number;
  maxConsecutiveEmptyFrames: number;
}): Promise<string | null> => {
  const {
    video,
    captureContext,
    index,
    timestamp,
    frameFormat,
    frameQuality,
    quality,
    codec,
    framePrefix,
    frameDigits,
    frameStartNumber,
    onFrame,
    state,
    canvasEncodeTimeoutMs,
    maxConsecutiveEmptyFrames,
  } = args;

  captureContext.context.drawImage(
    video,
    0,
    0,
    captureContext.targetWidth,
    captureContext.targetHeight
  );

  const isComplexCodec = Boolean(codec && /vp9|hevc|h\.265|h265|hvc1|hev1/i.test(codec));

  let data: Uint8Array | undefined;
  let imageData: ImageData | undefined;
  let bitmap: ImageBitmap | undefined;

  if (frameFormat === 'bitmap') {
    if (typeof createImageBitmap !== 'function') {
      throw new Error('createImageBitmap is not available for bitmap frame capture');
    }

    try {
      bitmap = await createImageBitmap(captureContext.canvas);
    } catch (error) {
      throw new Error(`Failed to create ImageBitmap for frame ${index}: ${getErrorMessage(error)}`);
    }

    state.consecutiveEmptyFrames = 0;
    const frameName = formatFrameName(framePrefix, frameDigits, index, frameStartNumber, 'bitmap');
    await onFrame({
      name: frameName,
      data,
      imageData,
      bitmap,
      index,
      timestamp,
    });
    return frameName;
  }

  if (frameFormat === 'rgba') {
    imageData = captureContext.context.getImageData(
      0,
      0,
      captureContext.targetWidth,
      captureContext.targetHeight
    );

    if (imageData.data.length === 0) {
      state.consecutiveEmptyFrames += 1;
      logger.warn('conversion', `WebCodecs produced empty RGBA frame ${index}, skipping`, {
        consecutiveEmptyFrames: state.consecutiveEmptyFrames,
        maxAllowed: maxConsecutiveEmptyFrames,
      });

      if (state.consecutiveEmptyFrames >= maxConsecutiveEmptyFrames) {
        throw new Error(
          `WebCodecs decoder produced ${state.consecutiveEmptyFrames} consecutive empty frames at frame ${index}. ` +
            'This typically indicates codec incompatibility (e.g., AV1). Falling back to FFmpeg.'
        );
      }

      return null;
    }

    state.consecutiveEmptyFrames = 0;
  } else {
    const decision = formatDecision({
      frameFormat,
      quality,
      isComplexCodec,
      frameQuality,
    });

    const convertBlobWithTimeout = async (): Promise<Blob> => {
      let timeoutId: ReturnType<typeof setTimeout> = 0 as unknown as ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<Blob>(
        (_, reject) =>
          (timeoutId = setTimeout(
            () =>
              reject(
                new Error(
                  `Canvas encoding timeout (${canvasEncodeTimeoutMs}ms) - GPU stall detected`
                )
              ),
            canvasEncodeTimeoutMs
          ))
      );

      let blobPromise: Promise<Blob>;
      if ('convertToBlob' in captureContext.canvas) {
        try {
          blobPromise = (captureContext.canvas as OffscreenCanvas).convertToBlob({
            type: decision.encodeMimeType,
            quality: decision.encodeQuality,
          });
        } catch (offscreenError) {
          logger.debug('conversion', 'OffscreenCanvas.convertToBlob() failed, using fallback', {
            error: getErrorMessage(offscreenError),
          });

          blobPromise = canvasToBlob(
            captureContext.canvas,
            decision.encodeMimeType,
            decision.encodeQuality
          );
        }
      } else {
        blobPromise = canvasToBlob(
          captureContext.canvas,
          decision.encodeMimeType,
          decision.encodeQuality
        );
      }

      try {
        return await Promise.race([blobPromise, timeoutPromise]);
      } finally {
        clearTimeout(timeoutId);
      }
    };

    let blob: Blob;
    try {
      blob = await convertBlobWithTimeout();
    } catch (timeoutError) {
      const errorMsg = getErrorMessage(timeoutError);
      logger.warn('conversion', 'Canvas encoding timeout detected - likely GPU stall', {
        error: errorMsg,
        codec,
        frameIndex: index,
        canvasWidth: captureContext.targetWidth,
        canvasHeight: captureContext.targetHeight,
      });

      throw new Error(
        `Canvas encoding stalled at frame ${index}. ` +
          'This may indicate codec incompatibility or GPU memory exhaustion. Falling back to FFmpeg.'
      );
    }

    if (blob.size === 0) {
      state.consecutiveEmptyFrames += 1;
      logger.warn('conversion', `WebCodecs produced empty frame ${index}, skipping`, {
        consecutiveEmptyFrames: state.consecutiveEmptyFrames,
        maxAllowed: maxConsecutiveEmptyFrames,
      });

      if (state.consecutiveEmptyFrames >= maxConsecutiveEmptyFrames) {
        throw new Error(
          `WebCodecs decoder produced ${state.consecutiveEmptyFrames} consecutive empty frames at frame ${index}. ` +
            'This typically indicates codec incompatibility (e.g., AV1). Falling back to FFmpeg.'
        );
      }

      return null;
    }

    data = new Uint8Array(await blob.arrayBuffer());
    if (data.byteLength === 0) {
      state.consecutiveEmptyFrames += 1;
      logger.warn('conversion', `WebCodecs produced empty frame data at ${index}, skipping`, {
        consecutiveEmptyFrames: state.consecutiveEmptyFrames,
        maxAllowed: maxConsecutiveEmptyFrames,
      });

      if (state.consecutiveEmptyFrames >= maxConsecutiveEmptyFrames) {
        throw new Error(
          `WebCodecs decoder produced ${state.consecutiveEmptyFrames} consecutive empty frames at frame ${index}. ` +
            'This typically indicates codec incompatibility (e.g., AV1). Falling back to FFmpeg.'
        );
      }

      return null;
    }

    state.consecutiveEmptyFrames = 0;

    const frameName = formatFrameName(
      framePrefix,
      frameDigits,
      index,
      frameStartNumber,
      decision.actualFormat
    );

    await onFrame({
      name: frameName,
      data,
      imageData,
      bitmap,
      index,
      timestamp,
    });
    return frameName;
  }

  const frameName = formatFrameName(framePrefix, frameDigits, index, frameStartNumber, 'rgba');

  await onFrame({ name: frameName, data, imageData, bitmap, index, timestamp });
  return frameName;
};
