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
  cacheWebPChunkSize,
  getCachedCaptureMode,
  getCachedCapturePerformance,
  getCachedWebPChunkSize,
} from '@utils/session-cache';
import { muxAnimatedWebP } from '@utils/webp-muxer';
import { withTimeout } from '@utils/with-timeout';
import { ffmpegService } from './ffmpeg-service';
import { encodeModernGif, isModernGifSupported } from './modern-gif-service';
import { EncoderFactory } from '@services/encoders/encoder-factory';
import { isComplexCodec } from '@services/webcodecs/codec-utils';
import { canUseDemuxer, detectContainer } from '@services/webcodecs/demuxer/demuxer-factory';
import {
  MIN_WEBP_FRAME_DURATION_MS,
  WEBP_BACKGROUND_COLOR,
} from '@services/webcodecs/webp-constants';
import {
  buildDurationAlignedTimestamps as buildDurationAlignedTimestampsUtil,
  buildWebPFrameDurations as buildWebPFrameDurationsUtil,
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

    // Browser-only.
    if (typeof document === 'undefined') {
      this.canvasWebPEncodeSupport = false;
      return false;
    }

    try {
      const supported = await withTimeout(
        new Promise<boolean>((resolve) => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = 2;
            canvas.height = 2;

            const ctx = canvas.getContext('2d');
            if (!ctx) {
              resolve(false);
              return;
            }

            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, 2, 2);

            canvas.toBlob(
              (blob) => {
                resolve(Boolean(blob && blob.size > 0));
              },
              'image/webp',
              0.8
            );
          } catch {
            resolve(false);
          }
        }),
        2_000,
        'Canvas WebP encode probe timed out'
      );

      this.canvasWebPEncodeSupport = supported;
      return supported;
    } catch (error) {
      logger.debug('conversion', 'Canvas WebP encode probe failed (non-critical)', {
        error: getErrorMessage(error),
      });
      this.canvasWebPEncodeSupport = false;
      return false;
    }
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
   * Create WebP frame encoder function
   *
   * Returns a reusable encoder function that converts ImageData to WebP format.
   * Uses OffscreenCanvas when available for better performance.
   *
   * @param qualityRatio - Quality ratio (0.0 to 1.0)
   * @returns Async function that encodes ImageData to WebP Uint8Array
   */
  private createWebPFrameEncoder(qualityRatio: number): (frame: ImageData) => Promise<Uint8Array> {
    let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
    let context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

    return async (frame: ImageData): Promise<Uint8Array> => {
      if (!canvas) {
        if (typeof OffscreenCanvas !== 'undefined') {
          canvas = new OffscreenCanvas(frame.width, frame.height);
          context = canvas.getContext('2d');
        } else {
          const createdCanvas = document.createElement('canvas');
          createdCanvas.width = frame.width;
          createdCanvas.height = frame.height;
          canvas = createdCanvas;
          context = createdCanvas.getContext('2d');
        }
      }

      if (!canvas || !context) {
        throw new Error('Canvas context unavailable for WebP frame encoding.');
      }

      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
      }

      context.putImageData(frame, 0, 0);

      const quality = Math.min(1, Math.max(0, qualityRatio));
      const blob =
        'convertToBlob' in canvas
          ? await (canvas as OffscreenCanvas).convertToBlob({
              type: 'image/webp',
              quality,
            })
          : await new Promise<Blob>((resolve, reject) => {
              (canvas as HTMLCanvasElement).toBlob(
                (result) => {
                  if (result && result.size > 0) {
                    resolve(result);
                    return;
                  }
                  reject(new Error('Failed to encode WebP frame via toBlob.'));
                },
                'image/webp',
                quality
              );
            });

      if (!blob || blob.size === 0) {
        throw new Error('WebP frame encoding produced an empty blob.');
      }

      const buffer = await blob.arrayBuffer();
      return new Uint8Array(buffer);
    };
  }

  /**
   * Validate WebP blob output
   *
   * Checks WebP file signature, minimum size, and decodability.
   *
   * @param blob - WebP blob to validate
   * @returns Validation result with optional failure reason
   */
  private async validateWebPBlob(blob: Blob): Promise<{ valid: boolean; reason?: string }> {
    if (blob.size < FFMPEG_INTERNALS.OUTPUT_VALIDATION.MIN_WEBP_SIZE_BYTES) {
      return {
        valid: false,
        reason: `WebP output too small (${blob.size} bytes)`,
      };
    }

    const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const riffSignature = String.fromCharCode(...header.slice(0, 4));
    const webpSignature = String.fromCharCode(...header.slice(8, 12));
    if (riffSignature !== 'RIFF' || webpSignature !== 'WEBP') {
      return {
        valid: false,
        reason: 'Invalid WebP file signature',
      };
    }

    // Animated WebP decode support differs across browsers/APIs.
    // `createImageBitmap()` may fail even for valid animated WebP files.
    // Detect animation chunks and treat decode failures as non-fatal in that case.
    const scanLimitBytes = Math.min(blob.size, 256 * 1024);
    const scanBytes = new Uint8Array(await blob.slice(0, scanLimitBytes).arrayBuffer());

    const containsFourCc = (bytes: Uint8Array, fourcc: string): boolean => {
      if (fourcc.length !== 4 || bytes.length < 4) {
        return false;
      }

      const a = fourcc.charCodeAt(0);
      const b = fourcc.charCodeAt(1);
      const c = fourcc.charCodeAt(2);
      const d = fourcc.charCodeAt(3);

      for (let i = 0; i <= bytes.length - 4; i++) {
        if (bytes[i] === a && bytes[i + 1] === b && bytes[i + 2] === c && bytes[i + 3] === d) {
          return true;
        }
      }
      return false;
    };

    const isAnimatedWebP = containsFourCc(scanBytes, 'ANIM') || containsFourCc(scanBytes, 'ANMF');

    // Quick structural sanity check: animated WebP requires VP8X with the animation flag set.
    // If we accidentally produce ANIM/ANMF without VP8X.animation, many decoders will reject
    // the file (and users will see an "empty"/unopenable output).
    const tryReadVp8xFlags = (bytes: Uint8Array): number | null => {
      if (bytes.length < 12) {
        return null;
      }

      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const readFourCcAt = (offset: number): string =>
        String.fromCharCode(
          bytes[offset] ?? 0,
          bytes[offset + 1] ?? 0,
          bytes[offset + 2] ?? 0,
          bytes[offset + 3] ?? 0
        );

      let offset = 12;
      while (offset + 8 <= bytes.length) {
        const fourcc = readFourCcAt(offset);
        const chunkSize = view.getUint32(offset + 4, true);
        const payloadStart = offset + 8;
        const payloadEnd = payloadStart + chunkSize;

        if (payloadEnd > bytes.length) {
          return null;
        }

        if (fourcc === 'VP8X') {
          if (chunkSize < 1) {
            return null;
          }
          return bytes[payloadStart] ?? null;
        }

        offset = payloadEnd + (chunkSize % 2);
      }

      return null;
    };

    if (isAnimatedWebP) {
      const vp8xFlags = tryReadVp8xFlags(scanBytes);
      if (vp8xFlags === null) {
        return {
          valid: false,
          reason: 'Animated WebP missing VP8X header chunk',
        };
      }

      const VP8X_ANIMATION_FLAG = 0x02;
      if ((vp8xFlags & VP8X_ANIMATION_FLAG) === 0) {
        return {
          valid: false,
          reason: 'Animated WebP missing VP8X animation flag',
        };
      }
    }

    const tryDecodeWithImageElement = async (): Promise<void> => {
      if (typeof document === 'undefined') {
        throw new Error('Document unavailable for WebP decode check');
      }

      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.decoding = 'async';
        img.src = url;

        if (typeof img.decode === 'function') {
          await img.decode();
          return;
        }

        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('Image element failed to decode WebP'));
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    };

    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(blob);
        bitmap.close();
      } catch (error) {
        if (isAnimatedWebP) {
          // Best-effort fallback decode check.
          try {
            await tryDecodeWithImageElement();
            return { valid: true };
          } catch (imgError) {
            logger.warn(
              'conversion',
              'Animated WebP decode check failed; accepting based on container validation',
              {
                size: blob.size,
                createImageBitmapError: getErrorMessage(error),
                imageDecodeError: getErrorMessage(imgError),
              }
            );
            return { valid: true };
          }
        }

        return {
          valid: false,
          reason: `WebP decode failed: ${getErrorMessage(error)}`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Build frame duration array for WebP animation
   *
   * Calculates frame durations using one of two modes:
   * 1. UNIFORM MODE (when source FPS >> target FPS or complex codec):
   *    - Uses fixed duration: 1000/targetFPS ms per frame
   *    - Prevents stuttering caused by uneven timestamp capture during FPS downsampling
   *    - Always used for complex codecs (AV1, VP9, HEVC) to ensure smooth playback
   *    - Example: 30 FPS source → 24 FPS target uses 41.67ms per frame
   *
   * 2. VARIABLE MODE (when source FPS ≈ target FPS and simple codec):
   *    - Uses timestamp deltas for accurate timing
   *    - Preserves variable frame rate (VFR) content
   *    - Example: 24 FPS source → 24 FPS target uses actual capture times
   *
   * @param timestamps - Array of frame timestamps in seconds
   * @param fps - Target frames per second
   * @param frameCount - Total number of frames
   * @param sourceFPS - Optional source video FPS for downsampling detection
   * @param codec - Optional codec string for complex codec detection
   * @param durationSeconds - Optional effective animation duration in seconds for total-duration alignment
   * @returns Array of frame durations in milliseconds
   */
  private buildWebPFrameDurations(
    timestamps: number[],
    fps: number,
    frameCount: number,
    sourceFps?: number,
    codec?: string,
    durationSeconds?: number
  ): number[] {
    return buildWebPFrameDurationsUtil({
      timestamps,
      fps,
      frameCount,
      sourceFPS: sourceFps,
      codec,
      durationSeconds,
    });
  }

  /**
   * Mux WebP frames into animated WebP
   *
   * Combines encoded WebP frames with timing information into single animated WebP file.
   *
   * @param params - Muxing parameters
   * @param params.encodedFrames - Array of encoded WebP frame data
   * @param params.timestamps - Frame timestamps in seconds
   * @param params.width - Frame width in pixels
   * @param params.height - Frame height in pixels
   * @param params.fps - Target frames per second
   * @param params.metadata - Optional video metadata for FPS downsampling detection
   * @param params.onProgress - Optional progress callback
   * @param params.shouldCancel - Optional cancellation check
   * @returns Animated WebP blob or null if no frames
   */
  private async muxWebPFrames(params: {
    encodedFrames: Uint8Array[];
    timestamps: number[];
    width: number;
    height: number;
    fps: number;
    metadata?: VideoMetadata;
    durationSeconds?: number;
    onProgress?: (current: number, total: number) => void;
    shouldCancel?: () => boolean;
  }): Promise<Blob | null> {
    const {
      encodedFrames,
      timestamps,
      width,
      height,
      fps,
      metadata,
      durationSeconds,
      onProgress,
      shouldCancel,
    } = params;

    if (!encodedFrames.length) {
      return null;
    }

    const animationDurationSeconds = this.resolveAnimationDurationSeconds(
      encodedFrames.length,
      fps,
      metadata,
      durationSeconds
    );

    const durations = this.buildWebPFrameDurations(
      timestamps,
      fps,
      encodedFrames.length,
      metadata?.framerate,
      metadata?.codec,
      animationDurationSeconds
    );

    // Log duration statistics for debugging
    if (durations.length > 0) {
      const avgDuration = durations.reduce((sum, d) => sum + d, 0) / durations.length;
      const minDuration = Math.min(...durations);
      const maxDuration = Math.max(...durations);
      const variance = maxDuration - minDuration;

      logger.info('conversion', 'WebP frame duration statistics', {
        frameCount: durations.length,
        avgDuration: `${avgDuration.toFixed(2)}ms`,
        minDuration: `${minDuration}ms`,
        maxDuration: `${maxDuration}ms`,
        variance: `${variance}ms`,
        isUniform: variance === 0,
      });
    }

    if (encodedFrames.length === 1) {
      onProgress?.(1, 1);
      const frame = encodedFrames[0];
      if (!frame) {
        return null;
      }

      const buffer = frame.slice().buffer;
      return new Blob([buffer], { type: 'image/webp' });
    }

    const framesForMux = encodedFrames.map((frame, index) => {
      if (!frame) {
        throw new Error('Missing encoded frame for WebP muxing.');
      }

      if (shouldCancel?.()) {
        throw new Error('Conversion cancelled by user');
      }

      onProgress?.(index + 1, encodedFrames.length);

      const buffer = frame.slice().buffer as ArrayBuffer;
      const duration =
        durations[index] ?? durations[durations.length - 1] ?? MIN_WEBP_FRAME_DURATION_MS;

      return { data: buffer, duration };
    });

    const muxed = await muxAnimatedWebP(framesForMux, {
      width,
      height,
      loopCount: 0,
      backgroundColor: WEBP_BACKGROUND_COLOR,
    });

    onProgress?.(encodedFrames.length, encodedFrames.length);

    return new Blob([muxed], { type: 'image/webp' });
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
    const supportsFrameCallback =
      typeof document !== 'undefined' &&
      typeof HTMLVideoElement !== 'undefined' &&
      typeof (
        document.createElement('video') as unknown as {
          requestVideoFrameCallback?: unknown;
        }
      ).requestVideoFrameCallback === 'function';

    const getAv1CaptureFpsCap = (durationSeconds?: number): number => {
      // AV1 frame extraction is often dominated by canvas encoding (PNG) rather than FFmpeg.
      // Capping extraction FPS significantly reduces total time while preserving overall
      // animation duration via duration-aligned timestamps.
      const isShort = !durationSeconds || durationSeconds < 4;
      const isMedium =
        typeof durationSeconds === 'number' &&
        Number.isFinite(durationSeconds) &&
        durationSeconds >= 4 &&
        durationSeconds < 30;

      if (isShort) {
        // Short clips: keep motion smooth.
        return 15;
      }

      if (isMedium) {
        // Medium clips: balance speed and smoothness.
        if (options.quality === 'high') {
          return 12;
        }
        if (options.quality === 'medium') {
          return 10;
        }
        return 8;
      }

      // Long clips: prioritize speed.
      if (options.quality === 'high') {
        return 10;
      }
      if (options.quality === 'medium') {
        return 8;
      }
      return 6;
    };

    const av1CaptureFpsCap = isAv1 ? getAv1CaptureFpsCap(metadata?.duration) : requestedTargetFps;
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

    // Cache capture mode reliability per-session to avoid repeatedly spending time
    // probing a mode that consistently under-captures on this device/browser.
    // This is intentionally session-scoped (sessionStorage) to avoid sticky behavior
    // across browser updates.
    const readSessionNumber = (key: string): number => {
      try {
        if (typeof sessionStorage === 'undefined') {
          return 0;
        }
        const raw = sessionStorage.getItem(key);
        if (!raw) {
          return 0;
        }
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : 0;
      } catch {
        return 0;
      }
    };

    const writeSessionNumber = (key: string, value: number) => {
      try {
        if (typeof sessionStorage === 'undefined') {
          return;
        }
        sessionStorage.setItem(key, String(value));
      } catch {
        // Ignore storage failures (privacy modes / disabled storage).
      }
    };

    const getAv1SeekFpsCap = (durationSeconds?: number): number => {
      // Adaptive FPS capping for mixed workload
      // Short clips: prioritize quality, medium/long: prioritize speed
      const isShort = !durationSeconds || durationSeconds < 4;
      const isMedium =
        typeof durationSeconds === 'number' &&
        Number.isFinite(durationSeconds) &&
        durationSeconds >= 4 &&
        durationSeconds < 30;

      if (isShort) {
        return 12; // Short clips: maintain quality
      }
      if (isMedium) {
        return options.quality === 'high' ? 10 : 8; // Medium: balance speed/quality
      }
      // Long videos (>=30s): aggressive FPS capping for speed
      return options.quality === 'high' ? 8 : 6;
    };

    const av1FrameCallbackFailureKey = 'dropconvert:captureReliability:av1:frame-callback:failures';
    const av1FrameCallbackFailures = isAv1 ? readSessionNumber(av1FrameCallbackFailureKey) : 0;
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
            key: av1FrameCallbackFailureKey,
            codec: metadata?.codec ?? 'unknown',
          }
        );
      }

      const initialSeekTargetFps =
        initialCaptureMode === 'seek' && isAv1
          ? Math.min(effectiveTargetFps, getAv1SeekFpsCap(metadata?.duration))
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
            ? Math.min(effectiveTargetFps, getAv1SeekFpsCap(metadata?.duration))
            : effectiveTargetFps;

        const attempt = await runDecodeWithTiming(fallbackInitial, fallbackSeekTargetFps);
        decodeResult = attempt.result;
        perfElapsed = attempt.elapsedMs;
      }

      // If auto capture under-extracts frames compared to duration-based target,
      // retry with deterministic seek capture to ensure enough images for smooth motion.
      // Use actual FPS from decode result (not original targetFps) to avoid false validation failures
      const expectedFramesFromDuration = Math.min(
        maxFrames,
        Math.max(1, Math.ceil(Math.max(0, decodeResult.duration) * Math.max(1, decodeResult.fps)))
      );
      const requiredFrames = Math.max(1, expectedFramesFromDuration - 1);

      if (maxFrames > 1 && decodeResult.frameCount < requiredFrames) {
        // Track repeated AV1 frame-callback under-capture. If this happens consistently,
        // start directly with seek in subsequent conversions for this session.
        if (
          isAv1 &&
          supportsFrameCallback &&
          (decodeResult.captureModeUsed ?? initialCaptureMode) === 'frame-callback'
        ) {
          writeSessionNumber(av1FrameCallbackFailureKey, av1FrameCallbackFailures + 1);
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
        const retryExpectedFramesFromDuration = Math.min(
          maxFrames,
          Math.max(1, Math.ceil(Math.max(0, decodeResult.duration) * Math.max(1, decodeResult.fps)))
        );
        const retryRequiredFrames = Math.max(1, retryExpectedFramesFromDuration - 1);

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
            const av1SeekFpsCap = getAv1SeekFpsCap(decodeResult.duration);
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

        const finalExpectedFramesFromDuration = Math.min(
          maxFrames,
          Math.max(1, Math.ceil(Math.max(0, decodeResult.duration) * Math.max(1, decodeResult.fps)))
        );
        const finalRequiredFrames = Math.max(1, finalExpectedFramesFromDuration - 1);

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
          writeSessionNumber(av1FrameCallbackFailureKey, 0);
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
      const validationExpectedFrames = Math.min(
        maxFrames,
        Math.max(1, Math.ceil(Math.max(0, decodeResult.duration) * Math.max(1, decodeResult.fps)))
      );
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
      const estimatedFramesFromCapturedDuration = Math.max(
        1,
        Math.ceil(Math.max(0, decodeResult.duration) * Math.max(1, decodeResult.fps))
      );

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

      ffmpegService.reportStatus('Encoding WebP frames...');

      const encodeStart = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START;
      const encodeEnd = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_END;
      const reportEncodeProgress = (current: number, total: number) => {
        if (shouldCancelOrDefault()) {
          throw new Error('Conversion cancelled by user');
        }
        const progress = encodeStart + ((encodeEnd - encodeStart) * current) / Math.max(1, total);
        ffmpegService.reportProgress(Math.round(progress));
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

      // Prefer worker-based WebP encoding when available.
      try {
        const encoder = await EncoderFactory.getEncoder('webp', {
          preferWorkers: true,
          quality: options.quality,
        });

        if (encoder) {
          // Respect encoder constraints (defensive).
          const maxFramesAllowed = encoder.capabilities.maxFrames;
          if (maxFramesAllowed && orderedImageData.length > maxFramesAllowed) {
            logger.warn('conversion', 'Skipping worker WebP encoder due to maxFrames constraint', {
              encoder: encoder.name,
              frameCount: orderedImageData.length,
              maxFramesAllowed,
            });
          } else if (
            encoder.capabilities.maxDimension &&
            Math.max(decodeResult.width, decodeResult.height) > encoder.capabilities.maxDimension
          ) {
            logger.warn(
              'conversion',
              'Skipping worker WebP encoder due to maxDimension constraint',
              {
                encoder: encoder.name,
                width: decodeResult.width,
                height: decodeResult.height,
                maxDimension: encoder.capabilities.maxDimension,
              }
            );
          } else {
            outputBlob = await encoder.encode({
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
          }
        }
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        if (shouldCancelOrDefault()) {
          throw error;
        }
        logger.warn('conversion', 'Worker WebP encoder failed; falling back to main thread muxer', {
          error: errorMessage,
          codec: metadata?.codec ?? 'unknown',
        });
      }

      if (!outputBlob) {
        // Fallback: main-thread WebP muxer path.
        const webpQualityRatio = QUALITY_PRESETS.webp[options.quality].quality / 100;
        const encodeFrame = this.createWebPFrameEncoder(webpQualityRatio);

        const hwConcurrency = navigator.hardwareConcurrency || 4;
        const cachedChunkSize = getCachedWebPChunkSize();
        const ChunkSize =
          cachedChunkSize && isHardwareCacheValid()
            ? cachedChunkSize
            : Math.min(20, Math.max(10, hwConcurrency * 2));

        const encodedFrames: Uint8Array[] = [];
        const totalFrames = orderedImageData.length;

        logger.info('conversion', 'Encoding WebP frames on main thread (fallback)', {
          frameCount: totalFrames,
          chunkSize: ChunkSize,
          codec: metadata?.codec ?? 'unknown',
        });

        for (let i = 0; i < totalFrames; i += ChunkSize) {
          if (shouldCancelOrDefault()) {
            throw new Error('Conversion cancelled by user');
          }

          const chunk = orderedImageData.slice(i, Math.min(i + ChunkSize, totalFrames));
          const encodedChunk = await Promise.all(chunk.map((frame) => encodeFrame(frame)));
          encodedFrames.push(...encodedChunk);
          reportEncodeProgress(encodedFrames.length, totalFrames);
        }

        if (!cachedChunkSize && encodedFrames.length > 0) {
          cacheWebPChunkSize(ChunkSize);
          logger.info('conversion', 'Cached WebP chunk size for future conversions', {
            chunkSize: ChunkSize,
          });
        }

        ffmpegService.reportStatus('Muxing WebP frames...');

        outputBlob = await this.muxWebPFrames({
          encodedFrames,
          timestamps: timestampsForEncoding,
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

      const validation = await this.validateWebPBlob(outputBlob);
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

    const throwIfCancelled = (): void => {
      if (abortSignal?.aborted || ffmpegService.isCancellationRequested()) {
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
      return ffmpegService.convertToGIF(file, options, metadata);
    }

    throwIfCancelled();

    const decoder = new WebCodecsDecoderService();
    const capturedFrames: ImageData[] = [];
    const webpCapturedFrames: ImageData[] = []; // Collect WebP frames for batch encoding
    const webpEncodedFrames: Uint8Array[] = [];
    const webpFrameTimestamps: number[] = [];
    const webpQualityRatio = format === 'webp' ? QUALITY_PRESETS.webp[quality].quality / 100 : null;
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
    const reportDecodeProgress = (current: number, total: number) => {
      throwIfCancelled();
      const progress = decodeStart + ((decodeEnd - decodeStart) * current) / Math.max(1, total);
      ffmpegService.reportProgress(Math.round(progress));
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
            shouldCancel: () =>
              abortSignal?.aborted === true || ffmpegService.isCancellationRequested(),
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
            shouldCancel: () =>
              abortSignal?.aborted === true || ffmpegService.isCancellationRequested(),
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
          webpEncodedFrames.length = 0;
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
      ffmpegService.reportStatus(`Encoding ${format.toUpperCase()}...`);

      const reportEncodeProgress = (current: number, total: number) => {
        throwIfCancelled();
        const progress =
          FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START +
          ((FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_END -
            FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START) *
            current) /
            Math.max(1, total);
        ffmpegService.reportProgress(Math.round(progress));
      };

      const encodeWithFFmpegFallback = async (errorMessage: string): Promise<Blob> => {
        throwIfCancelled();
        // H.264 intermediate path already attempted at the start of convert()
        // Skip redundant retry and go directly to FFmpeg frame re-extraction
        logger.warn('conversion', 'WebCodecs encoder failed, retrying with FFmpeg frames', {
          error: errorMessage,
        });

        if (!ffmpegService.isLoaded()) {
          await ffmpegService.initialize();
        }

        capturedFrames.length = 0;
        webpCapturedFrames.length = 0;
        webpEncodedFrames.length = 0;
        webpFrameTimestamps.length = 0;

        ffmpegService.reportStatus(`Retrying ${format.toUpperCase()} encode with FFmpeg...`);
        ffmpegService.reportProgress(decodeStart);

        const fallbackFrameFiles: string[] = [];
        let fallbackResult: Awaited<ReturnType<WebCodecsDecoderService['decodeToFrames']>>;
        let lastValidFallbackFrame: Uint8Array | null = null;

        try {
          fallbackResult = await decoder.decodeToFrames({
            file,
            targetFps,
            scale,
            frameFormat: FFMPEG_INTERNALS.WEBCODECS.FRAME_FORMAT,
            frameQuality: FFMPEG_INTERNALS.WEBCODECS.FRAME_QUALITY,
            framePrefix: FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_PREFIX,
            frameDigits: FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_DIGITS,
            frameStartNumber: FFMPEG_INTERNALS.WEBCODECS.FRAME_START_NUMBER,
            captureMode: 'auto',
            codec: metadata?.codec,
            quality: options.quality,
            shouldCancel: () =>
              abortSignal?.aborted === true || ffmpegService.isCancellationRequested(),
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

        // CRITICAL: Validate fallback frame capture completeness
        // Incomplete sequences here will definitely hang the FFmpeg encoder
        const validationExpectedFrames = Math.max(
          1,
          Math.ceil(Math.max(0, fallbackResult.duration) * Math.max(1, targetFps))
        );
        const captureRatio = fallbackResult.frameCount / validationExpectedFrames;
        const minRequiredRatio = 0.5;
        const minAbsoluteFrames = 10;

        if (fallbackResult.frameCount < minAbsoluteFrames || captureRatio < minRequiredRatio) {
          // Cleanup files before throwing
          if (fallbackFrameFiles.length > 0) {
            await ffmpegService.deleteVirtualFiles(fallbackFrameFiles);
          }

          const errorMsg =
            `Fallback frame extraction incomplete: captured ${fallbackResult.frameCount} of ${validationExpectedFrames} frames ` +
            `(${(captureRatio * 100).toFixed(1)}%). Minimum required: ${minRequiredRatio * 100}%.`;

          logger.error('conversion', errorMsg, {
            captured: fallbackResult.frameCount,
            expected: validationExpectedFrames,
            duration: fallbackResult.duration,
          });

          // Last-resort fallback: avoid hard-failing when WebCodecs frame capture is incomplete.
          // This can happen on some devices/browsers even when FFmpeg can still transcode directly.
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

          return format === 'webp'
            ? await ffmpegService.convertToWebP(file, options, metadata)
            : await ffmpegService.convertToGIF(file, options, metadata);
        }

        const fallbackDurationSeconds = this.resolveAnimationDurationSeconds(
          fallbackResult.frameCount,
          targetFps,
          metadata,
          fallbackResult.duration
        );

        const fallbackFps = this.resolveWebPFps(
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

        return await ffmpegService.encodeFrameSequence({
          format: format as 'gif' | 'webp',
          options,
          frameCount: fallbackResult.frameCount,
          fps: fallbackFps,
          durationSeconds: fallbackDurationSeconds ?? metadata?.duration ?? fallbackResult.duration,
          frameFiles: fallbackFrameFiles,
        });
      };

      let outputBlob: Blob;

      if (useModernGif && this.gifWorkerPool) {
        // Use worker pool for GIF encoding
        try {
          // Convert ImageData to serializable format for worker transfer
          // ImageData objects cannot be cloned by postMessage - must transfer underlying buffer
          const serializableFrames = capturedFrames.map((frame) => ({
            data: frame.data,
            width: frame.width,
            height: frame.height,
            colorSpace: frame.colorSpace,
          }));

          const encodeHeartbeat = ffmpegService.startProgressHeartbeat(
            FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START,
            FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_END,
            Math.min(180, Math.max(20, Math.round(serializableFrames.length / 4)))
          );

          try {
            outputBlob = await this.gifWorkerPool.execute(async (worker) => {
              return await worker.encode(serializableFrames, {
                width: decodeResult.width,
                height: decodeResult.height,
                fps: targetFps,
                quality,
              });
            });
          } finally {
            ffmpegService.stopProgressHeartbeat(encodeHeartbeat);
          }
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
              shouldCancel: () => ffmpegService.isCancellationRequested(),
            });
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
            shouldCancel: () => ffmpegService.isCancellationRequested(),
          });
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

        // Prefer EncoderFactory-selected WebP encoder so availability checks and
        // fallback selection are consistent across standard and complex codec flows.
        let factoryEncodedWebP: Blob | null = null;
        let selectedEncoderName: string | null = null;

        if (webpCapturedFrames.length > 0) {
          try {
            const encoder = await EncoderFactory.getEncoder('webp', {
              preferWorkers: true,
              quality,
            });

            if (encoder) {
              selectedEncoderName = encoder.name;

              const maxFramesAllowed = encoder.capabilities.maxFrames;
              if (maxFramesAllowed && webpCapturedFrames.length > maxFramesAllowed) {
                logger.warn('conversion', 'Skipping WebP encoder due to maxFrames constraint', {
                  encoder: encoder.name,
                  frameCount: webpCapturedFrames.length,
                  maxFramesAllowed,
                });
              } else if (
                encoder.capabilities.maxDimension &&
                Math.max(decodeResult.width, decodeResult.height) >
                  encoder.capabilities.maxDimension
              ) {
                logger.warn('conversion', 'Skipping WebP encoder due to maxDimension constraint', {
                  encoder: encoder.name,
                  width: decodeResult.width,
                  height: decodeResult.height,
                  maxDimension: encoder.capabilities.maxDimension,
                });
              } else {
                const timestampsForEncoding =
                  webpFrameTimestamps.length >= webpCapturedFrames.length
                    ? webpFrameTimestamps.slice(0, webpCapturedFrames.length)
                    : undefined;

                factoryEncodedWebP = await encoder.encode({
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
                  shouldCancel: () => ffmpegService.isCancellationRequested(),
                });

                const validation = await this.validateWebPBlob(factoryEncodedWebP);
                if (!validation.valid) {
                  logger.warn('conversion', 'EncoderFactory WebP output failed validation', {
                    encoder: encoder.name,
                    reason: validation.reason ?? 'validation_failed',
                    frameCount: webpCapturedFrames.length,
                  });
                  factoryEncodedWebP = null;
                }
              }
            }
          } catch (error) {
            const errorMessage = getErrorMessage(error);
            if (ffmpegService.isCancellationRequested()) {
              throw error;
            }
            logger.warn(
              'conversion',
              'EncoderFactory WebP encoding failed; falling back to muxer',
              {
                encoder: selectedEncoderName,
                error: errorMessage,
              }
            );
          }
        }

        if (factoryEncodedWebP) {
          outputBlob = factoryEncodedWebP;
          webpCapturedFrames.length = 0;
          webpEncodedFrames.length = 0;
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

            // Batch encode WebP frames in parallel for 3-4x speedup
            if (webpCapturedFrames.length > 0 && webpQualityRatio !== null) {
              // Dynamic chunk size based on CPU cores for better parallelization
              const hwConcurrency = navigator.hardwareConcurrency || 4;
              const cachedChunkSize = getCachedWebPChunkSize();
              const ChunkSize =
                cachedChunkSize && isHardwareCacheValid()
                  ? cachedChunkSize
                  : Math.min(20, Math.max(10, hwConcurrency * 2));
              const totalFrames = webpCapturedFrames.length;

              logger.info('conversion', 'Parallel WebP frame encoding', {
                totalFrames,
                chunkSize: ChunkSize,
                estimatedBatches: Math.ceil(totalFrames / ChunkSize),
                cached: !!cachedChunkSize,
              });

              // Create encoder function for parallel execution
              const encodeFrame = this.createWebPFrameEncoder(webpQualityRatio);

              // Process frames in batches
              for (let i = 0; i < totalFrames; i += ChunkSize) {
                const chunk = webpCapturedFrames.slice(i, Math.min(i + ChunkSize, totalFrames));

                // Encode chunk in parallel using Promise.all
                const encodedChunk = await Promise.all(
                  chunk.map((frameData) => encodeFrame(frameData))
                );

                webpEncodedFrames.push(...encodedChunk);

                // Report encoding progress
                reportEncodeProgress(webpEncodedFrames.length, totalFrames);
              }

              logger.info('conversion', 'Parallel encoding complete', {
                encodedFrames: webpEncodedFrames.length,
              });

              // Cache successful chunk size for future conversions
              if (!cachedChunkSize && webpEncodedFrames.length > 0) {
                cacheWebPChunkSize(ChunkSize);
                logger.info('conversion', 'Cached WebP chunk size for future conversions', {
                  chunkSize: ChunkSize,
                });
              }
            }

            let fallbackReason = 'WebP muxer output failed';

            const animationDurationSeconds = this.resolveAnimationDurationSeconds(
              webpEncodedFrames.length,
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
                  frameCount: webpEncodedFrames.length,
                  fps: targetFps,
                }
              );
            }

            const muxedWebP = await (async (): Promise<Blob | null> => {
              try {
                const result = await this.muxWebPFrames({
                  encodedFrames: webpEncodedFrames,
                  timestamps: webpFrameTimestamps,
                  width: decodeResult.width,
                  height: decodeResult.height,
                  fps: webpFpsForEncoding,
                  metadata,
                  durationSeconds: animationDurationSeconds,
                  onProgress: reportEncodeProgress,
                  shouldCancel: () => ffmpegService.isCancellationRequested(),
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

                const validation = await this.validateWebPBlob(result);
                if (!validation.valid) {
                  fallbackReason = validation.reason ?? 'WebP muxer output failed validation';
                  logger.warn('conversion', 'WebP muxer output failed validation, using fallback', {
                    reason: validation.reason,
                    frameCount: webpEncodedFrames.length,
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
                  frameCount: webpEncodedFrames.length,
                });
                return null;
              }
            })();

            outputBlob = muxedWebP ?? (await encodeWithFFmpegFallback(fallbackReason));

            webpEncodedFrames.length = 0;
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
