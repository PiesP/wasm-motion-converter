import type { ConversionOptions, ConversionOutputBlob, VideoMetadata } from '@t/conversion-types';
import { FFMPEG_INTERNALS } from '@utils/ffmpeg-constants';
import { logger } from '@utils/logger';
import { isMemoryCritical } from '@utils/memory-monitor';

import { ffmpegService } from '@services/ffmpeg-service';
import { isComplexCodec } from '@services/webcodecs/codec-utils';
import type {
  WebCodecsDecoderService,
  WebCodecsFrameFormat,
} from '@services/webcodecs-decoder-service';
import {
  resolveAnimationDurationSeconds as resolveAnimationDurationSecondsUtil,
  resolveWebPFps as resolveWebPFpsUtil,
} from '@services/webcodecs/webp-timing';
import { computeExpectedFramesFromDuration } from '@services/webcodecs/conversion/frame-requirements';

export async function encodeWithFFmpegFallback(params: {
  format: 'gif' | 'webp';
  file: File;
  options: ConversionOptions;
  metadata?: VideoMetadata;
  errorMessage: string;
  decoder: WebCodecsDecoderService;
  targetFps: number;
  scale: number;
  reportDecodeProgress: (current: number, total: number) => void;
  shouldCancel: () => boolean;
  throwIfCancelled: () => void;
  resetCaptureCollections: () => void;
  intent?: 'fallback' | 'preferred';
  allowFFmpegDirectFallback?: boolean;
}): Promise<ConversionOutputBlob> {
  const {
    format,
    file,
    options,
    metadata,
    errorMessage,
    decoder,
    targetFps,
    scale,
    reportDecodeProgress,
    shouldCancel,
    throwIfCancelled,
    resetCaptureCollections,
  } = params;

  const intent: 'fallback' | 'preferred' = params.intent ?? 'fallback';

  throwIfCancelled();

  const allowFFmpegDirectFallback =
    params.allowFFmpegDirectFallback ?? (metadata ? !isComplexCodec(metadata.codec) : true);

  // When used as a fallback, this path is triggered after an encoder failure.
  // When used as a preferred path, we intentionally choose FFmpeg frame-sequence encoding
  // (e.g., for GIF palettegen/paletteuse) while still using WebCodecs for decoding.
  if (intent === 'preferred') {
    logger.info('conversion', 'Using WebCodecs frames with FFmpeg encoding (preferred)', {
      format,
      codec: metadata?.codec,
      reason: errorMessage,
    });
  } else {
    // H.264 intermediate path already attempted earlier in the pipeline.
    // Skip redundant retries and go directly to FFmpeg frame re-extraction.
    logger.warn('conversion', 'WebCodecs encoder failed, retrying with FFmpeg frames', {
      error: errorMessage,
      format,
      codec: metadata?.codec,
    });
  }

  if (!ffmpegService.isLoaded()) {
    await ffmpegService.initialize();
  }

  resetCaptureCollections();

  ffmpegService.reportStatus(
    intent === 'preferred'
      ? `Encoding ${format.toUpperCase()} with FFmpeg...`
      : `Retrying ${format.toUpperCase()} encode with FFmpeg...`
  );
  ffmpegService.reportProgress(FFMPEG_INTERNALS.PROGRESS.WEBCODECS.DECODE_START);

  const fallbackFrameFiles: string[] = [];
  const fallbackTempFiles: string[] = [];
  let fallbackResult: Awaited<ReturnType<WebCodecsDecoderService['decodeToFrames']>>;
  let lastValidFallbackFrame: Uint8Array | null = null;
  let lastValidFallbackRgbaFrame: Uint8Array | null = null;

  // Rawvideo avoids expensive PNG/JPEG encoding/decoding, but can require large contiguous memory.
  // Only use it when explicitly preferred and the estimated memory footprint looks safe.
  const RAWVIDEO_MAX_BYTES = 256 * 1024 * 1024; // 256MB
  const estimatedScaledWidth = metadata?.width
    ? Math.max(1, Math.round(metadata.width * scale))
    : null;
  const estimatedScaledHeight = metadata?.height
    ? Math.max(1, Math.round(metadata.height * scale))
    : null;
  const estimatedFramesForRaw = metadata?.duration
    ? computeExpectedFramesFromDuration({
        durationSeconds: metadata.duration,
        fps: targetFps,
      })
    : null;
  const estimatedRawBytes =
    estimatedScaledWidth && estimatedScaledHeight && estimatedFramesForRaw
      ? estimatedScaledWidth * estimatedScaledHeight * 4 * estimatedFramesForRaw
      : null;

  const shouldTryRawVideo: boolean =
    intent === 'preferred' &&
    format === 'gif' &&
    !isMemoryCritical() &&
    estimatedRawBytes !== null &&
    estimatedRawBytes > 0 &&
    estimatedRawBytes <= RAWVIDEO_MAX_BYTES;

  const rawVideoFileName = 'frames.rgba';
  let rawVideoWidth: number | null = null;
  let rawVideoHeight: number | null = null;
  let rawVideoBuffer: Uint8Array | null = null;
  let rawVideoFramesWritten = 0;

  // Important for TypeScript control-flow: the buffer is mutated inside an async callback.
  // If we only assign it there, TS may treat it as always-null here.
  if (shouldTryRawVideo) {
    rawVideoBuffer = new Uint8Array(0);
  }

  const ensureRawBufferCapacity = (requiredFrames: number, frameByteLength: number): void => {
    const requiredBytes = requiredFrames * frameByteLength;
    if (rawVideoBuffer && rawVideoBuffer.byteLength >= requiredBytes) {
      return;
    }

    const currentBytes = rawVideoBuffer?.byteLength ?? 0;
    const nextBytes = Math.max(
      requiredBytes,
      Math.max(frameByteLength * 16, Math.floor(currentBytes * 1.5))
    );
    const next = new Uint8Array(nextBytes);
    if (rawVideoBuffer) {
      next.set(rawVideoBuffer);
    }
    rawVideoBuffer = next;
  };

  try {
    fallbackResult = await decoder.decodeToFrames({
      file,
      targetFps,
      scale,
      frameFormat: shouldTryRawVideo
        ? ('rgba' as const)
        : (FFMPEG_INTERNALS.WEBCODECS.FRAME_FORMAT as WebCodecsFrameFormat),
      frameQuality: FFMPEG_INTERNALS.WEBCODECS.FRAME_QUALITY,
      framePrefix: FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_PREFIX,
      frameDigits: FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_DIGITS,
      frameStartNumber: FFMPEG_INTERNALS.WEBCODECS.FRAME_START_NUMBER,
      captureMode: 'auto',
      codec: metadata?.codec,
      quality: options.quality,
      shouldCancel,
      onProgress: reportDecodeProgress,
      onFrame: async (frame) => {
        throwIfCancelled();

        if (shouldTryRawVideo) {
          const imageData = frame.imageData;
          if (!imageData) {
            if (!lastValidFallbackRgbaFrame) {
              throw new Error('WebCodecs did not provide RGBA frame data (ImageData).');
            }

            logger.warn('conversion', 'WebCodecs produced empty RGBA payload, reusing last frame', {
              frameName: frame.name,
              frameIndex: frame.index,
            });

            if (!rawVideoWidth || !rawVideoHeight) {
              throw new Error('Rawvideo frame dimensions are not initialized.');
            }

            const frameByteLength = rawVideoWidth * rawVideoHeight * 4;
            ensureRawBufferCapacity(rawVideoFramesWritten + 1, frameByteLength);
            rawVideoBuffer?.set(
              lastValidFallbackRgbaFrame,
              rawVideoFramesWritten * frameByteLength
            );
            rawVideoFramesWritten++;
            return;
          }

          if (!rawVideoWidth || !rawVideoHeight) {
            rawVideoWidth = imageData.width;
            rawVideoHeight = imageData.height;
          }

          if (imageData.width !== rawVideoWidth || imageData.height !== rawVideoHeight) {
            throw new Error(
              `Rawvideo requires stable dimensions, got ${imageData.width}x${imageData.height} (expected ${rawVideoWidth}x${rawVideoHeight}).`
            );
          }

          const rgba = new Uint8Array(
            imageData.data.buffer,
            imageData.data.byteOffset,
            imageData.data.byteLength
          );
          lastValidFallbackRgbaFrame = new Uint8Array(rgba);

          const frameByteLength = rawVideoWidth * rawVideoHeight * 4;
          ensureRawBufferCapacity(rawVideoFramesWritten + 1, frameByteLength);
          rawVideoBuffer?.set(rgba, rawVideoFramesWritten * frameByteLength);
          rawVideoFramesWritten++;
          return;
        }

        if (!frame.data || frame.data.byteLength === 0) {
          if (!lastValidFallbackFrame) {
            throw new Error('WebCodecs did not provide encoded frame data.');
          }

          const reusedFrame = new Uint8Array(lastValidFallbackFrame);
          logger.warn(
            'conversion',
            'WebCodecs produced empty fallback frame data, reusing last frame',
            {
              frameName: frame.name,
              frameIndex: frame.index,
            }
          );

          await ffmpegService.writeVirtualFile(frame.name, reusedFrame);
          fallbackFrameFiles.push(frame.name);
          return;
        }

        const encodedFrame = new Uint8Array(frame.data);
        lastValidFallbackFrame = encodedFrame;
        await ffmpegService.writeVirtualFile(frame.name, encodedFrame);
        fallbackFrameFiles.push(frame.name);
      },
    });
  } catch (fallbackError) {
    if (fallbackFrameFiles.length > 0) {
      await ffmpegService.deleteVirtualFiles(fallbackFrameFiles);
    }
    if (fallbackTempFiles.length > 0) {
      await ffmpegService.deleteVirtualFiles(fallbackTempFiles);
    }
    throw fallbackError;
  }

  const effectiveFrameCount = shouldTryRawVideo ? rawVideoFramesWritten : fallbackResult.frameCount;

  // CRITICAL: Validate fallback frame capture completeness.
  // Incomplete sequences here can hang the FFmpeg encoder.
  const validationExpectedFrames = computeExpectedFramesFromDuration({
    durationSeconds: fallbackResult.duration,
    fps: targetFps,
  });
  const captureRatio = effectiveFrameCount / validationExpectedFrames;
  const minRequiredRatio = 0.5;
  const minAbsoluteFrames = 10;

  if (effectiveFrameCount < minAbsoluteFrames || captureRatio < minRequiredRatio) {
    if (fallbackFrameFiles.length > 0) {
      await ffmpegService.deleteVirtualFiles(fallbackFrameFiles);
    }
    if (fallbackTempFiles.length > 0) {
      await ffmpegService.deleteVirtualFiles(fallbackTempFiles);
    }

    const msg =
      `Fallback frame extraction incomplete: captured ${effectiveFrameCount} of ${validationExpectedFrames} frames ` +
      `(${(captureRatio * 100).toFixed(1)}%). Minimum required: ${minRequiredRatio * 100}%.`;

    logger.error('conversion', msg, {
      captured: effectiveFrameCount,
      expected: validationExpectedFrames,
      duration: fallbackResult.duration,
    });

    // Optional last-resort fallback: avoid hard-failing when WebCodecs frame capture is incomplete.
    // WARNING: For complex codecs (e.g., AV1), FFmpeg direct decode is often unreliable in WASM.
    // In those cases, do NOT attempt FFmpeg direct fallback; let the caller fall back to a
    // non-FFmpeg encoder (e.g., modern-gif).
    if (!allowFFmpegDirectFallback) {
      throw new Error(msg);
    }

    logger.warn(
      'conversion',
      'Falling back to FFmpeg direct conversion after incomplete frame capture',
      {
        format,
        captured: fallbackResult.frameCount,
        expected: validationExpectedFrames,
        captureRatio,
        minRequiredRatio,
        minAbsoluteFrames,
      }
    );

    const blob =
      format === 'webp'
        ? await ffmpegService.convertToWebP(file, options, metadata)
        : await ffmpegService.convertToGIF(file, options, metadata);

    const blobWithMetadata = blob as ConversionOutputBlob;
    blobWithMetadata.encoderBackendUsed = 'ffmpeg';
    return blobWithMetadata;
  }

  const fallbackDurationSeconds = resolveAnimationDurationSecondsUtil(
    effectiveFrameCount,
    targetFps,
    metadata,
    fallbackResult.duration
  );

  const fallbackFps = resolveWebPFpsUtil(effectiveFrameCount, targetFps, fallbackDurationSeconds);

  if (fallbackFps !== targetFps) {
    logger.info('conversion', 'Adjusted fallback WebP FPS to preserve pacing', {
      targetFps,
      adjustedFps: fallbackFps,
      frameCount: effectiveFrameCount,
      durationSeconds: fallbackDurationSeconds ?? fallbackResult.duration,
    });
  }

  if (shouldTryRawVideo) {
    const width = rawVideoWidth ?? fallbackResult.width;
    const height = rawVideoHeight ?? fallbackResult.height;

    if (width <= 0 || height <= 0 || !rawVideoBuffer) {
      throw new Error('Rawvideo buffer was not initialized after RGBA frame capture.');
    }

    const frameByteLength = width * height * 4;
    const bytesUsed = rawVideoFramesWritten * frameByteLength;
    const rawBytes = rawVideoBuffer.subarray(0, bytesUsed);
    await ffmpegService.writeVirtualFile(rawVideoFileName, rawBytes);
    fallbackTempFiles.push(rawVideoFileName);
  }

  const fallbackBlob = await ffmpegService.encodeFrameSequence({
    format,
    options,
    frameCount: effectiveFrameCount,
    fps: fallbackFps,
    durationSeconds: fallbackDurationSeconds ?? metadata?.duration ?? fallbackResult.duration,
    frameFiles: shouldTryRawVideo ? [] : fallbackFrameFiles,
    frameInput: shouldTryRawVideo
      ? {
          kind: 'rawvideo',
          fileName: rawVideoFileName,
          width: rawVideoWidth || fallbackResult.width,
          height: rawVideoHeight || fallbackResult.height,
          pixelFormat: 'rgba',
        }
      : {
          kind: 'image-sequence',
          frameFiles: fallbackFrameFiles,
        },
  });

  const fallbackBlobWithMetadata = fallbackBlob as ConversionOutputBlob;
  fallbackBlobWithMetadata.encoderBackendUsed = format === 'gif' ? 'ffmpeg-palette' : 'ffmpeg';
  fallbackBlobWithMetadata.captureModeUsed = 'auto';
  return fallbackBlobWithMetadata;
}
