import type { ConversionOptions, VideoMetadata } from '@t/conversion-types';
import { getErrorMessage } from '@utils/error-utils';
import { isHardwareCacheValid } from '@utils/hardware-profile';
import { logger } from '@utils/logger';
import {
  cacheCaptureMode,
  cacheCapturePerformance,
  getCachedCaptureMode,
  getCachedCapturePerformance,
} from '@utils/session-cache';

import type {
  WebCodecsCaptureMode,
  WebCodecsDecoderService,
  WebCodecsFrameFormat,
} from '@services/webcodecs-decoder-service';
import { canUseDemuxer, detectContainer } from '@services/webcodecs/demuxer/demuxer-factory';
import {
  AV1_FRAME_CALLBACK_FAILURE_KEY,
  getAv1CaptureFpsCap,
  getAv1SeekFpsCap,
  readSessionStorageNumber,
  supportsRequestVideoFrameCallback,
  writeSessionStorageNumber,
} from './av1-capture-policy';
import {
  computeExpectedFramesFromDuration,
  computeRequiredFramesFromExpected,
} from './frame-requirements';

export async function captureComplexCodecFramesForWebP(params: {
  decoder: WebCodecsDecoderService;
  file: File;
  options: ConversionOptions;
  targetFps: number;
  scale: number;
  metadata?: VideoMetadata;
  getMaxWebPFrames: (targetFps: number, durationSeconds?: number) => number;
  reportDecodeProgress: (current: number, total: number) => void;
  shouldCancel: () => boolean;
  throwIfCancelled: () => void;
}): Promise<{
  orderedImageData: ImageData[];
  decodeResult: Awaited<ReturnType<WebCodecsDecoderService['decodeToFrames']>>;
  effectiveTargetFps: number;
}> {
  const {
    decoder,
    file,
    options,
    targetFps,
    scale,
    metadata,
    getMaxWebPFrames,
    reportDecodeProgress,
    shouldCancel,
    throwIfCancelled,
  } = params;

  throwIfCancelled();

  // Collect frames by index to avoid duplicates and ensure stable ordering.
  const framesByIndex: Array<{ imageData: ImageData; timestamp: number } | undefined> = [];

  const requestedTargetFps = targetFps;
  const normalizedCodec = metadata?.codec?.toLowerCase() ?? '';
  const isAv1 = normalizedCodec.includes('av1') || normalizedCodec.includes('av01');
  const supportsFrameCallback = supportsRequestVideoFrameCallback();

  const av1CaptureFpsCap = isAv1
    ? getAv1CaptureFpsCap({
        durationSeconds: metadata?.duration,
        quality: options.quality,
      })
    : requestedTargetFps;

  let effectiveTargetFps = isAv1
    ? Math.max(1, Math.min(requestedTargetFps, av1CaptureFpsCap))
    : requestedTargetFps;

  if (isAv1 && effectiveTargetFps !== requestedTargetFps) {
    logger.info('conversion', 'Capping AV1 WebCodecs extraction FPS to reduce conversion time', {
      codec: metadata?.codec ?? 'unknown',
      requestedFps: requestedTargetFps,
      cappedFps: effectiveTargetFps,
      durationSeconds: metadata?.duration ?? null,
      quality: options.quality,
      reason: 'AV1 frame extraction is CPU-heavy (decode + canvas encode)',
    });
  }

  let maxFrames = getMaxWebPFrames(effectiveTargetFps, metadata?.duration);

  // Prefer demuxer-based extraction for complex codecs when eligible.
  // This avoids extremely slow per-frame seeking for AV1/HEVC/VP9 in many browsers.
  const demuxerEligible = canUseDemuxer(file, metadata);
  if (demuxerEligible) {
    logger.info('conversion', 'Demuxer path eligible for complex codec extraction', {
      codec: metadata?.codec ?? 'unknown',
      container: detectContainer(file),
    });
  }

  const av1FrameCallbackFailures = isAv1
    ? readSessionStorageNumber(AV1_FRAME_CALLBACK_FAILURE_KEY)
    : 0;

  const shouldSkipAv1FrameCallbackProbe =
    isAv1 && supportsFrameCallback && av1FrameCallbackFailures >= 1;

  // Direct WebCodecs → RGBA pipeline for complex codecs.
  const startTime = Date.now();

  const frameFormat: WebCodecsFrameFormat = 'rgba';

  const runDecode = async (
    captureMode: WebCodecsCaptureMode,
    overrideTargetFps: number = effectiveTargetFps
  ) => {
    return await decoder.decodeToFrames({
      file,
      targetFps: overrideTargetFps,
      scale,
      frameFormat,
      frameQuality: 0.95,
      framePrefix: 'frame_',
      frameDigits: 6,
      frameStartNumber: 0,
      maxFrames,
      captureMode,
      codec: metadata?.codec,
      quality: options.quality,
      onFrame: async (frame) => {
        throwIfCancelled();

        if (!frame.imageData) {
          throw new Error('WebCodecs did not provide raw frame data (ImageData).');
        }

        framesByIndex[frame.index] = {
          imageData: frame.imageData,
          timestamp: frame.timestamp,
        };
      },
      onProgress: reportDecodeProgress,
      shouldCancel,
    });
  };

  const runDecodeWithTiming = async (
    captureMode: WebCodecsCaptureMode,
    overrideTargetFps: number = effectiveTargetFps
  ) => {
    const start = Date.now();
    const result = await runDecode(captureMode, overrideTargetFps);
    const elapsedMs = Date.now() - start;
    const modeUsed = result.captureModeUsed ?? captureMode;
    return { result, elapsedMs, modeUsed };
  };

  // Check cache for performance metrics first (preferred over simple success cache)
  const cachedPerf = getCachedCapturePerformance(metadata?.codec ?? 'unknown');
  // Check cache for successful capture mode (fallback)
  const cachedMode = getCachedCaptureMode(metadata?.codec ?? 'unknown');

  // If this device/browser is consistently slow at AV1 extraction, reduce the
  // extraction FPS further for subsequent conversions in this session.
  if (isAv1 && cachedPerf && isHardwareCacheValid()) {
    const avgMsPerFrame = cachedPerf.avgMsPerFrame;
    const slowThresholdMs = 900;
    const downshiftTargetFps = 8;

    if (Number.isFinite(avgMsPerFrame) && avgMsPerFrame > slowThresholdMs) {
      const nextFps = Math.max(1, Math.min(effectiveTargetFps, downshiftTargetFps));
      if (nextFps !== effectiveTargetFps) {
        logger.info(
          'conversion',
          'Downshifting AV1 extraction FPS due to slow cached performance',
          {
            codec: metadata?.codec ?? 'unknown',
            requestedFps: requestedTargetFps,
            previousEffectiveFps: effectiveTargetFps,
            downshiftedFps: nextFps,
            cachedMode: cachedPerf.mode,
            avgMsPerFrame: Number(avgMsPerFrame.toFixed(2)),
            thresholdMs: slowThresholdMs,
            durationSeconds: metadata?.duration ?? null,
          }
        );
      }

      effectiveTargetFps = nextFps;
      maxFrames = getMaxWebPFrames(effectiveTargetFps, metadata?.duration);
    }
  }

  let initialCaptureMode: WebCodecsCaptureMode;

  if (demuxerEligible) {
    // Try strict demuxer mode first. If it fails, fall back explicitly.
    initialCaptureMode = 'demuxer';
    logger.info('conversion', 'Starting complex codec capture with demuxer mode', {
      codec: metadata?.codec ?? 'unknown',
      container: detectContainer(file),
    });
  } else if (cachedPerf && isHardwareCacheValid()) {
    // Use cached fastest mode (performance-based selection)
    initialCaptureMode = cachedPerf.mode;
    logger.info('conversion', 'Using cached fastest capture mode for codec', {
      codec: metadata?.codec ?? 'unknown',
      mode: cachedPerf.mode,
      avgMsPerFrame: cachedPerf.avgMsPerFrame.toFixed(2),
    });
  } else if (cachedMode && isHardwareCacheValid()) {
    // Use cached successful mode (fallback to simpler cache)
    initialCaptureMode = cachedMode;
    logger.info('conversion', 'Using cached successful capture mode for codec', {
      codec: metadata?.codec ?? 'unknown',
      cachedMode,
    });
  } else {
    // Fall back to existing logic
    initialCaptureMode = shouldSkipAv1FrameCallbackProbe
      ? 'seek'
      : isAv1 && supportsFrameCallback
        ? 'frame-callback'
        : 'auto';
  }

  if (shouldSkipAv1FrameCallbackProbe) {
    logger.info(
      'conversion',
      'Skipping AV1 frame-callback probe due to repeated under-capture in this session; starting with seek',
      {
        failures: av1FrameCallbackFailures,
        key: AV1_FRAME_CALLBACK_FAILURE_KEY,
        codec: metadata?.codec ?? 'unknown',
      }
    );
  }

  const initialSeekTargetFps =
    initialCaptureMode === 'seek' && isAv1
      ? Math.min(
          effectiveTargetFps,
          getAv1SeekFpsCap({
            durationSeconds: metadata?.duration,
            quality: options.quality,
          })
        )
      : effectiveTargetFps;

  // Track decode timing for performance caching (use the final successful attempt)
  let perfElapsed = 0;
  let decodeResult: Awaited<ReturnType<WebCodecsDecoderService['decodeToFrames']>>;

  try {
    const attempt = await runDecodeWithTiming(initialCaptureMode, initialSeekTargetFps);
    decodeResult = attempt.result;
    perfElapsed = attempt.elapsedMs;
  } catch (error) {
    if (initialCaptureMode !== 'demuxer') {
      throw error;
    }

    logger.warn('conversion', 'Demuxer capture failed; falling back to playback capture modes', {
      codec: metadata?.codec ?? 'unknown',
      container: detectContainer(file),
      error: getErrorMessage(error),
    });

    const fallbackInitial: WebCodecsCaptureMode = shouldSkipAv1FrameCallbackProbe
      ? 'seek'
      : isAv1 && supportsFrameCallback
        ? 'frame-callback'
        : 'auto';

    const fallbackSeekTargetFps =
      fallbackInitial === 'seek' && isAv1
        ? Math.min(
            effectiveTargetFps,
            getAv1SeekFpsCap({
              durationSeconds: metadata?.duration,
              quality: options.quality,
            })
          )
        : effectiveTargetFps;

    const attempt = await runDecodeWithTiming(fallbackInitial, fallbackSeekTargetFps);
    decodeResult = attempt.result;
    perfElapsed = attempt.elapsedMs;
  }

  const expectedFramesFromDuration = computeExpectedFramesFromDuration({
    durationSeconds: decodeResult.duration,
    fps: decodeResult.fps,
    maxFrames,
  });
  const requiredFrames = computeRequiredFramesFromExpected(expectedFramesFromDuration);

  if (maxFrames > 1 && decodeResult.frameCount < requiredFrames) {
    // Track repeated AV1 frame-callback under-capture.
    if (
      isAv1 &&
      supportsFrameCallback &&
      (decodeResult.captureModeUsed ?? initialCaptureMode) === 'frame-callback'
    ) {
      writeSessionStorageNumber(AV1_FRAME_CALLBACK_FAILURE_KEY, av1FrameCallbackFailures + 1);
    }

    logger.warn(
      'conversion',
      `WebCodecs initial capture under-extracted frames; retrying with fallback capture modes (captured=${
        decodeResult.frameCount
      }, expected≈${expectedFramesFromDuration}, required>=${requiredFrames}, initial=${initialCaptureMode}, used=${
        decodeResult.captureModeUsed ?? 'unknown'
      })`,
      {
        codec: metadata?.codec ?? 'unknown',
        capturedFrames: decodeResult.frameCount,
        expectedFramesFromDuration,
        requiredFrames,
        requestedFps: requestedTargetFps,
        effectiveTargetFps,
        durationSeconds: decodeResult.duration,
        maxFrames,
        scale,
        frameFormat,
        captureModeUsed: decodeResult.captureModeUsed ?? null,
        initialCaptureMode,
        supportsFrameCallback,
      }
    );

    // Discard partial results from the first pass before retrying.
    framesByIndex.length = 0;

    // If auto selected track mode and it under-captured, try frame-callback first.
    if (supportsFrameCallback && decodeResult.captureModeUsed === 'track') {
      try {
        logger.info(
          'conversion',
          `WebCodecs under-captured in track mode; retrying with frame-callback (captured=${decodeResult.frameCount}, required>=${requiredFrames})`,
          {
            capturedFrames: decodeResult.frameCount,
            requiredFrames,
            expectedFramesFromDuration,
            requestedFps: requestedTargetFps,
            effectiveTargetFps,
            durationSeconds: decodeResult.duration,
            maxFrames,
            scale,
            frameFormat,
          }
        );

        {
          const attempt = await runDecodeWithTiming('frame-callback');
          decodeResult = attempt.result;
          perfElapsed = attempt.elapsedMs;
        }
      } catch (frameCallbackError) {
        logger.warn('conversion', 'WebCodecs frame-callback retry failed; falling back to seek', {
          error: getErrorMessage(frameCallbackError),
        });
      }
    }

    const retryExpectedFramesFromDuration = computeExpectedFramesFromDuration({
      durationSeconds: decodeResult.duration,
      fps: decodeResult.fps,
      maxFrames,
    });
    const retryRequiredFrames = computeRequiredFramesFromExpected(retryExpectedFramesFromDuration);

    if (decodeResult.frameCount < retryRequiredFrames) {
      // If initial mode was frame-callback (rVFC) and under-captured, probe track before slow seek.
      const modeUsed = decodeResult.captureModeUsed ?? initialCaptureMode;
      const supportsTrackProcessor = supportsFrameCallback; // Track is typically available if rVFC is

      if (supportsTrackProcessor && modeUsed === 'frame-callback') {
        try {
          logger.info(
            'conversion',
            'Probing track processor before seek fallback (frame-callback under-captured)',
            {
              capturedFrames: decodeResult.frameCount,
              requiredFrames: retryRequiredFrames,
              previousMode: modeUsed,
            }
          );

          framesByIndex.length = 0;
          {
            const attempt = await runDecodeWithTiming('track');
            decodeResult = attempt.result;
            perfElapsed = attempt.elapsedMs;
          }

          if (decodeResult.frameCount >= retryRequiredFrames) {
            logger.info('conversion', 'Track processor probe succeeded, skipping seek fallback', {
              frameCount: decodeResult.frameCount,
            });
          }
        } catch (trackError) {
          logger.warn('conversion', 'Track probe failed, falling back to seek', {
            error: getErrorMessage(trackError),
          });
          framesByIndex.length = 0;
        }
      }

      // If still under-captured, fall back to seek.
      if (decodeResult.frameCount < retryRequiredFrames) {
        framesByIndex.length = 0;

        const av1SeekFpsCap = getAv1SeekFpsCap({
          durationSeconds: decodeResult.duration,
          quality: options.quality,
        });
        const seekTargetFps = isAv1
          ? Math.min(effectiveTargetFps, av1SeekFpsCap)
          : effectiveTargetFps;

        if (seekTargetFps !== effectiveTargetFps) {
          logger.info('conversion', 'Capping FPS for seek fallback to reduce conversion time', {
            codec: metadata?.codec ?? 'unknown',
            requestedFps: requestedTargetFps,
            effectiveTargetFps,
            seekFps: seekTargetFps,
            seekFpsCap: isAv1 ? av1SeekFpsCap : null,
            durationSeconds: decodeResult.duration,
            reason: 'seek fallback for WebCodecs-only codec',
          });
        }

        {
          const attempt = await runDecodeWithTiming('seek', seekTargetFps);
          decodeResult = attempt.result;
          perfElapsed = attempt.elapsedMs;
        }
      }
    }

    const finalExpectedFramesFromDuration = computeExpectedFramesFromDuration({
      durationSeconds: decodeResult.duration,
      fps: decodeResult.fps,
      maxFrames,
    });
    const finalRequiredFrames = computeRequiredFramesFromExpected(finalExpectedFramesFromDuration);

    if (decodeResult.frameCount < finalRequiredFrames) {
      throw new Error(
        `WebCodecs frame extraction under-sampled after fallbacks: captured=${decodeResult.frameCount}, expected≈${finalExpectedFramesFromDuration} (required>=${finalRequiredFrames}).`
      );
    }
  }

  // If AV1 frame-callback managed to capture enough frames, clear failure count.
  if (isAv1 && supportsFrameCallback) {
    const modeUsed = decodeResult.captureModeUsed ?? initialCaptureMode;
    if (modeUsed === 'frame-callback' && decodeResult.frameCount >= requiredFrames) {
      writeSessionStorageNumber(AV1_FRAME_CALLBACK_FAILURE_KEY, 0);
    }
  }

  // Cache successful capture mode and performance for future conversions.
  const actualRequiredFrames = Math.max(
    1,
    Math.min(maxFrames, Math.ceil(decodeResult.duration * decodeResult.fps)) - 1
  );

  if (decodeResult.frameCount >= actualRequiredFrames) {
    const modeUsed = decodeResult.captureModeUsed ?? initialCaptureMode;
    if (modeUsed !== 'auto') {
      cacheCaptureMode(metadata?.codec ?? 'unknown', modeUsed);
      cacheCapturePerformance(
        metadata?.codec ?? 'unknown',
        modeUsed,
        perfElapsed,
        decodeResult.frameCount
      );
      logger.info(
        'conversion',
        'Cached successful capture mode and performance for future conversions',
        {
          codec: metadata?.codec ?? 'unknown',
          mode: modeUsed,
          actualRequiredFrames,
          capturedFrames: decodeResult.frameCount,
          elapsedMs: perfElapsed,
          avgMsPerFrame: (perfElapsed / decodeResult.frameCount).toFixed(2),
        }
      );
    }
  }

  // Validate capture completeness: under-capture produces choppy output.
  const minRequiredRatio = 0.5;
  const minAbsoluteFrames = 10;

  const validationExpectedFrames = computeExpectedFramesFromDuration({
    durationSeconds: decodeResult.duration,
    fps: decodeResult.fps,
    maxFrames,
  });
  const captureRatio = decodeResult.frameCount / validationExpectedFrames;

  if (decodeResult.frameCount < minAbsoluteFrames || captureRatio < minRequiredRatio) {
    logger.error('conversion', 'WebCodecs frame capture critically incomplete - failing fast', {
      capturedFrames: decodeResult.frameCount,
      expectedFrames: validationExpectedFrames,
      captureRatio: `${(captureRatio * 100).toFixed(1)}%`,
      minRequiredRatio: `${minRequiredRatio * 100}%`,
      minAbsoluteFrames,
      codec: metadata?.codec,
      captureModeUsed: decodeResult.captureModeUsed,
      duration: decodeResult.duration,
    });

    throw new Error(
      `Frame extraction incomplete: captured only ${decodeResult.frameCount} of ${validationExpectedFrames} ` +
        `expected frames (${(captureRatio * 100).toFixed(1)}%). ` +
        `This would produce a choppy output in the direct WebP path. ` +
        `Minimum required: ${
          minRequiredRatio * 100
        }% capture ratio or ${minAbsoluteFrames} absolute frames. ` +
        `Please try a different video or report this issue if it persists.`
    );
  }

  const orderedFrames = framesByIndex.filter(
    (frame): frame is { imageData: ImageData; timestamp: number } => Boolean(frame)
  );

  const orderedImageData = orderedFrames.map((frame) => frame.imageData);

  const elapsed = Date.now() - startTime;
  const estimatedFramesFromCapturedDuration = computeExpectedFramesFromDuration({
    durationSeconds: decodeResult.duration,
    fps: decodeResult.fps,
  });

  logger.info(
    'conversion',
    `Frame extraction complete: frameCount=${
      decodeResult.frameCount
    }, durationSeconds=${decodeResult.duration.toFixed(
      3
    )}, requestedFps=${requestedTargetFps}, effectiveTargetFps=${effectiveTargetFps}, maxFramesRequested=${maxFrames}, queuedFrames=${
      orderedFrames.length
    }`,
    {
      frameCount: decodeResult.frameCount,
      duration: decodeResult.duration,
      elapsed: `${elapsed}ms`,
      format: 'webp',
      requestedFps: requestedTargetFps,
      effectiveTargetFps,
      decodeFps: decodeResult.fps,
      maxFramesRequested: maxFrames,
      estimatedFramesFromDuration: estimatedFramesFromCapturedDuration,
      queuedFrames: orderedFrames.length,
    }
  );

  return {
    orderedImageData,
    decodeResult,
    effectiveTargetFps,
  };
}
