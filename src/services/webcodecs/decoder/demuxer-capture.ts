import type { VideoMetadata } from '@t/conversion-types';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

import { canvasToBlob, createCanvas } from '@services/webcodecs/decoder/canvas';
import { formatFrameName } from '@services/webcodecs/decoder/frame-naming';
import { createDemuxer } from '@services/webcodecs/demuxer/demuxer-factory';

import type {
  WebCodecsDecodeResult,
  WebCodecsFrameFormat,
  WebCodecsFramePayload,
  WebCodecsProgressCallback,
} from './types';

/**
 * Capture frames using external demuxer + WebCodecs VideoDecoder
 *
 * This method bypasses HTMLVideoElement entirely, extracting encoded samples
 * directly from the container and feeding them to VideoDecoder. This eliminates
 * seek overhead for codecs like AV1 where seeking is extremely slow.
 */
export async function captureWithDemuxer(
  file: File,
  targetFps: number,
  scale: number,
  frameFormat: WebCodecsFrameFormat,
  _frameQuality: number,
  framePrefix: string,
  frameDigits: number,
  frameStartNumber: number,
  maxFrames: number | undefined,
  quality: 'low' | 'medium' | 'high' | undefined,
  onFrame: (frame: WebCodecsFramePayload) => Promise<void>,
  onProgress?: WebCodecsProgressCallback,
  shouldCancel?: () => boolean,
  metadata?: VideoMetadata
): Promise<WebCodecsDecodeResult | null> {
  const demuxer = await createDemuxer(file, metadata);
  if (!demuxer) {
    return null;
  }

  let decoder: VideoDecoder | null = null;
  let decoderError: Error | null = null;
  const decodedFrames: VideoFrame[] = [];
  const frameFiles: string[] = [];
  let frameIndex = 0;

  try {
    // 1. Initialize demuxer and get video configuration
    const decoderConfig = await demuxer.initialize(file);
    const demuxerMetadata = demuxer.getMetadata();

    const targetWidth = Math.max(1, Math.round(decoderConfig.codedWidth * scale));
    const targetHeight = Math.max(1, Math.round(decoderConfig.codedHeight * scale));

    // maxFrames is a budget cap, not a promise that we can extract frames beyond the
    // media duration. Always bound the expected frame count to the demuxer-reported duration.
    const estimatedTotalFrames = Math.max(1, Math.ceil(demuxerMetadata.duration * targetFps));
    const totalFrames = maxFrames
      ? Math.min(maxFrames, estimatedTotalFrames)
      : estimatedTotalFrames;
    const requiredFramesForSuccess = Math.max(1, totalFrames - 1);

    // Dev-only diagnostics (rate-limited) to help debug demuxer decode stalls.
    const isDev = import.meta.env.DEV;
    const decodeStartedAtMs = Date.now();
    let lastOutputAtMs = decodeStartedAtMs;
    let outputFramesTotal = 0;
    let lastDevStatsAtMs = 0;
    const DevStatsIntervalMs = 5000;

    // When using a demuxer, we must decode all encoded samples in the time window
    // to preserve reference chains. We downsample AFTER decode by selecting decoded
    // frames based on timestamps.
    const captureIntervalMicros = Math.max(1, Math.round(1_000_000 / targetFps));
    const maxDurationSeconds = Math.min(demuxerMetadata.duration, totalFrames / targetFps);
    const maxDurationMicros = Math.round(maxDurationSeconds * 1_000_000);
    const durationSlackMicros = Math.round(1_000_000);
    let baseTimestampMicros: number | null = null;
    let nextCaptureTimestampMicros: number | null = null;
    let lastCapturedTimestampMicros: number | null = null;

    // If flush() hangs, prefer a partial demuxer result over a slow seek fallback,
    // but only when we captured enough frames and covered (most of) the time window.
    const PartialAcceptRatio = 0.75;
    const partialAcceptFrames = Math.max(
      2,
      Math.min(totalFrames, Math.max(8, Math.floor(totalFrames * PartialAcceptRatio)))
    );

    const hasCoveredTimeWindow = (): boolean => {
      if (baseTimestampMicros === null || lastCapturedTimestampMicros === null) {
        return false;
      }

      const targetEndMicros = baseTimestampMicros + maxDurationMicros;
      const toleranceMicros = Math.max(captureIntervalMicros, Math.round(durationSlackMicros / 2));
      return lastCapturedTimestampMicros >= targetEndMicros - toleranceMicros;
    };

    const canAcceptPartial = (): boolean => frameIndex >= partialAcceptFrames;

    // Progress keepalive: demuxer decoding can continue long after we stop incrementing
    // frameIndex (once the output budget is reached). Without periodic progress reports,
    // the shared watchdog can incorrectly terminate the run.
    const estimatedSamplesTotal = Math.max(
      1,
      Math.min(
        demuxerMetadata.sampleCount,
        Math.ceil(
          maxDurationSeconds *
            Math.max(
              1,
              demuxerMetadata.framerate ?? demuxerMetadata.sampleCount / maxDurationSeconds
            )
        )
      )
    );
    let processedSamples = 0;
    let lastProgressTickAt = 0;
    const ProgressTickIntervalMs = 400;

    const tickProgress = (forceComplete = false) => {
      if (!onProgress) {
        return;
      }

      if (forceComplete) {
        onProgress(totalFrames, totalFrames);
        return;
      }

      const now = Date.now();
      if (now - lastProgressTickAt < ProgressTickIntervalMs) {
        return;
      }
      lastProgressTickAt = now;

      // Map sample progress into the expected frame-progress shape.
      const ratio = processedSamples / estimatedSamplesTotal;
      const pseudoCurrent = Math.max(
        0,
        Math.min(
          Math.max(0, totalFrames - 1),
          Math.floor(Math.min(1, Math.max(0, ratio)) * Math.max(1, totalFrames))
        )
      );
      onProgress(pseudoCurrent, totalFrames);
    };

    logger.info('conversion', 'Demuxer initialized', {
      codec: decoderConfig.codec,
      width: decoderConfig.codedWidth,
      height: decoderConfig.codedHeight,
      duration: demuxerMetadata.duration,
      sourceFps: demuxerMetadata.framerate,
      targetFps,
      totalFrames,
    });

    const maybeLogDevStats = (phase: string, extra?: Record<string, unknown>) => {
      if (!isDev) {
        return;
      }

      const now = Date.now();
      if (now - lastDevStatsAtMs < DevStatsIntervalMs) {
        return;
      }
      lastDevStatsAtMs = now;

      logger.debug('conversion', 'Demuxer decode stats', {
        phase,
        elapsedMs: now - decodeStartedAtMs,
        processedSamples,
        estimatedSamplesTotal,
        frameIndex,
        requiredFramesForSuccess,
        totalFrames,
        decodedFramesBuffered: decodedFrames.length,
        outputFramesTotal,
        decodeQueueSize: decoder?.decodeQueueSize ?? null,
        msSinceLastOutput: now - lastOutputAtMs,
        ...extra,
      });
    };

    // 2. Create canvas for frame capture
    const captureContext = createCanvas(targetWidth, targetHeight, frameFormat === 'rgba');
    const shouldUseJpeg =
      frameFormat !== 'rgba' &&
      frameFormat !== 'bitmap' &&
      (quality === 'low' || quality === 'medium');

    // 3. Create VideoDecoder
    // Collect decoded frames and process them after batched flushes.
    // Flushing once per sample is significantly slower on some browsers.
    decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        decodedFrames.push(frame);
        outputFramesTotal += 1;
        lastOutputAtMs = Date.now();
      },
      error: (error: Error) => {
        // Do not throw from this callback. It can surface as an uncaught
        // exception and bypass our async error handling.
        const wrapped = error instanceof Error ? error : new Error(getErrorMessage(error));
        decoderError = wrapped;
        logger.error('conversion', 'VideoDecoder error', {
          error: getErrorMessage(wrapped),
        });
      },
    });

    // Prefer hardware decoding when possible. Some environments support AV1 playback
    // in <video> but not in WebCodecs, and some support WebCodecs AV1 only in software.
    // This selection improves performance on GPUs that can decode AV1 while preserving
    // a safe fallback.
    const selectDecoderConfig = async (): Promise<VideoDecoderConfig> => {
      if (
        typeof VideoDecoder === 'undefined' ||
        typeof VideoDecoder.isConfigSupported !== 'function'
      ) {
        return decoderConfig;
      }

      type DecoderConfigWithAcceleration = VideoDecoderConfig & {
        hardwareAcceleration?: 'prefer-hardware' | 'prefer-software';
      };

      const baseConfig = decoderConfig as DecoderConfigWithAcceleration;

      // If the demuxer already provided a preference, keep it.
      if (baseConfig.hardwareAcceleration) {
        return decoderConfig;
      }

      const candidates: DecoderConfigWithAcceleration[] = [
        { ...baseConfig, hardwareAcceleration: 'prefer-hardware' },
        { ...baseConfig, hardwareAcceleration: 'prefer-software' },
        baseConfig,
      ];

      for (const candidate of candidates) {
        try {
          const support = await VideoDecoder.isConfigSupported(candidate as VideoDecoderConfig);
          if (support.supported) {
            if (isDev) {
              logger.debug('conversion', 'Selected VideoDecoder config', {
                codec: candidate.codec,
                width: candidate.codedWidth,
                height: candidate.codedHeight,
                hardwareAcceleration: candidate.hardwareAcceleration ?? null,
                usedSupportConfig: Boolean(support.config),
              });
            }
            return (support.config ?? candidate) as VideoDecoderConfig;
          }
        } catch (error) {
          if (isDev) {
            logger.debug('conversion', 'VideoDecoder.isConfigSupported failed for candidate', {
              codec: candidate.codec,
              hardwareAcceleration: candidate.hardwareAcceleration ?? null,
              error: getErrorMessage(error),
            });
          }
        }
      }

      return decoderConfig;
    };

    const selectedDecoderConfig = await selectDecoderConfig();
    decoder.configure(selectedDecoderConfig);

    const processDecodedFrames = async () => {
      if (!decodedFrames.length) {
        return;
      }

      if (decoderError) {
        throw decoderError;
      }

      // Snapshot to avoid races with the synchronous output callback.
      const framesToProcess = decodedFrames.splice(0);

      for (const videoFrame of framesToProcess) {
        try {
          if (shouldCancel?.()) {
            throw new Error('Conversion cancelled by user');
          }

          if (decoderError) {
            throw decoderError;
          }

          // Stop capturing once we've hit our output budget.
          if (frameIndex >= totalFrames) {
            continue;
          }

          const timestampMicros = videoFrame.timestamp;
          if (baseTimestampMicros === null) {
            baseTimestampMicros = timestampMicros;
            nextCaptureTimestampMicros = timestampMicros;
          }

          // Respect the requested time window (derived from maxFrames/targetFps).
          if (
            timestampMicros >
            baseTimestampMicros + maxDurationMicros + durationSlackMicros + captureIntervalMicros
          ) {
            continue;
          }

          // Timestamp-based sampling: capture the first decoded frame at/after each interval.
          // Do not capture early, otherwise we may hit the frame budget before we cover
          // the full time window and trigger a fallback.
          const nextTs = nextCaptureTimestampMicros ?? timestampMicros;
          if (timestampMicros < nextTs) {
            continue;
          }

          const timestampSeconds = timestampMicros / 1_000_000;

          // Draw VideoFrame to canvas
          captureContext.context.drawImage(
            videoFrame,
            0,
            0,
            captureContext.targetWidth,
            captureContext.targetHeight
          );

          // Extract frame data (PNG/JPEG/RGBA/ImageBitmap)
          let data: Uint8Array | undefined;
          let imageData: ImageData | undefined;
          let bitmap: ImageBitmap | undefined;

          if (frameFormat === 'rgba') {
            imageData = captureContext.context.getImageData(
              0,
              0,
              captureContext.targetWidth,
              captureContext.targetHeight
            );
          } else if (frameFormat === 'bitmap') {
            if (typeof createImageBitmap !== 'function') {
              throw new Error('createImageBitmap is not available for bitmap frame capture');
            }
            bitmap = await createImageBitmap(captureContext.canvas);
          } else {
            const encodeMimeType = shouldUseJpeg ? 'image/jpeg' : 'image/png';
            const encodeQuality = shouldUseJpeg ? (quality === 'low' ? 0.75 : 0.85) : undefined;
            const blob = await canvasToBlob(captureContext.canvas, encodeMimeType, encodeQuality);
            data = new Uint8Array(await blob.arrayBuffer());
          }

          // Use actual encoded format for filename extension to match blob content
          // Critical: FFmpeg PNG decoder fails on JPEG data (signature 0xFFD8FFE0 vs 0x89504E47)
          const actualFormat =
            frameFormat === 'rgba'
              ? 'rgba'
              : frameFormat === 'bitmap'
                ? 'bitmap'
                : shouldUseJpeg
                  ? 'jpeg'
                  : 'png';
          const frameName = formatFrameName(
            framePrefix,
            frameDigits,
            frameIndex,
            frameStartNumber,
            actualFormat
          );

          await onFrame({
            name: frameName,
            data,
            imageData,
            bitmap,
            index: frameIndex,
            timestamp: timestampSeconds,
          });

          frameFiles.push(frameName);
          lastCapturedTimestampMicros = timestampMicros;
          frameIndex++;
          onProgress?.(frameIndex, totalFrames);

          // Advance the capture cursor. If the decoded timestamp is far ahead
          // (e.g., variable frame pacing), skip multiple intervals at once.
          if (nextCaptureTimestampMicros !== null) {
            const intervalsPassed = Math.max(
              1,
              Math.floor((timestampMicros - nextCaptureTimestampMicros) / captureIntervalMicros) + 1
            );
            nextCaptureTimestampMicros += intervalsPassed * captureIntervalMicros;
          }
        } finally {
          videoFrame.close();
        }
      }
    };

    // Some browsers throw if a non-keyframe is decoded immediately after a flush.
    // To maximize compatibility (especially for AV1), we only flush once at the end
    // and apply backpressure via decodeQueueSize + cooperative yielding.
    const MaxDecodeQueueSize = 16;
    const MaxPendingOutputFrames = 6;
    let needsKeyFrame = true;
    let skippedUntilKey = 0;

    // 4. Extract and decode samples
    for await (const sample of demuxer.extractSamples(targetFps, maxFrames)) {
      if (shouldCancel?.()) {
        throw new Error('Conversion cancelled by user');
      }

      if (decoderError) {
        throw decoderError;
      }

      // Ensure the first decoded chunk after configure() is a keyframe.
      if (needsKeyFrame) {
        if (sample.type !== 'key') {
          skippedUntilKey += 1;
          processedSamples += 1;
          tickProgress();
          maybeLogDevStats('waiting-for-keyframe', { skippedUntilKey });
          continue;
        }

        if (skippedUntilKey > 0) {
          logger.warn('conversion', 'Skipping non-key samples until first keyframe', {
            skippedSamples: skippedUntilKey,
            codec: decoderConfig.codec,
          });
        }
        needsKeyFrame = false;
      }

      processedSamples += 1;
      tickProgress();
      maybeLogDevStats('decode-loop');

      const chunk = new EncodedVideoChunk({
        type: sample.type,
        timestamp: sample.timestamp,
        duration: sample.duration,
        data: sample.data,
      });

      try {
        decoder.decode(chunk);
      } catch (error) {
        // decoder.decode can throw synchronously (e.g., keyframe required).
        throw error instanceof Error ? error : new Error(getErrorMessage(error));
      }

      if (decoderError) {
        throw decoderError;
      }

      // Opportunistically process output frames without flushing.
      if (decodedFrames.length >= MaxPendingOutputFrames) {
        await processDecodedFrames();

        maybeLogDevStats('output-drain');

        if (frameIndex >= requiredFramesForSuccess) {
          logger.info('conversion', 'Demuxer output budget reached; stopping decode early', {
            frameCount: frameIndex,
            requiredFrames: requiredFramesForSuccess,
            totalFrames,
            processedSamples,
          });
          break;
        }
      }

      // Backpressure: yield control to allow decoder output callbacks to run.
      if (decoder.decodeQueueSize > MaxDecodeQueueSize) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await processDecodedFrames();
        tickProgress();
        maybeLogDevStats('backpressure-yield');

        if (frameIndex >= requiredFramesForSuccess) {
          logger.info('conversion', 'Demuxer output budget reached; stopping decode early', {
            frameCount: frameIndex,
            requiredFrames: requiredFramesForSuccess,
            totalFrames,
            processedSamples,
            decodeQueueSize: decoder.decodeQueueSize,
          });
          break;
        }
      }
    }

    // Final drain
    // Always process any frames already emitted.
    await processDecodedFrames();
    maybeLogDevStats('pre-drain');

    // If we already have enough frames (or we covered the time window with a reasonable
    // number of frames), avoid flush(). Some browsers can hang indefinitely in flush()
    // for certain AV1 streams.
    const hasEnoughFramesForFullResult = frameIndex >= requiredFramesForSuccess;
    const coveredTimeWindow = hasCoveredTimeWindow();
    const acceptPartialByTimeWindow = coveredTimeWindow && canAcceptPartial();
    const skipFlush = hasEnoughFramesForFullResult || acceptPartialByTimeWindow;

    if (skipFlush) {
      if (!hasEnoughFramesForFullResult && acceptPartialByTimeWindow) {
        logger.warn('conversion', 'Accepting partial demuxer result (time window covered)', {
          frameCount: frameIndex,
          totalFrames,
          requiredFrames: requiredFramesForSuccess,
          partialAcceptFrames,
          processedSamples,
          estimatedSamplesTotal,
        });
      }
      tickProgress(true);
    } else {
      const FlushTimeoutMs = 12_000;

      const hasProcessedAllSamples = (): boolean => processedSamples >= estimatedSamplesTotal;

      logger.debug('conversion', 'Draining VideoDecoder', {
        frameCount: frameIndex,
        requiredFrames: requiredFramesForSuccess,
        totalFrames,
        processedSamples,
        decodeQueueSize: decoder.decodeQueueSize,
        timeoutMs: FlushTimeoutMs,
      });

      // Some browsers will continue delivering decoded frames while flush() is pending.
      // If we don't actively drain + process those frames, frameIndex can stall and we
      // may incorrectly fall back to a very slow seek-based capture.
      const flushPromise = decoder.flush();
      const flushStartedAtMs = Date.now();
      let flushSettled = false;
      let flushError: unknown | null = null;
      flushPromise.then(
        () => {
          flushSettled = true;
        },
        (error) => {
          flushError = error;
          flushSettled = true;
        }
      );

      const FlushPollIntervalMs = 50;
      while (!flushSettled && Date.now() - flushStartedAtMs < FlushTimeoutMs) {
        await new Promise<void>((resolve) => setTimeout(resolve, FlushPollIntervalMs));
        await processDecodedFrames();
        tickProgress();
        maybeLogDevStats('drain-wait', {
          flushElapsedMs: Date.now() - flushStartedAtMs,
          baseTimestampMicros,
          lastCapturedTimestampMicros,
        });
      }

      if (!flushSettled) {
        // Suppress potential unhandled rejection if flush later resolves/rejects.
        void flushPromise.catch(() => undefined);

        // Process any frames already emitted while we were waiting.
        await processDecodedFrames();

        logger.warn('conversion', 'VideoDecoder flush timed out; evaluating partial success', {
          frameCount: frameIndex,
          requiredFrames: requiredFramesForSuccess,
          totalFrames,
          partialAcceptFrames,
          processedSamples,
          estimatedSamplesTotal,
          decodeQueueSize: decoder.decodeQueueSize,
          baseTimestampMicros,
          lastCapturedTimestampMicros,
          timeoutMs: FlushTimeoutMs,
        });

        // If we made substantial progress, prefer a partial demuxer result over a slow
        // seek-based fallback. If all samples were already fed, there's little value in
        // redoing extraction via playback.
        const acceptPartial =
          frameIndex >= requiredFramesForSuccess ||
          ((hasCoveredTimeWindow() || hasProcessedAllSamples()) && canAcceptPartial());

        if (acceptPartial) {
          tickProgress(true);

          logger.warn('conversion', 'Accepting partial demuxer result after flush timeout', {
            frameCount: frameIndex,
            totalFrames,
            partialAcceptFrames,
            processedSamples,
            coveredTimeWindow: hasCoveredTimeWindow(),
            processedAllSamples: hasProcessedAllSamples(),
          });

          logger.info('conversion', 'Demuxer capture completed (partial)', {
            frameCount: frameIndex,
            duration: demuxerMetadata.duration,
            avgFps: frameIndex / demuxerMetadata.duration,
          });

          const effectiveFps =
            demuxerMetadata.duration > 0 ? frameIndex / demuxerMetadata.duration : targetFps;

          return {
            frameFiles,
            frameCount: frameIndex,
            captureModeUsed: 'demuxer',
            width: targetWidth,
            height: targetHeight,
            fps: effectiveFps,
            duration: demuxerMetadata.duration,
          };
        }

        throw new Error(`VideoDecoder flush timed out after ${Math.round(FlushTimeoutMs / 1000)}s`);
      }

      if (flushError) {
        throw flushError instanceof Error ? flushError : new Error(getErrorMessage(flushError));
      }

      maybeLogDevStats('drain-flushed', {
        flushElapsedMs: Date.now() - flushStartedAtMs,
      });

      if (decoderError) {
        throw decoderError;
      }

      await processDecodedFrames();
      tickProgress(true);
    }

    // Post-condition: only accept partial demuxer results when we covered the requested
    // time window with a reasonable number of frames.
    // Otherwise, throw to allow a fallback capture mode (e.g., media-element seek).
    const coveredTimeWindowFinal = hasCoveredTimeWindow();
    const acceptPartialFinal = coveredTimeWindowFinal && frameIndex >= partialAcceptFrames;
    const hasFullResultFinal = frameIndex >= requiredFramesForSuccess;

    if (!hasFullResultFinal && !acceptPartialFinal) {
      logger.warn('conversion', 'Demuxer capture incomplete; falling back to non-demuxer path', {
        frameCount: frameIndex,
        totalFrames,
        requiredFrames: requiredFramesForSuccess,
        partialAcceptFrames,
        processedSamples,
        estimatedSamplesTotal,
        coveredTimeWindow: coveredTimeWindowFinal,
      });
      throw new Error('Demuxer capture incomplete');
    }

    const completedAsPartial = frameIndex < requiredFramesForSuccess;
    logger.info(
      'conversion',
      completedAsPartial ? 'Demuxer capture completed (partial)' : 'Demuxer capture completed',
      {
        frameCount: frameIndex,
        duration: demuxerMetadata.duration,
        avgFps: frameIndex / demuxerMetadata.duration,
        totalFrames,
        requiredFrames: requiredFramesForSuccess,
        partialAcceptFrames,
        coveredTimeWindow: coveredTimeWindowFinal,
      }
    );

    const effectiveFps =
      demuxerMetadata.duration > 0 ? frameIndex / demuxerMetadata.duration : targetFps;

    return {
      frameFiles,
      frameCount: frameIndex,
      captureModeUsed: 'demuxer',
      width: targetWidth,
      height: targetHeight,
      fps: effectiveFps,
      duration: demuxerMetadata.duration,
    };
  } finally {
    // Cleanup resources
    for (const frame of decodedFrames) {
      try {
        frame.close();
      } catch {
        // Ignore.
      }
    }
    decodedFrames.length = 0;

    try {
      decoder?.close();
    } catch {
      // Some browsers may close the codec on error; ignore double-close.
    }

    try {
      demuxer?.destroy();
    } catch (error) {
      logger.debug('conversion', 'Demuxer destroy failed (non-fatal)', {
        error: getErrorMessage(error),
      });
    }
  }
}
