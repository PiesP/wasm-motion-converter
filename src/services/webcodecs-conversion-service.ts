// External dependencies
import * as Comlink from 'comlink';

// Internal dependencies
import gifEncoderWorkerUrl from '@/workers/gif-encoder.worker?worker&url';

// Type imports
import type { ConversionOptions, ConversionOutputBlob, VideoMetadata } from '@t/conversion-types';
import type { EncoderWorkerAPI } from '@t/worker-types';
import { QUALITY_PRESETS, WEBCODECS_ACCELERATED } from '@utils/constants';
import { getErrorMessage } from '@utils/error-utils';
import { FFMPEG_INTERNALS } from '@utils/ffmpeg-constants';
import { logger } from '@utils/logger';
import { getAvailableMemory, isMemoryCritical } from '@utils/memory-monitor';
import { getOptimalFPS } from '@utils/quality-optimizer';
import { ffmpegService } from './ffmpeg-service';
import { encodeModernGif, isModernGifSupported } from './modern-gif-service';
import { isComplexCodec } from '@services/webcodecs/codec-utils';
import { getDevConversionOverrides } from '@services/orchestration/dev-conversion-overrides';
import { captureComplexCodecFramesForWebP } from '@services/webcodecs/conversion/complex-codec-capture';
import { createThrottledProgressReporter } from '@services/webcodecs/conversion/progress-reporting';
import { probeCanvasWebPEncodeSupport } from '@services/webcodecs/conversion/canvas-webp-support';
import { encodeWithFFmpegFallback as encodeWithFFmpegFallbackUtil } from '@services/webcodecs/conversion/ffmpeg-fallback-encode';
import {
  encodeWebPFramesInChunks,
  tryEncodeWebPWithEncoderFactory,
} from '@services/webcodecs/conversion/webp-encoding';
import { encodeWebPWithMuxFallback } from '@services/webcodecs/conversion/webp-encode-orchestrator';
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
import type { EncoderFrame } from '@services/encoders/encoder-interface';
import { EncoderFactory } from '@services/encoders/encoder-factory';
import { convertFramesToImageData } from '@services/encoders/frame-converter';

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

      this.gifWorkerPool = new WorkerPool(gifEncoderWorkerUrl, {
        lazyInit: true,
        maxWorkers: optimalGifWorkers,
      });
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

    // Preflight: allow direct path when an EncoderFactory backend is available
    // even if canvas WebP encoding is unsupported (e.g., jsquash WASM fallback).
    const canEncodeWebPFrames = await this.getCanvasWebPEncodeSupport();
    const hasFactoryWebPEncoder = canEncodeWebPFrames
      ? false
      : await EncoderFactory.hasEncoder('webp');

    if (!hasFactoryWebPEncoder && !canEncodeWebPFrames) {
      logger.info(
        'conversion',
        'Skipping WebCodecs direct WebP path (no available WebP encoder backend)',
        {
          codec: metadata?.codec,
          reason: 'No EncoderFactory WebP backend and canvas WebP encoding is unsupported',
        }
      );
      return null;
    }

    try {
      ffmpegService.reportStatus('Extracting frames via WebCodecs...');
      const throwIfCancelled = (): void => {
        if (shouldCancelOrDefault()) {
          throw new Error('Conversion cancelled by user');
        }
      };

      const { orderedFrames, timestamps, decodeResult, effectiveTargetFps } =
        await captureComplexCodecFramesForWebP({
          decoder,
          file,
          options,
          targetFps,
          scale,
          metadata,
          getMaxWebPFrames: this.getMaxWebPFrames.bind(this),
          reportDecodeProgress,
          shouldCancel: shouldCancelOrDefault,
          throwIfCancelled,
        });

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

      const releaseCapturedFrames = (): void => {
        for (const frame of orderedFrames) {
          if (typeof ImageBitmap !== 'undefined' && frame instanceof ImageBitmap) {
            try {
              frame.close();
            } catch {
              // Ignore.
            }
          }

          if (typeof VideoFrame !== 'undefined' && frame instanceof VideoFrame) {
            try {
              frame.close();
            } catch {
              // Ignore.
            }
          }
        }
      };

      try {
        const animationDurationSeconds = this.resolveAnimationDurationSeconds(
          orderedFrames.length,
          effectiveTargetFps,
          metadata,
          decodeResult.duration
        );

        const fpsForEncoding = this.resolveWebPFps(
          orderedFrames.length,
          effectiveTargetFps,
          animationDurationSeconds
        );

        if (fpsForEncoding !== effectiveTargetFps) {
          logger.info('conversion', 'Adjusted WebP FPS to match captured pacing', {
            targetFps: effectiveTargetFps,
            adjustedFps: fpsForEncoding,
            frameCount: orderedFrames.length,
            durationSeconds: animationDurationSeconds ?? decodeResult.duration,
          });
        }

        const timestampsForEncoding =
          timestamps.length >= orderedFrames.length
            ? timestamps.slice(0, orderedFrames.length)
            : this.buildDurationAlignedTimestamps({
                frameCount: orderedFrames.length,
                durationSeconds: animationDurationSeconds ?? decodeResult.duration,
                fallbackFps: fpsForEncoding,
              });

        let outputBlob: Blob | null = null;
        let encoderBackendUsed: string | null = null;

        const factoryEncoded = await tryEncodeWebPWithEncoderFactory({
          frames: orderedFrames,
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
          // Fallback: main-thread WebP muxer path (requires canvas WebP support).
          if (!canEncodeWebPFrames) {
            logger.info(
              'conversion',
              'Skipping direct-path muxer fallback (canvas WebP unsupported); using standard path',
              {
                codec: metadata?.codec ?? 'unknown',
              }
            );
            return null;
          }

          encoderBackendUsed = 'webp-muxer';

          const imageDataFrames = await convertFramesToImageData(
            orderedFrames,
            decodeResult.width,
            decodeResult.height,
            undefined,
            shouldCancelOrDefault
          );

          const { encodedFrames } = await encodeWebPFramesInChunks({
            frames: imageDataFrames,
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
          logger.warn(
            'conversion',
            'WebCodecs direct path produced no output; using standard path',
            {
              codec: metadata?.codec ?? 'unknown',
              reason: 'no_output',
            }
          );
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
   * - GIF: WebCodecs decode + modern-gif when supported (FFmpeg fallback)
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

    const devOverrides = import.meta.env.DEV ? getDevConversionOverrides() : null;

    let useModernGif = format === 'gif' && isModernGifSupported();

    // User preference: for AV1 (and other complex codecs), FFmpeg-direct decode can be unreliable
    // in WASM. When the user explicitly requests the FFmpeg palette pipeline for GIF, honor it
    // via a hybrid approach: WebCodecs decode → FFmpeg frame-sequence palette encode.
    let shouldPreferFfmpegPaletteFromFrames =
      format === 'gif' &&
      options.gifEncoder === 'ffmpeg-palette' &&
      isComplexCodec(metadata?.codec);

    // Dev-only overrides: allow deterministic A/B testing of encoder and decode/capture paths.
    if (import.meta.env.DEV && devOverrides && format === 'gif') {
      const forcedGifEncoder = devOverrides.forcedGifEncoder;

      if (forcedGifEncoder === 'modern-gif') {
        if (!isModernGifSupported()) {
          if (devOverrides.disableFallback) {
            throw new Error(
              'Dev override forced modern-gif, but modern-gif is not supported in this browser.'
            );
          }
          useModernGif = false;
        } else {
          useModernGif = true;
        }

        shouldPreferFfmpegPaletteFromFrames = false;
      }

      if (forcedGifEncoder === 'ffmpeg-direct') {
        useModernGif = false;
        shouldPreferFfmpegPaletteFromFrames = false;
      }

      if (forcedGifEncoder === 'ffmpeg-palette-frames') {
        // Force the hybrid decode→palette encode path even if the UI did not request it.
        // This is intended for dev profiling and determinism tests.
        shouldPreferFfmpegPaletteFromFrames = true;
      }

      if (forcedGifEncoder === 'ffmpeg-direct' && devOverrides.disableFallback) {
        // When the caller wants FFmpeg-direct, using the GPU/WebCodecs service is an execution-time mismatch.
        // Prefer surfacing this rather than silently switching behavior.
        // Note: orchestrator should generally prevent reaching this state.
        logger.warn('conversion', 'Dev override forced ffmpeg-direct while on WebCodecs path', {
          codec: metadata?.codec,
          disableFallback: devOverrides.disableFallback,
        });
      }
    }

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

    // GIF format: fall back to FFmpeg when modern-gif isn't available.
    // Exception: when user explicitly requested FFmpeg palette for a complex codec,
    // use WebCodecs decode + FFmpeg frame-sequence encoding instead of FFmpeg-direct decode.
    if (format === 'gif' && !useModernGif && !shouldPreferFfmpegPaletteFromFrames) {
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
    const webpCapturedFrames: EncoderFrame[] = []; // Collect WebP frames for batch encoding
    const webpFrameTimestamps: number[] = [];

    // WebP: prefer GPU-friendly ImageBitmap frames to avoid explicit getImageData() readback.
    // GIF: modern-gif requires ImageData.
    const frameFormat: WebCodecsFrameFormat =
      format === 'webp' && typeof createImageBitmap === 'function' ? 'bitmap' : 'rgba';

    const releaseWebPFrames = (): void => {
      for (const frame of webpCapturedFrames) {
        if (typeof ImageBitmap !== 'undefined' && frame instanceof ImageBitmap) {
          try {
            frame.close();
          } catch {
            // Ignore: bitmap might already be closed.
          }
        }

        if (typeof VideoFrame !== 'undefined' && frame instanceof VideoFrame) {
          try {
            frame.close();
          } catch {
            // Ignore.
          }
        }
      }
    };

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
      // AV1 + ffmpeg-palette: preferred hybrid palette encoding (decode with WebCodecs).
      // This avoids FFmpeg decoding AV1 in WASM, which is a known failure mode.
      if (shouldPreferFfmpegPaletteFromFrames) {
        try {
          const hybridResult = await encodeWithFFmpegFallbackUtil({
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
              releaseWebPFrames();
              webpCapturedFrames.length = 0;
              webpFrameTimestamps.length = 0;
            },
            intent: 'preferred',
            // For complex codecs, avoid attempting FFmpeg-direct conversion as a last resort.
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

          if (
            import.meta.env.DEV &&
            devOverrides?.disableFallback === true &&
            (devOverrides.forcedGifEncoder === 'ffmpeg-palette' ||
              devOverrides.forcedGifEncoder === 'ffmpeg-palette-frames')
          ) {
            throw error;
          }

          // If modern-gif is available, fall back rather than hard-failing.
          // If it is not available, let the error surface (no viable alternative).
          if (!useModernGif) {
            throw error;
          }

          logger.warn(
            'conversion',
            'Preferred FFmpeg palette (frame-sequence) path failed; falling back to modern-gif',
            {
              codec: metadata?.codec,
              error: errorMessage,
            }
          );
        }
      }

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

      const forcedCaptureMode =
        import.meta.env.DEV && devOverrides ? devOverrides.forcedCaptureMode : 'auto';
      const captureModes: WebCodecsCaptureMode[] =
        forcedCaptureMode && forcedCaptureMode !== 'auto' ? [forcedCaptureMode] : ['auto', 'seek'];
      const disableDemuxer =
        import.meta.env.DEV &&
        devOverrides?.disableDemuxerInAuto === true &&
        (!forcedCaptureMode || forcedCaptureMode === 'auto');

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
            disableDemuxer,
            codec: metadata?.codec,
            quality: options.quality,
            shouldCancel,
            onProgress: reportDecodeProgress,
            onFrame: async (frame) => {
              throwIfCancelled();
              if (format === 'webp') {
                const encoderFrame = frame.bitmap ?? frame.imageData;
                if (!encoderFrame) {
                  throw new Error('WebCodecs did not provide a usable frame payload for WebP.');
                }

                // Collect frames for batch encoding (parallelized later)
                webpCapturedFrames.push(encoderFrame);
                webpFrameTimestamps.push(frame.timestamp);
                return;
              }

              if (!frame.imageData) {
                throw new Error('WebCodecs did not provide raw frame data.');
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
          releaseWebPFrames();
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

      const encodeStart = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START;
      const encodeEnd = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_END;
      const initialEncodeStatusPrefix = `Encoding ${format.toUpperCase()}...`;

      // modern-gif (GIF) does not provide granular progress while encoding.
      // Avoid showing misleading "(current/total)" counters to the user.
      const shouldUseIndeterminateEncodeHeartbeat = format === 'gif' && useModernGif;

      const estimateModernGifEncodeSeconds = (params: {
        frameCount: number;
        width: number;
        height: number;
        quality: ConversionOptions['quality'];
      }): number => {
        const { frameCount, width, height, quality } = params;
        const megapixelFrames = (width * height * Math.max(1, frameCount)) / 1_000_000;

        // Heuristic only: drives a progress heartbeat (best-effort UI feedback).
        // Higher quality tends to be slower.
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
        if (!intervalId) {
          return;
        }
        ffmpegService.stopProgressHeartbeat(intervalId);
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

      const encodeWithFFmpegFallback = async (errorMessage: string): Promise<Blob> => {
        throwIfCancelled();

        if (
          format === 'gif' &&
          import.meta.env.DEV &&
          devOverrides?.disableFallback === true &&
          devOverrides.forcedGifEncoder === 'modern-gif'
        ) {
          throw new Error(
            `Dev override forced modern-gif with disableFallback; refusing FFmpeg fallback: ${errorMessage}`
          );
        }

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
            releaseWebPFrames();
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
            // Safety timeout: avoid infinite hangs if a worker never responds.
            // Scale with frame count to support longer inputs without being too aggressive.
            const workerEncodeTimeoutMs = Math.min(
              10 * 60 * 1000,
              Math.max(90 * 1000, 20 * 1000 + serializableFrames.length * 500)
            );

            outputBlob = await this.gifWorkerPool.execute(
              async (worker) => {
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
              },
              {
                signal: abortSignal,
                timeoutMs: workerEncodeTimeoutMs,
              }
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
                shouldCancel,
              });
              ffmpegService.reportProgress(encodeEnd);
              encoderBackendUsed = 'modern-gif-main';
            } finally {
              stopEncodeHeartbeat(encodeHeartbeat);
            }
          } catch (fallbackError) {
            const fallbackMessage =
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            outputBlob = await encodeWithFFmpegFallback(fallbackMessage);
          }
        }
      } else if (useModernGif) {
        // Fallback to main thread if workers unavailable
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
              shouldCancel,
            });
            ffmpegService.reportProgress(encodeEnd);
            encoderBackendUsed = 'modern-gif-main';
          } finally {
            stopEncodeHeartbeat(encodeHeartbeat);
          }
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          outputBlob = await encodeWithFFmpegFallback(errorMessage);
        }
      } else if (format === 'webp') {
        if (!encodeReporter) {
          throw new Error('Encode reporter unavailable for WebP encoding.');
        }

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

        const webpEncode = await encodeWebPWithMuxFallback({
          frames: webpCapturedFrames,
          width: decodeResult.width,
          height: decodeResult.height,
          fps: webpFpsForEncoding,
          requestedTargetFpsForDuration: targetFps,
          captureDurationSeconds: decodeResult.duration,
          quality,
          timestampsForFactory: timestampsForEncoding,
          frameTimestampsForMuxer: webpFrameTimestamps,
          durationSecondsForFactory: webpAnimationDurationSeconds,
          metadata,
          codec: metadata?.codec,
          sourceFPS: metadata?.framerate,
          onProgress: encodeReporter.report,
          shouldCancel,
          canEncodeWebPFrames: () => this.getCanvasWebPEncodeSupport(),
          setStatusPrefix: (prefix) => {
            encodeReporter.setStatusPrefix(prefix);
          },
          encodeWithFFmpegFallback,
        });

        outputBlob = webpEncode.blob;
        encoderBackendUsed = webpEncode.encoderBackendUsed;
        releaseWebPFrames();
        webpCapturedFrames.length = 0;
        webpFrameTimestamps.length = 0;
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
      // Always release any captured WebP frames (ImageBitmap/VideoFrame) to avoid GPU leaks.
      try {
        releaseWebPFrames();
      } catch {
        // Non-fatal.
      }
      webpCapturedFrames.length = 0;

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
