// External dependencies
import * as Comlink from 'comlink';

// Internal dependencies

// Type imports
import type { ConversionOptions, ConversionOutputBlob, VideoMetadata } from '@t/conversion-types';
import type { EncoderWorkerAPI } from '@t/worker-types';
import { QUALITY_PRESETS, WEBCODECS_ACCELERATED } from '@utils/constants';
import { getErrorMessage } from '@utils/error-utils';
import { FFMPEG_INTERNALS } from '@utils/ffmpeg-constants';
import { isHardwareCacheValid } from '@utils/hardware-profile';
import { logger } from '@utils/logger';
import { getAvailableMemory, isMemoryCritical } from '@utils/memory-monitor';
import { getOptimalFPS } from '@utils/quality-optimizer';
import {
  cacheCaptureMode,
  cacheCapturePerformance,
  getCachedCaptureMode,
  getCachedCapturePerformance,
} from '@utils/session-cache';
import { ffmpegService } from './ffmpeg-service';
import { encodeModernGif, isModernGifSupported } from './modern-gif-service';
import { isComplexCodec } from '@services/webcodecs/codec-utils';
import {
  AV1_FRAME_CALLBACK_FAILURE_KEY,
  getAv1CaptureFpsCap,
  getAv1SeekFpsCap,
  readSessionStorageNumber,
  supportsRequestVideoFrameCallback,
  writeSessionStorageNumber,
} from '@services/webcodecs/conversion/av1-capture-policy';
import {
  computeExpectedFramesFromDuration,
  computeRequiredFramesFromExpected,
} from '@services/webcodecs/conversion/frame-requirements';
import { probeCanvasWebPEncodeSupport } from '@services/webcodecs/conversion/canvas-webp-support';
import { encodeWithFFmpegFallback as encodeWithFFmpegFallbackUtil } from '@services/webcodecs/conversion/ffmpeg-fallback-encode';
import {
  encodeWebPFramesInChunks,
  tryEncodeWebPWithEncoderFactory,
} from '@services/webcodecs/conversion/webp-encoding';
import { canUseDemuxer, detectContainer } from '@services/webcodecs/demuxer/demuxer-factory';
import { muxWebPFrames } from '@services/webcodecs/webp/mux-webp-frames';
import { validateWebPBlob } from '@services/webcodecs/webp/validate-webp-blob';
import {
  buildDurationAlignedTimestamps as buildDurationAlignedTimestampsUtil,
  getMaxWebPFrames as getMaxWebPFramesUtil,
  resolveAnimationDurationSeconds as resolveAnimationDurationSecondsUtil,
  resolveWebPFps as resolveWebPFpsUtil,
} from '@services/webcodecs/webp-timing';
import {
  type WebCodecsCaptureMode,
  WebCodecsDecoderService,
  type WebCodecsFrameFormat,
} from './webcodecs-decoder-service';
import { isWebCodecsCodecSupported, isWebCodecsDecodeSupported } from './webcodecs-support-service';
import { getOptimalPoolSize, WorkerPool } from './worker-pool-service';

/**
 * WebCodecs Conversion Service
 *
 * Provides GPU-accelerated video conversion using WebCodecs API for modern browsers.
 * Extracts video frames directly from the video stream and encodes to GIF/WebP formats.
 *
 * Features:
 * - Direct frame extraction via WebCodecs (bypasses H.264 intermediate transcoding)
 * - Worker pool for parallel GIF encoding
 * - Complex codec support (AV1, VP9, HEVC) with direct PNG pipeline
 * - Automatic fallback to FFmpeg for unsupported codecs
 * - Memory-aware processing with critical memory checks
 *
 * @see webcodecs-decoder-service.ts for frame extraction implementation
 * @see modern-gif-service.ts for GPU-accelerated GIF encoding
 */
class WebCodecsConversionService {
  private gifWorkerPool: WorkerPool<EncoderWorkerAPI> | null = null;
  private canvasWebPEncodeSupport: boolean | null = null;

  constructor() {
    // Lazy initialize worker pools with dynamic sizing
    if (typeof window !== 'undefined') {
      const hwConcurrency = navigator.hardwareConcurrency || 4;
      const availableMem = getAvailableMemory();

      // Calculate optimal pool sizes based on hardware and memory
      const optimalGifWorkers = getOptimalPoolSize('gif', hwConcurrency, availableMem);

      logger.info('worker-pool', 'Dynamic worker pool sizing', {
        hardwareConcurrency: hwConcurrency,
        availableMemory: `${Math.round(availableMem / 1024 / 1024)}MB`,
        gifWorkers: optimalGifWorkers,
      });

      this.gifWorkerPool = new WorkerPool(
        new URL('../workers/gif-encoder.worker.ts', import.meta.url),
        { lazyInit: true, maxWorkers: optimalGifWorkers }
      );
    }
  }

  /**
   * Calculate maximum WebP frame count
   *
   * Limits frame count based on duration and FPS to prevent memory issues.
   * Caps at WEBP_ANIMATION_MAX_FRAMES (240) and WEBP_ANIMATION_MAX_DURATION_SECONDS (10s).
   *
   * @param targetFps - Target frames per second
   * @param durationSeconds - Optional video duration in seconds
   * @returns Maximum number of frames to extract
   */
  private getMaxWebPFrames(targetFps: number, durationSeconds?: number): number {
    return getMaxWebPFramesUtil(targetFps, durationSeconds);
  }

  /**
   * Check whether this browser can encode WebP images via canvas.
   *
   * This is a cheap preflight used to avoid repeated per-frame failures in the
   * WebP muxer path on browsers without WebP image encoding support.
   */
  private async getCanvasWebPEncodeSupport(): Promise<boolean> {
    if (this.canvasWebPEncodeSupport !== null) {
      return this.canvasWebPEncodeSupport;
    }

    const supported = await probeCanvasWebPEncodeSupport();
    this.canvasWebPEncodeSupport = supported;
    return supported;
  }

  /**
   * Resolve effective animation duration for WebP output
   *
   * Uses the longest known duration (metadata or captured duration) capped to the
   * WebP animation limit to avoid unintended speed-ups. Ensures a small positive
   * fallback to keep per-frame durations meaningful.
   */
  private resolveAnimationDurationSeconds(
    frameCount: number,
    targetFps: number,
    metadata?: VideoMetadata,
    captureDurationSeconds?: number
  ): number | undefined {
    return resolveAnimationDurationSecondsUtil(
      frameCount,
      targetFps,
      metadata,
      captureDurationSeconds
    );
  }

  /**
   * Derive an FPS value that matches captured frames to the effective duration.
   * Clamps to the requested target FPS to avoid overspeed playback while
   * preserving the original pacing for low-FPS or sparse frame captures.
   */
  private resolveWebPFps(frameCount: number, targetFps: number, durationSeconds?: number): number {
    return resolveWebPFpsUtil(frameCount, targetFps, durationSeconds);
  }

  /**
   * Build a stable, duration-aligned timestamp series for WebP frame encoding.
   *
   * WebCodecs capture timestamps can be slightly jittery when downsampling or
   * when decoding complex codecs. For WebP animation, that jitter can manifest
   * as micro-stutter.
   *
   * This function produces an evenly-spaced timestamp array that:
   * - matches the resolved animation duration
   * - is stable (no drift / jitter accumulation)
   * - is safe for FFmpeg concat-based timestamp encoding
   */
  private buildDurationAlignedTimestamps(params: {
    frameCount: number;
    durationSeconds?: number;
    fallbackFps: number;
  }): number[] {
    return buildDurationAlignedTimestampsUtil(params);
  }

  /**
   * Check if WebCodecs conversion is available for this video
   *
   * Validates codec support, browser capabilities, and memory availability.
   *
   * @param file - Input video file
   * @param metadata - Optional video metadata with codec information
   * @returns True if WebCodecs conversion can be used
   */
  async canConvert(file: File, metadata?: VideoMetadata): Promise<boolean> {
    if (!metadata?.codec || metadata.codec === 'unknown') {
      return false;
    }

    if (!isWebCodecsDecodeSupported()) {
      return false;
    }

    if (isMemoryCritical()) {
      logger.warn('conversion', 'Skipping WebCodecs decode due to critical memory usage');
      return false;
    }

    const normalizedCodec = metadata.codec.toLowerCase();
    const isCandidate = WEBCODECS_ACCELERATED.some((codec) => normalizedCodec.includes(codec));
    if (!isCandidate) {
      return false;
    }

    return isWebCodecsCodecSupported(normalizedCodec, file.type, metadata);
  }

  /**
   * Attempt WebCodecs conversion with automatic FFmpeg fallback
   *
   * Tries WebCodecs conversion first, returns null if not supported or fails.
   * Caller should fall back to FFmpeg when null is returned.
   *
   * @param file - Input video file
   * @param format - Target format ('gif' or 'webp')
   * @param options - Conversion options (quality, scale)
   * @param metadata - Optional video metadata
   * @returns Converted blob or null if WebCodecs path not available/failed
   * @throws Error if conversion cancelled by user
   */
  async maybeConvert(
    file: File,
    format: 'gif' | 'webp',
    options: ConversionOptions,
    metadata?: VideoMetadata
  ): Promise<ConversionOutputBlob | null> {
    const useWebCodecs = await this.canConvert(file, metadata);
    if (!useWebCodecs) {
      return null;
    }

    try {
      return await this.convert(file, format, options, metadata);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      if (
        errorMessage.includes('cancelled by user') ||
        (ffmpegService.isCancellationRequested() &&
          errorMessage.includes('called FFmpeg.terminate()'))
      ) {
        throw error;
      }

      logger.warn('conversion', 'WebCodecs path failed, falling back to FFmpeg', {
        error: errorMessage,
        codec: metadata?.codec,
        fallbackReason: 'webcodecs_failed',
      });

      logger.debug('conversion', 'Returning null for FFmpeg fallback', {
        reason: 'webcodecs_failed',
        originalError: errorMessage,
      });
      return null;
    }
  }

  /**
   * Determine if WebCodecs direct path should be used
   *
   * Direct WebCodecs path is used for complex codecs (AV1, VP9, HEVC)
   * to avoid double transcoding overhead.
   *
   * @param metadata - Video metadata with codec information
   * @returns True if WebCodecs direct path should be used
   */
  private shouldUseWebCodecsPath(metadata: VideoMetadata | undefined): boolean {
    if (!isComplexCodec(metadata?.codec)) {
      return false;
    }
    if (typeof VideoFrame === 'undefined') {
      return false;
    }
    return true;
  }

  /**
   * Convert via WebCodecs direct frame extraction
   *
   * Extracts RGBA frames directly from complex codecs (AV1, VP9, HEVC)
   * without H.264 intermediate transcoding. Prefers native WebP encoding
   * (worker-based when available), falling back to the standard path when needed.
   *
   * @param params - Conversion parameters
   * @param params.decoder - WebCodecs decoder service instance
   * @param params.file - Input video file
   * @param params.format - Target format ('gif' or 'webp')
   * @param params.options - Conversion options (quality, scale)
   * @param params.targetFps - Target frames per second
   * @param params.scale - Scale factor (0.0 to 1.0)
   * @param params.metadata - Optional video metadata
   * @param params.reportDecodeProgress - Progress callback for decoding phase
   * @param params.capturedFrames - Optional array to collect captured frames
   * @returns Converted blob or null if path is not suitable
   */
  private async convertViaWebCodecsFrames(params: {
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
      capturedFrames,
      shouldCancel,
    } = params;

    const shouldCancelOrDefault = shouldCancel ?? (() => ffmpegService.isCancellationRequested());
    if (shouldCancelOrDefault()) {
      throw new Error('Conversion cancelled by user');
    }
    if (!this.shouldUseWebCodecsPath(metadata)) {
      return null;
    }

    // GIF: Skip WebCodecs path, use FFmpeg direct instead
    // WebCodecs frame extraction for GIF has VFS write stability issues
    if (format === 'gif') {
      logger.info('conversion', 'GIF format with complex codec: skipping WebCodecs path', {
        codec: metadata?.codec,
        reason: 'Use FFmpeg direct path instead',
      });
      return null;
    }

    logger.info('conversion', 'Using WebCodecs direct frame extraction path', {
      codec: metadata?.codec,
      format,
    });

    const canEncodeWebPFrames = await this.getCanvasWebPEncodeSupport();
    if (!canEncodeWebPFrames) {
      logger.info('conversion', 'Skipping WebCodecs direct WebP path (canvas WebP unsupported)', {
        codec: metadata?.codec,
        reason: 'Canvas WebP encoding is not supported in this browser',
      });
      return null;
    }

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

    let maxFrames = this.getMaxWebPFrames(effectiveTargetFps, metadata?.duration);

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

    try {
      ffmpegService.reportStatus('Extracting frames via WebCodecs...');

      // Direct WebCodecs → RGBA pipeline for complex codecs
      // Prefer native WebP encoding to avoid FFmpeg init + VFS overhead.
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
            if (shouldCancelOrDefault()) {
              throw new Error('Conversion cancelled by user');
            }
            if (!frame.imageData) {
              throw new Error('WebCodecs did not provide raw frame data (ImageData).');
            }

            framesByIndex[frame.index] = {
              imageData: frame.imageData,
              timestamp: frame.timestamp,
            };
          },
          onProgress: reportDecodeProgress,
          shouldCancel: shouldCancelOrDefault,
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
      // NOTE: This primarily reduces per-frame canvas encoding overhead; decode cost
      // may still dominate on software-only AV1 decoders.
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
          maxFrames = this.getMaxWebPFrames(effectiveTargetFps, metadata?.duration);
        }
      }

      // For AV1, skip track-based auto mode when rVFC is available.
      // TrackProcessor capture can severely under-capture on some browsers for AV1,
      // costing a full playback duration before we fall back to seek.
      let initialCaptureMode: WebCodecsCaptureMode;

      if (demuxerEligible) {
        // Try strict demuxer mode first. If it fails, we fall back explicitly to the
        // existing AV1-optimized probe order.
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

        logger.warn(
          'conversion',
          'Demuxer capture failed; falling back to playback capture modes',
          {
            codec: metadata?.codec ?? 'unknown',
            container: detectContainer(file),
            error: getErrorMessage(error),
          }
        );

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

      // If auto capture under-extracts frames compared to duration-based target,
      // retry with deterministic seek capture to ensure enough images for smooth motion.
      // Use actual FPS from decode result (not original targetFps) to avoid false validation failures
      const expectedFramesFromDuration = computeExpectedFramesFromDuration({
        durationSeconds: decodeResult.duration,
        fps: decodeResult.fps,
        maxFrames,
      });
      const requiredFrames = computeRequiredFramesFromExpected(expectedFramesFromDuration);

      if (maxFrames > 1 && decodeResult.frameCount < requiredFrames) {
        // Track repeated AV1 frame-callback under-capture. If this happens consistently,
        // start directly with seek in subsequent conversions for this session.
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
        // This can be significantly faster than per-frame seeking when supported.
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
            logger.warn(
              'conversion',
              'WebCodecs frame-callback retry failed; falling back to seek',
              {
                error: getErrorMessage(frameCallbackError),
              }
            );
          }
        }

        // If we still under-captured, use deterministic seek capture as the final fallback.
        // Use actual FPS from decode result to avoid false validation failures
        const retryExpectedFramesFromDuration = computeExpectedFramesFromDuration({
          durationSeconds: decodeResult.duration,
          fps: decodeResult.fps,
          maxFrames,
        });
        const retryRequiredFrames = computeRequiredFramesFromExpected(
          retryExpectedFramesFromDuration
        );

        if (decodeResult.frameCount < retryRequiredFrames) {
          // If initial mode was frame-callback (rVFC) and under-captured, probe track before slow seek
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
                logger.info(
                  'conversion',
                  'Track processor probe succeeded, skipping seek fallback',
                  {
                    frameCount: decodeResult.frameCount,
                  }
                );
              }
            } catch (trackError) {
              logger.warn('conversion', 'Track probe failed, falling back to seek', {
                error: getErrorMessage(trackError),
              });
              framesByIndex.length = 0;
            }
          }

          // If still under-captured, fall back to seek
          if (decodeResult.frameCount < retryRequiredFrames) {
            // Clear any partial results before the final retry.
            framesByIndex.length = 0;
            // Seek capture for AV1 can be extremely slow (often ~1s/frame on some devices).
            // To reduce total conversion time while preserving correct playback duration
            // (via duration-aligned timestamps), cap seek sampling FPS more aggressively
            // for longer clips. For medium/low quality we prefer speed over maximum smoothness.
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
        const finalRequiredFrames = computeRequiredFramesFromExpected(
          finalExpectedFramesFromDuration
        );

        if (decodeResult.frameCount < finalRequiredFrames) {
          throw new Error(
            `WebCodecs frame extraction under-sampled after fallbacks: captured=${decodeResult.frameCount}, expected≈${finalExpectedFramesFromDuration} (required>=${finalRequiredFrames}).`
          );
        }
      }

      // If AV1 frame-callback managed to capture enough frames, clear failure count
      // so future sessions can try it again (useful for browser updates or different sources).
      if (isAv1 && supportsFrameCallback) {
        const modeUsed = decodeResult.captureModeUsed ?? initialCaptureMode;
        if (modeUsed === 'frame-callback' && decodeResult.frameCount >= requiredFrames) {
          writeSessionStorageNumber(AV1_FRAME_CALLBACK_FAILURE_KEY, 0);
        }
      }

      // Cache successful capture mode for future conversions
      // Recalculate required frames based on actual FPS used (not original targetFps)
      const actualRequiredFrames = Math.max(
        1,
        Math.min(maxFrames, Math.ceil(decodeResult.duration * decodeResult.fps)) - 1
      );

      if (decodeResult.frameCount >= actualRequiredFrames) {
        const modeUsed = decodeResult.captureModeUsed ?? initialCaptureMode;
        // Only cache concrete modes (not 'auto')
        if (modeUsed !== 'auto') {
          cacheCaptureMode(metadata?.codec ?? 'unknown', modeUsed);
          // Also cache performance metrics for faster mode selection on repeat conversions
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
      // Fail fast so the caller can fall back to the standard path.
      const minRequiredRatio = 0.5; // Must capture ≥50% of expected frames
      const minAbsoluteFrames = 10; // Or ≥10 frames minimum for very short videos

      // Calculate expected frames for validation
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
          format,
          capturedFramesCount: capturedFrames?.length ?? 0,
          requestedFps: requestedTargetFps,
          effectiveTargetFps,
          decodeFps: decodeResult.fps,
          maxFramesRequested: maxFrames,
          estimatedFramesFromDuration: estimatedFramesFromCapturedDuration,
          queuedFrames: orderedFrames.length,
        }
      );

      const StatusTickIntervalMs = 400;
      let lastEncodeStatusAt = 0;
      let lastEncodeStatusCurrent = -1;
      let encodeStatusPrefix = 'Encoding WebP frames...';
      ffmpegService.reportStatus(encodeStatusPrefix);

      const encodeStart = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START;
      const encodeEnd = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_END;
      const reportEncodeProgress = (current: number, total: number) => {
        if (shouldCancelOrDefault()) {
          throw new Error('Conversion cancelled by user');
        }
        const progress = encodeStart + ((encodeEnd - encodeStart) * current) / Math.max(1, total);
        ffmpegService.reportProgress(Math.round(progress));

        const now = Date.now();
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

      const animationDurationSeconds = this.resolveAnimationDurationSeconds(
        orderedImageData.length,
        effectiveTargetFps,
        metadata,
        decodeResult.duration
      );

      const fpsForEncoding = this.resolveWebPFps(
        orderedImageData.length,
        effectiveTargetFps,
        animationDurationSeconds
      );

      if (fpsForEncoding !== effectiveTargetFps) {
        logger.info('conversion', 'Adjusted WebP FPS to match captured pacing', {
          targetFps: effectiveTargetFps,
          adjustedFps: fpsForEncoding,
          frameCount: orderedImageData.length,
          durationSeconds: animationDurationSeconds ?? decodeResult.duration,
        });
      }

      const timestampsForEncoding = this.buildDurationAlignedTimestamps({
        frameCount: orderedImageData.length,
        durationSeconds: animationDurationSeconds ?? decodeResult.duration,
        fallbackFps: fpsForEncoding,
      });

      let outputBlob: Blob | null = null;
      let encoderBackendUsed: string | null = null;

      const factoryEncoded = await tryEncodeWebPWithEncoderFactory({
        frames: orderedImageData,
        width: decodeResult.width,
        height: decodeResult.height,
        fps: fpsForEncoding,
        quality: options.quality,
        timestamps: timestampsForEncoding,
        durationSeconds: animationDurationSeconds,
        codec: metadata?.codec,
        sourceFPS: metadata?.framerate,
        onProgress: reportEncodeProgress,
        shouldCancel: shouldCancelOrDefault,
      });

      if (factoryEncoded) {
        outputBlob = factoryEncoded.blob;
        encoderBackendUsed = factoryEncoded.encoderBackendUsed;
      }

      if (!outputBlob) {
        // Fallback: main-thread WebP muxer path.
        encoderBackendUsed = 'webp-muxer';

        const { encodedFrames } = await encodeWebPFramesInChunks({
          frames: orderedImageData,
          quality: options.quality,
          codec: metadata?.codec,
          onProgress: reportEncodeProgress,
          shouldCancel: shouldCancelOrDefault,
        });

        encodeStatusPrefix = 'Muxing WebP frames...';
        ffmpegService.reportStatus(encodeStatusPrefix);

        outputBlob = await muxWebPFrames({
          encodedFrames,
          timestamps: timestampsForEncoding.slice(0, encodedFrames.length),
          width: decodeResult.width,
          height: decodeResult.height,
          fps: fpsForEncoding,
          metadata,
          durationSeconds: animationDurationSeconds,
          onProgress: reportEncodeProgress,
          shouldCancel: shouldCancelOrDefault,
        });
      }

      if (!outputBlob) {
        logger.warn('conversion', 'WebCodecs direct path produced no output; using standard path', {
          codec: metadata?.codec ?? 'unknown',
          reason: 'no_output',
        });
        return null;
      }

      const validation = await validateWebPBlob(outputBlob);
      if (!validation.valid) {
        logger.warn(
          'conversion',
          'WebCodecs direct WebP output failed validation; using standard path',
          {
            codec: metadata?.codec ?? 'unknown',
            reason: validation.reason ?? 'validation_failed',
          }
        );
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
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      if (
        errorMessage.includes('cancelled by user') ||
        (ffmpegService.isCancellationRequested() &&
          errorMessage.includes('called FFmpeg.terminate()'))
      ) {
        throw error;
      }

      // Log detailed error information for debugging
      const errorStack = error instanceof Error ? error.stack : 'No stack trace';
      const detailedError = {
        error: errorMessage,
        codec: metadata?.codec,
        format,
        stack: errorStack?.substring(0, 500), // Truncate stack for readability
      };
      logger.error('conversion', 'WebCodecs direct path failed', detailedError);
      return null;
    }
  }

  /**
   * Convert video to GIF or WebP format
   *
   * Main conversion method using WebCodecs API for frame extraction.
   * Automatically selects optimal conversion path based on codec and format:
   * - GIF: FFmpeg direct path (better performance)
   * - WebP: WebCodecs + muxer (GPU-accelerated)
   * - Complex codecs: Direct PNG extraction without H.264 transcoding
   *
   * @param file - Input video file
   * @param format - Target format ('gif' or 'webp')
   * @param options - Conversion options (quality, scale)
   * @param metadata - Optional video metadata
   * @returns Converted video blob
   * @throws Error if conversion fails or is cancelled
   *
   * @example
   * const blob = await webcodecsConversionService.convert(
   *   videoFile,
   *   'webp',
   *   { quality: 'high', scale: 1.0 },
   *   metadata
   * );
   */
  async convert(
    file: File,
    format: 'gif' | 'webp',
    options: ConversionOptions,
    metadata?: VideoMetadata,
    abortSignal?: AbortSignal
  ): Promise<ConversionOutputBlob> {
    const { quality, scale } = options;
    const settings =
      format === 'gif' ? QUALITY_PRESETS.gif[quality] : QUALITY_PRESETS.webp[quality];
    const useModernGif = format === 'gif' && isModernGifSupported();

    // Orchestrator-driven conversions provide an AbortSignal; prefer it over the shared
    // FFmpeg cancellation flag so a previous FFmpeg cancel request cannot poison new
    // WebCodecs conversions.
    const shouldCancel = abortSignal
      ? () => abortSignal.aborted
      : () => ffmpegService.isCancellationRequested();

    const throwIfCancelled = (): void => {
      if (shouldCancel()) {
        throw new Error('Conversion cancelled by user');
      }
    };

    // GIF format: Always prefer FFmpeg direct path for better performance
    // WebCodecs frame extraction + FFmpeg GIF encoding is 3x slower than direct FFmpeg encoding
    // and has reliability issues with FFmpeg GIF options (e.g., fps_mode parsing errors)
    if (format === 'gif' && !useModernGif) {
      logger.info(
        'conversion',
        'GIF format detected: using direct FFmpeg path for optimal performance',
        {
          fileSize: file.size,
          format,
        }
      );
      await ffmpegService.initialize();
      const blob = await ffmpegService.convertToGIF(file, options, metadata);
      const blobWithMetadata = blob as ConversionOutputBlob;
      blobWithMetadata.encoderBackendUsed = 'ffmpeg';
      return blobWithMetadata;
    }

    throwIfCancelled();

    let encoderBackendUsed: string | null = null;

    const decoder = new WebCodecsDecoderService();
    const capturedFrames: ImageData[] = [];
    const webpCapturedFrames: ImageData[] = []; // Collect WebP frames for batch encoding
    const webpFrameTimestamps: number[] = [];
    const frameFormat: WebCodecsFrameFormat = 'rgba';

    // Calculate optimal FPS based on source video FPS and quality preset
    const presetFps = 'fps' in settings ? settings.fps : 15;
    const targetFps =
      metadata?.framerate && metadata.framerate > 0
        ? getOptimalFPS(metadata.framerate, quality, format)
        : presetFps;

    if (metadata?.framerate && targetFps !== presetFps) {
      logger.info('conversion', 'Using adaptive FPS', {
        sourceFPS: metadata.framerate,
        presetFPS: presetFps,
        optimalFPS: targetFps,
        quality,
        format,
      });
    }

    const decodeStart = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.DECODE_START;
    const decodeEnd = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.DECODE_END;

    const StatusTickIntervalMs = 400;
    let lastDecodeStatusAt = 0;
    let lastDecodeStatusCurrent = -1;
    let lastEncodeStatusAt = 0;
    let lastEncodeStatusCurrent = -1;
    let encodeStatusPrefix = '';

    const reportDecodeProgress = (current: number, total: number) => {
      throwIfCancelled();
      const progress = decodeStart + ((decodeEnd - decodeStart) * current) / Math.max(1, total);
      ffmpegService.reportProgress(Math.round(progress));

      const now = Date.now();
      const isTerminal = current >= total;
      if (
        current !== lastDecodeStatusCurrent &&
        (isTerminal || now - lastDecodeStatusAt >= StatusTickIntervalMs)
      ) {
        lastDecodeStatusAt = now;
        lastDecodeStatusCurrent = current;
        ffmpegService.reportStatus(`Decoding with WebCodecs... (${current}/${Math.max(1, total)})`);
      }
    };

    ffmpegService.beginExternalConversion(metadata, quality, format, {
      enableLogSilenceCheck: false,
    });

    let externalEnded = false;
    const endConversion = () => {
      if (externalEnded) {
        return;
      }
      ffmpegService.endExternalConversion();
      externalEnded = true;
    };

    // PRIORITY: Use direct WebCodecs path for complex codecs (AV1, VP9, HEVC)
    // This extracts PNG frames directly without H.264 intermediate transcoding.
    // NOTE: This direct path is only relevant for WebP output. GIF uses modern-gif
    // or FFmpeg direct conversion and should not be routed through the PNG/VFS path.
    try {
      if (format === 'webp' && this.shouldUseWebCodecsPath(metadata)) {
        logger.info('conversion', 'Using WebCodecs direct path for complex codec', {
          codec: metadata?.codec,
          format,
          reason: 'direct frame extraction',
        });

        try {
          const webCodecsResult = await this.convertViaWebCodecsFrames({
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

          // If the direct path returns null, fall through to the standard WebCodecs path
          // (media-element capture + muxer/encoder) which may still succeed.
          logger.warn('conversion', 'WebCodecs direct path failed; continuing with standard path', {
            codec: metadata?.codec,
            fallbackReason: 'webcodecs_direct_failed',
          });
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          if (
            errorMessage.includes('cancelled by user') ||
            (ffmpegService.isCancellationRequested() &&
              errorMessage.includes('called FFmpeg.terminate()'))
          ) {
            throw error;
          }

          logger.warn(
            'conversion',
            'WebCodecs direct path errored; continuing with standard path',
            {
              error: errorMessage,
              codec: metadata?.codec,
              fallbackReason: 'webcodecs_direct_error',
            }
          );

          logger.debug('conversion', 'Continuing after WebCodecs direct path error', {
            reason: 'webcodecs_direct_error',
            originalError: errorMessage,
          });
        }
      }

      ffmpegService.reportStatus('Decoding with WebCodecs...');
      ffmpegService.reportProgress(decodeStart);

      const captureModes: WebCodecsCaptureMode[] = ['auto', 'seek'];
      let captureModeUsed: WebCodecsCaptureMode | null = null;
      let decodeResult: Awaited<ReturnType<WebCodecsDecoderService['decodeToFrames']>> | null =
        null;

      for (const captureMode of captureModes) {
        try {
          throwIfCancelled();
          if (captureMode === 'seek') {
            ffmpegService.reportStatus('Retrying WebCodecs decode...');
            ffmpegService.reportProgress(decodeStart);
          }

          decodeResult = await decoder.decodeToFrames({
            file,
            targetFps,
            scale,
            frameFormat,
            frameQuality: FFMPEG_INTERNALS.WEBCODECS.FRAME_QUALITY,
            framePrefix: FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_PREFIX,
            frameDigits: FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_DIGITS,
            frameStartNumber: FFMPEG_INTERNALS.WEBCODECS.FRAME_START_NUMBER,
            maxFrames:
              format === 'webp' ? this.getMaxWebPFrames(targetFps, metadata?.duration) : undefined,
            captureMode,
            codec: metadata?.codec,
            quality: options.quality,
            shouldCancel,
            onProgress: reportDecodeProgress,
            onFrame: async (frame) => {
              throwIfCancelled();
              if (!frame.imageData) {
                throw new Error('WebCodecs did not provide raw frame data.');
              }

              if (format === 'webp') {
                // Collect frames for batch encoding (parallelized later)
                webpCapturedFrames.push(frame.imageData);
                webpFrameTimestamps.push(frame.timestamp);
                return;
              }

              // format === 'gif' here (modern-gif path)
              capturedFrames.push(frame.imageData);
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
          webpCapturedFrames.length = 0;
          webpFrameTimestamps.length = 0;

          if (captureMode === 'seek') {
            throw error;
          }
        }
      }

      if (!decodeResult || !decodeResult.frameCount) {
        throw new Error('WebCodecs decode produced no frames.');
      }

      logger.info('conversion', 'WebCodecs frame capture complete', {
        captureMode: captureModeUsed,
        frameCount: decodeResult.frameCount,
        width: decodeResult.width,
        height: decodeResult.height,
        fps: decodeResult.fps,
        duration: decodeResult.duration,
        frameFormat,
        capturedFramesCount: capturedFrames.length,
        webpCapturedFramesCount: webpCapturedFrames.length,
      });

      ffmpegService.reportProgress(decodeEnd);
      encodeStatusPrefix = `Encoding ${format.toUpperCase()}...`;
      ffmpegService.reportStatus(encodeStatusPrefix);

      // Track the last encode progress percent so we can emit a silent keepalive
      // during worker encoding (Comlink progress messages can be delayed under load).
      let lastEncodeProgressPercent: number = decodeEnd;

      const reportEncodeProgress = (current: number, total: number) => {
        throwIfCancelled();
        const progress =
          FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START +
          ((FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_END -
            FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START) *
            current) /
            Math.max(1, total);
        const roundedProgress = Math.round(progress);
        lastEncodeProgressPercent = roundedProgress;
        ffmpegService.reportProgress(roundedProgress);

        const now = Date.now();
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

      const encodeWithFFmpegFallback = async (errorMessage: string): Promise<Blob> => {
        throwIfCancelled();
        encoderBackendUsed = 'ffmpeg';

        return await encodeWithFFmpegFallbackUtil({
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
            webpCapturedFrames.length = 0;
            webpFrameTimestamps.length = 0;
          },
        });
      };

      let outputBlob: Blob;

      if (useModernGif && this.gifWorkerPool) {
        try {
          // Convert ImageData to serializable format for worker transfer.
          // ImageData objects cannot be cloned by postMessage - must transfer underlying buffer.
          const serializableFrames = capturedFrames.map((frame) => ({
            data: frame.data,
            width: frame.width,
            height: frame.height,
            colorSpace: frame.colorSpace,
          }));

          const progressProxy = Comlink.proxy((current: number, total: number) => {
            reportEncodeProgress(current, total);
          });

          // Keep watchdog timers alive even if worker progress callbacks are delayed.
          // This does NOT advance progress; it re-reports the last seen percent.
          const WorkerEncodeKeepaliveMs = Math.min(2000, FFMPEG_INTERNALS.HEARTBEAT_INTERVAL_MS);
          const keepaliveInterval = setInterval(() => {
            if (shouldCancel()) {
              return;
            }
            try {
              ffmpegService.reportProgress(lastEncodeProgressPercent);
            } catch {
              // Non-fatal: keepalive should never crash encoding.
            }
          }, WorkerEncodeKeepaliveMs);

          try {
            outputBlob = await this.gifWorkerPool.execute(async (worker) => {
              return await worker.encode(
                serializableFrames,
                {
                  width: decodeResult.width,
                  height: decodeResult.height,
                  fps: targetFps,
                  quality,
                },
                progressProxy
              );
            });
          } finally {
            clearInterval(keepaliveInterval);
          }

          encoderBackendUsed = 'modern-gif-worker';
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          logger.warn('conversion', 'GIF worker encoding failed, retrying on main thread', {
            error: errorMessage,
          });
          try {
            outputBlob = await encodeModernGif(capturedFrames, {
              width: decodeResult.width,
              height: decodeResult.height,
              fps: targetFps,
              quality,
              onProgress: reportEncodeProgress,
              shouldCancel,
            });
            encoderBackendUsed = 'modern-gif-main';
          } catch (fallbackError) {
            const fallbackMessage =
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            outputBlob = await encodeWithFFmpegFallback(fallbackMessage);
          }
        }
      } else if (useModernGif) {
        // Fallback to main thread if workers unavailable
        try {
          outputBlob = await encodeModernGif(capturedFrames, {
            width: decodeResult.width,
            height: decodeResult.height,
            fps: targetFps,
            quality,
            onProgress: reportEncodeProgress,
            shouldCancel,
          });
          encoderBackendUsed = 'modern-gif-main';
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          outputBlob = await encodeWithFFmpegFallback(errorMessage);
        }
      } else if (format === 'webp') {
        const webpAnimationDurationSeconds = this.resolveAnimationDurationSeconds(
          webpCapturedFrames.length,
          targetFps,
          metadata,
          decodeResult.duration
        );

        const webpFpsForEncoding = this.resolveWebPFps(
          webpCapturedFrames.length,
          targetFps,
          webpAnimationDurationSeconds
        );

        if (webpFpsForEncoding !== targetFps) {
          logger.info('conversion', 'Adjusted WebP FPS to match captured pacing', {
            targetFps,
            adjustedFps: webpFpsForEncoding,
            frameCount: webpCapturedFrames.length,
            durationSeconds: webpAnimationDurationSeconds ?? decodeResult.duration,
          });
        }

        const timestampsForEncoding =
          webpFrameTimestamps.length >= webpCapturedFrames.length
            ? webpFrameTimestamps.slice(0, webpCapturedFrames.length)
            : undefined;

        const factoryEncoded = await tryEncodeWebPWithEncoderFactory({
          frames: webpCapturedFrames,
          width: decodeResult.width,
          height: decodeResult.height,
          fps: webpFpsForEncoding,
          quality,
          timestamps: timestampsForEncoding,
          durationSeconds: webpAnimationDurationSeconds,
          codec: metadata?.codec,
          sourceFPS: metadata?.framerate,
          onProgress: reportEncodeProgress,
          shouldCancel,
        });

        if (factoryEncoded) {
          outputBlob = factoryEncoded.blob;
          encoderBackendUsed = factoryEncoded.encoderBackendUsed;
          webpCapturedFrames.length = 0;
          webpFrameTimestamps.length = 0;
        } else {
          const canEncodeWebPFrames = await this.getCanvasWebPEncodeSupport();
          if (!canEncodeWebPFrames) {
            const reason = 'Canvas WebP encoding is not supported in this browser';
            logger.warn(
              'conversion',
              'Skipping WebP muxer path (preflight failed), using FFmpeg fallback',
              {
                reason,
              }
            );
            outputBlob = await encodeWithFFmpegFallback(reason);
          } else {
            logger.info('conversion', 'Using WebP muxer path with parallel frame encoding');
            encoderBackendUsed = 'webp-muxer';

            const { encodedFrames } = await encodeWebPFramesInChunks({
              frames: webpCapturedFrames,
              quality,
              codec: metadata?.codec,
              onProgress: reportEncodeProgress,
              shouldCancel,
            });

            let fallbackReason = 'WebP muxer output failed';

            const animationDurationSeconds = this.resolveAnimationDurationSeconds(
              encodedFrames.length,
              targetFps,
              metadata,
              decodeResult.duration
            );

            if (
              animationDurationSeconds &&
              metadata?.duration &&
              animationDurationSeconds !== metadata.duration
            ) {
              logger.info(
                'conversion',
                'Adjusted WebP animation duration to align with frame budget',
                {
                  metadataDuration: metadata.duration,
                  resolvedDuration: animationDurationSeconds,
                  frameCount: encodedFrames.length,
                  fps: targetFps,
                }
              );
            }

            const muxedWebP = await (async (): Promise<Blob | null> => {
              try {
                encodeStatusPrefix = 'Muxing WebP frames...';
                ffmpegService.reportStatus(encodeStatusPrefix);
                const result = await muxWebPFrames({
                  encodedFrames,
                  timestamps: webpFrameTimestamps.slice(0, encodedFrames.length),
                  width: decodeResult.width,
                  height: decodeResult.height,
                  fps: webpFpsForEncoding,
                  metadata,
                  durationSeconds: animationDurationSeconds,
                  onProgress: reportEncodeProgress,
                  shouldCancel,
                });

                if (!result) {
                  fallbackReason = 'WebP muxer produced no output';
                  logger.warn(
                    'conversion',
                    'WebP muxer produced no output, using FFmpeg fallback',
                    {
                      frameCount: decodeResult.frameCount,
                    }
                  );
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

                if (
                  errorMessage.includes('cancelled by user') ||
                  (ffmpegService.isCancellationRequested() &&
                    errorMessage.includes('called FFmpeg.terminate()'))
                ) {
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

            outputBlob = muxedWebP ?? (await encodeWithFFmpegFallback(fallbackReason));

            webpCapturedFrames.length = 0;
            webpFrameTimestamps.length = 0;
          }
        }
      } else {
        // Defensive fallback (should be unreachable due to early return for non-modern GIF).
        outputBlob = await encodeWithFFmpegFallback('Unexpected encoder path (non-modern GIF)');
      }

      const completionProgress =
        format === 'gif'
          ? FFMPEG_INTERNALS.PROGRESS.GIF.COMPLETE
          : FFMPEG_INTERNALS.PROGRESS.WEBP.COMPLETE;
      ffmpegService.reportProgress(completionProgress);

      // Cleanup captured frames for non-FFmpeg encoders
      if (capturedFrames.length > 0 && (useModernGif || format === 'webp')) {
        capturedFrames.length = 0;
      }

      const outputBlobWithMetadata = outputBlob as ConversionOutputBlob;
      if (captureModeUsed) {
        outputBlobWithMetadata.captureModeUsed = captureModeUsed;
      }

      if (encoderBackendUsed) {
        outputBlobWithMetadata.encoderBackendUsed = encoderBackendUsed;
      }

      return outputBlobWithMetadata;
    } finally {
      // Ensure external monitoring is stopped
      // endExternalConversion now includes forceCleanupAll (see Step 5)
      try {
        endConversion();
      } catch (endError) {
        logger.warn('conversion', 'Error during endConversion cleanup', {
          error: getErrorMessage(endError),
        });
      }

      // Force cleanup of any lingering intervals only if endExternalConversion failed.
      // endExternalConversion already calls forceCleanupAll() on success.
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

  /**
   * Clean up worker pool resources
   *
   * Terminates all worker threads and releases memory.
   * Should be called when service is no longer needed.
   */
  cleanup(): void {
    this.gifWorkerPool?.terminate();
    this.gifWorkerPool = null;
  }
}

export const webcodecsConversionService = new WebCodecsConversionService();
