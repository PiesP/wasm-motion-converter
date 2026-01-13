import type { ConversionOptions, ConversionOutputBlob, VideoMetadata } from '@t/conversion-types';
import { FFMPEG_INTERNALS } from '@utils/ffmpeg-constants';
import { logger } from '@utils/logger';

import { ffmpegService } from '@services/ffmpeg-service';
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

  throwIfCancelled();

  // H.264 intermediate path already attempted earlier in the pipeline.
  // Skip redundant retries and go directly to FFmpeg frame re-extraction.
  logger.warn('conversion', 'WebCodecs encoder failed, retrying with FFmpeg frames', {
    error: errorMessage,
  });

  if (!ffmpegService.isLoaded()) {
    await ffmpegService.initialize();
  }

  resetCaptureCollections();

  ffmpegService.reportStatus(`Retrying ${format.toUpperCase()} encode with FFmpeg...`);
  ffmpegService.reportProgress(FFMPEG_INTERNALS.PROGRESS.WEBCODECS.DECODE_START);

  const fallbackFrameFiles: string[] = [];
  let fallbackResult: Awaited<ReturnType<WebCodecsDecoderService['decodeToFrames']>>;
  let lastValidFallbackFrame: Uint8Array | null = null;

  try {
    fallbackResult = await decoder.decodeToFrames({
      file,
      targetFps,
      scale,
      frameFormat: FFMPEG_INTERNALS.WEBCODECS.FRAME_FORMAT as WebCodecsFrameFormat,
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
    throw fallbackError;
  }

  // CRITICAL: Validate fallback frame capture completeness.
  // Incomplete sequences here can hang the FFmpeg encoder.
  const validationExpectedFrames = computeExpectedFramesFromDuration({
    durationSeconds: fallbackResult.duration,
    fps: targetFps,
  });
  const captureRatio = fallbackResult.frameCount / validationExpectedFrames;
  const minRequiredRatio = 0.5;
  const minAbsoluteFrames = 10;

  if (fallbackResult.frameCount < minAbsoluteFrames || captureRatio < minRequiredRatio) {
    if (fallbackFrameFiles.length > 0) {
      await ffmpegService.deleteVirtualFiles(fallbackFrameFiles);
    }

    const msg =
      `Fallback frame extraction incomplete: captured ${fallbackResult.frameCount} of ${validationExpectedFrames} frames ` +
      `(${(captureRatio * 100).toFixed(1)}%). Minimum required: ${minRequiredRatio * 100}%.`;

    logger.error('conversion', msg, {
      captured: fallbackResult.frameCount,
      expected: validationExpectedFrames,
      duration: fallbackResult.duration,
    });

    // Last-resort fallback: avoid hard-failing when WebCodecs frame capture is incomplete.
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
    fallbackResult.frameCount,
    targetFps,
    metadata,
    fallbackResult.duration
  );

  const fallbackFps = resolveWebPFpsUtil(
    fallbackResult.frameCount,
    targetFps,
    fallbackDurationSeconds
  );

  if (fallbackFps !== targetFps) {
    logger.info('conversion', 'Adjusted fallback WebP FPS to preserve pacing', {
      targetFps,
      adjustedFps: fallbackFps,
      frameCount: fallbackResult.frameCount,
      durationSeconds: fallbackDurationSeconds ?? fallbackResult.duration,
    });
  }

  const fallbackBlob = await ffmpegService.encodeFrameSequence({
    format,
    options,
    frameCount: fallbackResult.frameCount,
    fps: fallbackFps,
    durationSeconds: fallbackDurationSeconds ?? metadata?.duration ?? fallbackResult.duration,
    frameFiles: fallbackFrameFiles,
  });

  const fallbackBlobWithMetadata = fallbackBlob as ConversionOutputBlob;
  fallbackBlobWithMetadata.encoderBackendUsed = 'ffmpeg';
  return fallbackBlobWithMetadata;
}
