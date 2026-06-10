// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * WebCodecs Conversion Service
 *
 * GPU-accelerated video conversion using WebCodecs API.
 * Extracts frames via WebCodecs decode, encodes to GIF/WebP.
 * Falls back to FFmpeg when WebCodecs is unavailable.
 */

import { ffmpegService } from '@services/cpu-path/ffmpeg-pipeline-service';
import { probeCanvasWebPEncodeSupport } from '@services/webcodecs/conversion/canvas-webp-support-service';
import { captureComplexCodecFramesForWebP } from '@services/webcodecs/conversion/complex-codec-capture-service';
import { encodeWithFFmpegFallback } from '@services/webcodecs/conversion/ffmpeg-fallback-encode-service';
import { createThrottledProgressReporter } from '@services/webcodecs/conversion/progress-reporting-service';
import { encodeWebPWithMuxFallback } from '@services/webcodecs/conversion/webp-encode-orchestrator-service';
import { validateWebPBlob } from '@services/webcodecs/webp/validate-webp-blob-service';
import {
  buildDurationAlignedTimestamps,
  getMaxWebPFrames,
  resolveAnimationDurationSeconds,
  resolveWebPFps,
} from '@services/webcodecs/webp/webp-timing-service';
import { WebCodecsDecoderService } from '@services/webcodecs-decoder-service';
import type {
  ConversionOptions,
  ConversionOutputBlob,
  EncoderFrame,
  VideoMetadata,
} from '@t/conversion-types';
import type { WebCodecsCaptureMode, WebCodecsFrameFormat } from '@t/video-pipeline-types';
import type { EncoderWorkerAPI } from '@t/worker-types';
import { isComplexCodec } from '@utils/codec-utils';
import { QUALITY_PRESETS } from '@utils/constants';
import { getErrorMessage } from '@utils/error-utils';
import { FFMPEG_INTERNALS } from '@utils/ffmpeg-constants';
import { logger } from '@utils/logger';
import { getAvailableMemory } from '@utils/memory-monitor';
import { getOptimalFPS } from '@utils/quality-optimizer';
import { computeTrimDuration } from '@utils/video-math';
import * as Comlink from 'comlink';
import gifEncoderWorkerUrl from '@/workers/gif-encoder.worker?worker&url';
import { encodeModernGif, isModernGifSupported } from './modern-gif-service';
import { getOptimalPoolSize, WorkerPool } from './worker-pool-service';

let gifWorkerPool: WorkerPool<EncoderWorkerAPI> | null = null;
let canvasWebPEncodeSupport: boolean | null = null;
let gifWorkerPoolPromise: Promise<WorkerPool<EncoderWorkerAPI>> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_TIMEOUT_MS = 60_000; // 1 minute

function getWorkerPool(): Promise<WorkerPool<EncoderWorkerAPI> | null> {
  if (typeof window === 'undefined') {
    return Promise.resolve(null);
  }
  if (gifWorkerPool) {
    return Promise.resolve(gifWorkerPool);
  }
  if (gifWorkerPoolPromise) {
    return gifWorkerPoolPromise;
  }

  gifWorkerPoolPromise = (async (): Promise<WorkerPool<EncoderWorkerAPI>> => {
    const hwConcurrency = navigator.hardwareConcurrency || 4;
    const availableMem = getAvailableMemory();
    const optimalGifWorkers = getOptimalPoolSize('gif', hwConcurrency, availableMem);

    logger.info('worker-pool', 'Dynamic worker pool sizing', {
      hardwareConcurrency: hwConcurrency,
      availableMemory: `${Math.round(availableMem / 1024 / 1024)}MB`,
      gifWorkers: optimalGifWorkers,
    });

    gifWorkerPool = new WorkerPool(gifEncoderWorkerUrl, {
      lazyInit: true,
      maxWorkers: optimalGifWorkers,
    });

    return gifWorkerPool;
  })();

  return gifWorkerPoolPromise;
}

async function getCanvasWebPEncodeSupport(): Promise<boolean> {
  if (canvasWebPEncodeSupport !== null) {
    return canvasWebPEncodeSupport;
  }
  canvasWebPEncodeSupport = await probeCanvasWebPEncodeSupport();
  return canvasWebPEncodeSupport;
}

function shouldUseWebCodecsPath(metadata: VideoMetadata | undefined): boolean {
  return isComplexCodec(metadata?.codec) && typeof VideoFrame !== 'undefined';
}

export async function convert(
  file: File,
  format: 'gif' | 'webp',
  options: ConversionOptions,
  metadata?: VideoMetadata,
  abortSignal?: AbortSignal
): Promise<ConversionOutputBlob> {
  const { quality, scale } = options;
  const settings = format === 'gif' ? QUALITY_PRESETS.gif[quality] : QUALITY_PRESETS.webp[quality];

  // Compute effective trim duration for WebP timing calculations (first occurrence)
  const trimDurationSeconds = computeTrimDuration(options.trimStart, options.trimEnd);

  const normalizedCodec = (metadata?.codec ?? 'unknown').toLowerCase();
  const useModernGif = format === 'gif' && isModernGifSupported();
  const shouldPreferFfmpegPalette =
    format === 'gif' &&
    (options.gifEncoder === 'ffmpeg-palette' ||
      (options.gifEncoder === 'auto' &&
        (normalizedCodec === 'unknown' || isComplexCodec(normalizedCodec))));

  const shouldCancel = abortSignal
    ? () => abortSignal.aborted
    : () => ffmpegService.isCancellationRequested();

  const throwIfCancelled = (): void => {
    if (shouldCancel()) throw new Error('Conversion cancelled by user');
  };

  // GIF without modern-gif: use FFmpeg directly
  if (format === 'gif' && !useModernGif && !shouldPreferFfmpegPalette) {
    logger.info('conversion', 'GIF format: using direct FFmpeg path', {
      fileSize: file.size,
      format,
    });
    await ffmpegService.initialize();
    const blob = await ffmpegService.convertToGIF(file, options, metadata);
    (blob as ConversionOutputBlob).encoderBackendUsed = 'ffmpeg';
    return blob as ConversionOutputBlob;
  }

  throwIfCancelled();

  let encoderBackendUsed: string | null = null;
  const decoder = new WebCodecsDecoderService();
  const capturedFrames: ImageData[] = [];
  const gifFrameTimestamps: number[] = [];
  const webpCapturedFrames: EncoderFrame[] = [];
  const webpFrameTimestamps: number[] = [];

  const frameFormat: WebCodecsFrameFormat =
    format === 'webp' && typeof createImageBitmap === 'function' ? 'bitmap' : 'rgba';

  const releaseWebPFrames = (): void => {
    for (const frame of webpCapturedFrames) {
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
  };

  const keyframeOnly = format === 'gif' && quality === 'low';

  if (keyframeOnly) {
    logger.info('conversion', 'Using keyframe-only fast path', { format, quality });
  }

  const presetFps = 'fps' in settings ? settings.fps : 15;
  const targetFps =
    metadata?.framerate && metadata.framerate > 0
      ? getOptimalFPS(metadata.framerate, quality, format)
      : presetFps;

  const decodeStart = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.DECODE_START;
  const decodeEnd = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.DECODE_END;
  const StatusTickIntervalMs = 400;

  const decodeReporter = createThrottledProgressReporter({
    startPercent: decodeStart,
    endPercent: decodeEnd,
    tickIntervalMs: StatusTickIntervalMs,
    initialStatusPrefix: 'Decoding with WebCodecs...',
    throwIfCancelled,
    reportProgress: (percent) => ffmpegService.reportProgress(percent),
    reportStatus: (status) => ffmpegService.reportStatus(status),
  });

  const reportDecodeProgress = decodeReporter.report;

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
    // Hybrid path: WebCodecs decode → FFmpeg palette encode
    if (shouldPreferFfmpegPalette) {
      try {
        const hybridResult = await encodeWithFFmpegFallback({
          format: 'gif',
          file,
          options,
          metadata,
          errorMessage: 'User preference: ffmpeg-palette',
          decoder,
          targetFps,
          scale,
          reportDecodeProgress,
          shouldCancel,
          throwIfCancelled,
          resetCaptureCollections: () => {
            capturedFrames.length = 0;
            gifFrameTimestamps.length = 0;
            releaseWebPFrames();
            webpCapturedFrames.length = 0;
            webpFrameTimestamps.length = 0;
          },
          intent: 'preferred',
          allowFFmpegDirectFallback: false,
        });
        endConversion();
        return hybridResult;
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        if (
          errorMessage.includes('cancelled by user') ||
          (ffmpegService.isCancellationRequested() &&
            errorMessage.includes('called FFmpeg.terminate()'))
        ) {
          throw error;
        }
        if (!useModernGif) throw error;
        logger.warn('conversion', 'FFmpeg palette path failed; falling back to modern-gif', {
          codec: metadata?.codec,
          error: errorMessage,
        });
      }
    }

    // Direct WebCodecs path for complex codecs (WebP only)
    if (format === 'webp' && shouldUseWebCodecsPath(metadata)) {
      try {
        const webCodecsResult = await convertViaWebCodecsFrames({
          decoder,
          file,
          format,
          options,
          targetFps,
          scale,
          metadata,
          reportDecodeProgress,
          capturedFrames,
          shouldCancel,
        });
        if (webCodecsResult) {
          endConversion();
          return webCodecsResult;
        }
        logger.warn(
          'conversion',
          'WebCodecs direct path produced no output; continuing with standard path',
          {
            codec: metadata?.codec,
          }
        );
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        if (
          errorMessage.includes('cancelled by user') ||
          (ffmpegService.isCancellationRequested() &&
            errorMessage.includes('called FFmpeg.terminate()'))
        ) {
          throw error;
        }
        logger.warn('conversion', 'WebCodecs direct path errored; continuing with standard path', {
          error: errorMessage,
          codec: metadata?.codec,
        });
      }
    }

    // Standard WebCodecs decode path
    ffmpegService.reportStatus('Decoding with WebCodecs...');
    ffmpegService.reportProgress(decodeStart);

    const captureModes: WebCodecsCaptureMode[] = [
      'auto',
      'demuxer',
      'track',
      'seek',
      'frame-callback',
    ];
    let captureModeUsed: WebCodecsCaptureMode | null = null;
    let decodeResult: Awaited<ReturnType<WebCodecsDecoderService['decodeToFrames']>> | null = null;

    for (const captureMode of captureModes) {
      try {
        throwIfCancelled();

        decodeResult = await decoder.decodeToFrames({
          file,
          targetFps,
          scale,
          frameFormat,
          frameQuality: FFMPEG_INTERNALS.WEBCODECS.FRAME_QUALITY,
          framePrefix: FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_PREFIX,
          frameDigits: FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_DIGITS,
          frameStartNumber: FFMPEG_INTERNALS.WEBCODECS.FRAME_START_NUMBER,
          // Compute effective duration considering trim
          trimStartSeconds: options.trimStart,
          maxFrames: (() => {
            if (format !== 'webp') {
              // Compute effective duration for non-WebP formats to limit frame capture.
              // Use the demuxer's own container-metadata duration, not the FFmpeg-probed
              // metadata.duration which can differ, causing frame count mismatches.
              // When the demuxer is used, it determines its own budget from container metadata.
              // When a non-demuxer mode falls back, video.duration is used.
              return undefined;
            }
            const trimEffectiveDuration = computeTrimDuration(
              options.trimStart,
              options.trimEnd,
              metadata?.duration
            );
            return getMaxWebPFrames(targetFps, trimEffectiveDuration);
          })(),
          captureMode,
          codec: metadata?.codec,
          quality: options.quality,
          keyframeOnly,
          shouldCancel,
          onProgress: reportDecodeProgress,
          onFrame: async (frame: {
            bitmap?: ImageBitmap;
            imageData?: ImageData;
            timestamp: number;
          }) => {
            throwIfCancelled();
            if (format === 'webp') {
              const encoderFrame = frame.bitmap ?? frame.imageData;
              if (!encoderFrame) {
                throw new Error('WebCodecs did not provide a usable frame payload for WebP.');
              }
              webpCapturedFrames.push(encoderFrame);
              webpFrameTimestamps.push(frame.timestamp);
              return;
            }
            if (!frame.imageData) {
              throw new Error('WebCodecs did not provide raw frame data.');
            }
            capturedFrames.push(frame.imageData);
            gifFrameTimestamps.push(frame.timestamp);
          },
        });

        captureModeUsed = captureMode;
        break;
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        if (
          errorMessage.includes('cancelled by user') ||
          (ffmpegService.isCancellationRequested() &&
            errorMessage.includes('called FFmpeg.terminate()'))
        ) {
          throw error;
        }
        logger.warn('conversion', 'WebCodecs frame capture failed', {
          error: errorMessage,
          mode: captureMode,
        });
        capturedFrames.length = 0;
        gifFrameTimestamps.length = 0;
        releaseWebPFrames();
        webpCapturedFrames.length = 0;
        webpFrameTimestamps.length = 0;

        if (captureMode === 'seek') throw error;
      }
    }

    if (!decodeResult?.frameCount) {
      throw new Error('WebCodecs decode produced no frames.');
    }

    ffmpegService.reportProgress(decodeEnd);

    const encodeStart = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START;
    const encodeEnd = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_END;
    const initialEncodeStatusPrefix = `Encoding ${format.toUpperCase()}...`;

    const shouldUseIndeterminateEncodeHeartbeat = format === 'gif' && useModernGif;

    const estimateModernGifEncodeSeconds = (params: {
      frameCount: number;
      width: number;
      height: number;
      quality: ConversionOptions['quality'];
    }): number => {
      const { frameCount, width, height, quality } = params;
      const megapixelFrames = (width * height * Math.max(1, frameCount)) / 1_000_000;
      const mpFramesPerSecond = quality === 'high' ? 5 : quality === 'medium' ? 6.5 : 8;
      const seconds = Math.round(megapixelFrames / mpFramesPerSecond);
      return Math.min(120, Math.max(5, seconds));
    };

    const startEncodeHeartbeat = (params: {
      frameCount: number;
      width: number;
      height: number;
      quality: ConversionOptions['quality'];
    }): ReturnType<typeof setInterval> => {
      ffmpegService.reportStatus(initialEncodeStatusPrefix);
      ffmpegService.reportProgress(encodeStart);
      const estimatedSeconds = estimateModernGifEncodeSeconds(params);
      return ffmpegService.startProgressHeartbeat(encodeStart, encodeEnd, estimatedSeconds);
    };

    const stopEncodeHeartbeat = (intervalId: ReturnType<typeof setInterval> | null): void => {
      if (intervalId) ffmpegService.stopProgressHeartbeat(intervalId);
    };

    const encodeReporter = shouldUseIndeterminateEncodeHeartbeat
      ? null
      : createThrottledProgressReporter({
          startPercent: encodeStart,
          endPercent: encodeEnd,
          tickIntervalMs: StatusTickIntervalMs,
          initialStatusPrefix: initialEncodeStatusPrefix,
          throwIfCancelled,
          reportProgress: (percent) => ffmpegService.reportProgress(percent),
          reportStatus: (status) => ffmpegService.reportStatus(status),
        });

    if (encodeReporter) {
      encodeReporter.setStatusPrefix(initialEncodeStatusPrefix);
    }

    const reportEncodeProgress = encodeReporter?.report;

    const doFFmpegFallback = async (errorMessage: string): Promise<Blob> => {
      throwIfCancelled();
      encoderBackendUsed = 'ffmpeg';
      return encodeWithFFmpegFallback({
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
        resetCaptureCollections: () => {
          capturedFrames.length = 0;
          gifFrameTimestamps.length = 0;
          releaseWebPFrames();
          webpCapturedFrames.length = 0;
          webpFrameTimestamps.length = 0;
        },
      });
    };

    let outputBlob: Blob;

    if (useModernGif) {
      const pool = await getWorkerPool();
      if (pool) {
        try {
          const serializableFrames = capturedFrames.map((frame) => ({
            data: frame.data,
            width: frame.width,
            height: frame.height,
            colorSpace: frame.colorSpace,
          }));

          const encodeHeartbeat = shouldUseIndeterminateEncodeHeartbeat
            ? startEncodeHeartbeat({
                frameCount: serializableFrames.length,
                width: decodeResult.width,
                height: decodeResult.height,
                quality,
              })
            : null;

          const progressProxy = reportEncodeProgress
            ? Comlink.proxy((current: number, total: number) => {
                reportEncodeProgress(current, total);
              })
            : undefined;

          try {
            const workerEncodeTimeoutMs = Math.min(
              10 * 60 * 1000,
              Math.max(90 * 1000, 20 * 1000 + serializableFrames.length * 500)
            );

            outputBlob = await pool.execute(
              async (worker) => {
                return worker.encode(
                  serializableFrames,
                  {
                    width: decodeResult.width,
                    height: decodeResult.height,
                    fps: targetFps,
                    quality,
                    timestamps: gifFrameTimestamps,
                    durationSeconds: decodeResult.duration,
                  },
                  progressProxy
                );
              },
              { signal: abortSignal, timeoutMs: workerEncodeTimeoutMs }
            );
            ffmpegService.reportProgress(encodeEnd);
          } finally {
            stopEncodeHeartbeat(encodeHeartbeat);
          }
          encoderBackendUsed = 'modern-gif-worker';
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          logger.warn('conversion', 'GIF worker encoding failed, retrying on main thread', {
            error: errorMessage,
          });
          try {
            const encodeHeartbeat = shouldUseIndeterminateEncodeHeartbeat
              ? startEncodeHeartbeat({
                  frameCount: capturedFrames.length,
                  width: decodeResult.width,
                  height: decodeResult.height,
                  quality,
                })
              : null;
            try {
              outputBlob = await encodeModernGif(capturedFrames, {
                width: decodeResult.width,
                height: decodeResult.height,
                fps: targetFps,
                quality,
                timestamps: gifFrameTimestamps,
                durationSeconds: decodeResult.duration,
                onProgress: reportEncodeProgress,
                shouldCancel,
              });
              ffmpegService.reportProgress(encodeEnd);
              encoderBackendUsed = 'modern-gif-main';
            } finally {
              stopEncodeHeartbeat(encodeHeartbeat);
            }
          } catch (fallbackError) {
            const fallbackMessage = getErrorMessage(fallbackError);
            outputBlob = await doFFmpegFallback(fallbackMessage);
          }
        }
      } else {
        // No worker pool: main thread only
        try {
          const encodeHeartbeat = shouldUseIndeterminateEncodeHeartbeat
            ? startEncodeHeartbeat({
                frameCount: capturedFrames.length,
                width: decodeResult.width,
                height: decodeResult.height,
                quality,
              })
            : null;
          try {
            outputBlob = await encodeModernGif(capturedFrames, {
              width: decodeResult.width,
              height: decodeResult.height,
              fps: targetFps,
              quality,
              timestamps: gifFrameTimestamps,
              durationSeconds: decodeResult.duration,
              onProgress: reportEncodeProgress,
              shouldCancel,
            });
            ffmpegService.reportProgress(encodeEnd);
            encoderBackendUsed = 'modern-gif-main';
          } finally {
            stopEncodeHeartbeat(encodeHeartbeat);
          }
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          outputBlob = await doFFmpegFallback(errorMessage);
        }
      }
    } else if (format === 'webp') {
      if (!encodeReporter) {
        throw new Error('Encode reporter unavailable for WebP encoding.');
      }

      const webpAnimationDurationSeconds = resolveAnimationDurationSeconds(
        webpCapturedFrames.length,
        targetFps,
        metadata,
        decodeResult.duration,
        trimDurationSeconds
      );

      const webpFpsForEncoding = resolveWebPFps(
        webpCapturedFrames.length,
        targetFps,
        webpAnimationDurationSeconds
      );

      const webpEncode = await encodeWebPWithMuxFallback({
        frames: webpCapturedFrames,
        width: decodeResult.width,
        height: decodeResult.height,
        fps: webpFpsForEncoding,
        requestedTargetFpsForDuration: targetFps,
        captureDurationSeconds: decodeResult.duration,
        quality,
        frameTimestampsForMuxer: webpFrameTimestamps,
        metadata,
        codec: metadata?.codec,
        onProgress: encodeReporter.report,
        shouldCancel,
        canEncodeWebPFrames: () => getCanvasWebPEncodeSupport(),
        setStatusPrefix: (prefix) => encodeReporter.setStatusPrefix(prefix),
        encodeWithFFmpegFallback: doFFmpegFallback,
      });

      outputBlob = webpEncode.blob;
      encoderBackendUsed = webpEncode.encoderBackendUsed;
      releaseWebPFrames();
      webpCapturedFrames.length = 0;
      webpFrameTimestamps.length = 0;
    } else {
      outputBlob = await doFFmpegFallback('Unexpected encoder path');
    }

    const completionProgress =
      format === 'gif'
        ? FFMPEG_INTERNALS.PROGRESS.GIF.COMPLETE
        : FFMPEG_INTERNALS.PROGRESS.WEBP.COMPLETE;
    ffmpegService.reportProgress(completionProgress);

    if (capturedFrames.length > 0 && (useModernGif || format === 'webp')) {
      capturedFrames.length = 0;
    }

    const outputBlobWithMetadata = outputBlob as ConversionOutputBlob;
    if (captureModeUsed) outputBlobWithMetadata.captureModeUsed = captureModeUsed;
    if (encoderBackendUsed) outputBlobWithMetadata.encoderBackendUsed = encoderBackendUsed;

    return outputBlobWithMetadata;
  } finally {
    try {
      releaseWebPFrames();
    } catch {
      /* non-fatal */
    }
    webpCapturedFrames.length = 0;
    gifFrameTimestamps.length = 0;

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
  }
}

async function convertViaWebCodecsFrames(params: {
  decoder: WebCodecsDecoderService;
  file: File;
  format: 'gif' | 'webp';
  options: ConversionOptions;
  targetFps: number;
  scale: number;
  metadata?: VideoMetadata;
  reportDecodeProgress: (current: number, total: number) => void;
  capturedFrames?: ImageData[];
  shouldCancel?: () => boolean;
}): Promise<Blob | null> {
  const {
    decoder,
    file,
    format,
    options,
    targetFps,
    scale,
    metadata,
    reportDecodeProgress,
    shouldCancel,
  } = params;

  // Compute effective trim duration for WebP timing calculations (second occurrence)
  const trimDurationSeconds = computeTrimDuration(options.trimStart, options.trimEnd);

  const shouldCancelOrDefault = shouldCancel ?? (() => ffmpegService.isCancellationRequested());
  if (shouldCancelOrDefault()) throw new Error('Conversion cancelled by user');
  if (!shouldUseWebCodecsPath(metadata)) return null;
  if (format === 'gif') return null;

  const canEncodeWebPFrames = await getCanvasWebPEncodeSupport();
  if (!canEncodeWebPFrames) {
    logger.info('conversion', 'Skipping WebCodecs direct WebP path (canvas WebP unsupported)', {
      codec: metadata?.codec ?? 'unknown',
    });
    return null;
  }

  try {
    ffmpegService.reportStatus('Extracting frames via WebCodecs...');
    const throwIfCancelled = (): void => {
      if (shouldCancelOrDefault()) throw new Error('Conversion cancelled by user');
    };

    const { orderedFrames, timestamps, decodeResult, effectiveTargetFps } =
      await captureComplexCodecFramesForWebP({
        decoder,
        file,
        options,
        targetFps,
        scale,
        metadata,
        getMaxWebPFrames,
        reportDecodeProgress,
        shouldCancel: shouldCancelOrDefault,
        throwIfCancelled,
      });

    const StatusTickIntervalMs = 400;
    let lastEncodeStatusAt = 0;
    let lastEncodeStatusCurrent = -1;
    let encodeStatusPrefix = 'Encoding WebP frames...';
    ffmpegService.reportStatus(encodeStatusPrefix);

    const encStart = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START;
    const encEnd = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_END;
    const reportEncodeProgress = (current: number, total: number) => {
      if (shouldCancelOrDefault()) throw new Error('Conversion cancelled by user');
      const progress = encStart + ((encEnd - encStart) * current) / Math.max(1, total);
      ffmpegService.reportProgress(Math.round(progress));
      const now = performance.now();
      const isTerminal = current >= total;
      if (
        current !== lastEncodeStatusCurrent &&
        (isTerminal || now - lastEncodeStatusAt >= StatusTickIntervalMs)
      ) {
        lastEncodeStatusAt = now;
        lastEncodeStatusCurrent = current;
        ffmpegService.reportStatus(`${encodeStatusPrefix} (${current}/${Math.max(1, total)})`);
      }
    };

    const releaseCapturedFrames = (): void => {
      for (const frame of orderedFrames) {
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
    };

    try {
      const animationDurationSeconds = resolveAnimationDurationSeconds(
        orderedFrames.length,
        effectiveTargetFps,
        metadata,
        decodeResult.duration,
        trimDurationSeconds
      );

      const fpsForEncoding = resolveWebPFps(
        orderedFrames.length,
        effectiveTargetFps,
        animationDurationSeconds
      );

      const timestampsForEncoding =
        timestamps.length >= orderedFrames.length
          ? timestamps.slice(0, orderedFrames.length)
          : buildDurationAlignedTimestamps({
              frameCount: orderedFrames.length,
              durationSeconds: animationDurationSeconds ?? decodeResult.duration,
              fallbackFps: fpsForEncoding,
            });

      let outputBlob: Blob | null = null;
      let encoderBackendUsed: string | null = null;

      // Single-pass: convert → encode → ANMF chunk → assemble RIFF
      const streamingResult = await import('@services/webcodecs/webp/mux-webp-frames-service');

      encodeStatusPrefix = 'Encoding WebP frames...';
      ffmpegService.reportStatus(encodeStatusPrefix);

      outputBlob = await streamingResult.muxWebPFramesStreaming({
        frames: orderedFrames,
        timestamps: timestampsForEncoding,
        width: decodeResult.width,
        height: decodeResult.height,
        fps: fpsForEncoding,
        quality: options.quality,
        metadata,
        durationSeconds: animationDurationSeconds,
        codec: metadata?.codec,
        onProgress: reportEncodeProgress,
        shouldCancel: shouldCancelOrDefault,
      });

      encoderBackendUsed = 'webp-muxer-streaming';
      releaseCapturedFrames();

      if (!outputBlob) return null;

      const validation = await validateWebPBlob(outputBlob);
      if (!validation.valid) {
        logger.warn('conversion', 'WebCodecs direct WebP output failed validation', {
          codec: metadata?.codec ?? 'unknown',
          reason: validation.reason ?? 'validation_failed',
        });
        return null;
      }

      ffmpegService.reportProgress(FFMPEG_INTERNALS.PROGRESS.WEBP.COMPLETE);

      const outputBlobWithMetadata = outputBlob as ConversionOutputBlob;
      if (decodeResult.captureModeUsed) {
        outputBlobWithMetadata.captureModeUsed = decodeResult.captureModeUsed;
      }
      if (encoderBackendUsed) {
        outputBlobWithMetadata.encoderBackendUsed = encoderBackendUsed;
      }
      outputBlobWithMetadata.wasTranscoded = true;
      return outputBlobWithMetadata;
    } finally {
      releaseCapturedFrames();
    }
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    if (
      errorMessage.includes('cancelled by user') ||
      (ffmpegService.isCancellationRequested() &&
        errorMessage.includes('called FFmpeg.terminate()'))
    ) {
      throw error;
    }
    logger.error('conversion', 'WebCodecs direct path failed', {
      error: errorMessage,
      codec: metadata?.codec,
      format,
    });
    return null;
  }
}

export function cleanup(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  gifWorkerPool?.terminate();
  gifWorkerPool = null;
  gifWorkerPoolPromise = null;
  canvasWebPEncodeSupport = null;
}

/**
 * Schedule worker pool termination after a period of inactivity.
 * Cancels any existing timer and starts a new one.
 */
export function scheduleWorkerPoolIdleCleanup(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    logger.info('worker-pool', 'Worker pool idle timeout — terminating');
    cleanup();
  }, IDLE_TIMEOUT_MS);
}
