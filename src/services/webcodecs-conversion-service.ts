// External dependencies

// Type imports
import type {
  ConversionOptions,
  ConversionOutputBlob,
  VideoMetadata,
} from '../types/conversion-types';
import type { EncoderWorkerAPI } from '../types/worker-types';
import { COMPLEX_CODECS, QUALITY_PRESETS, WEBCODECS_ACCELERATED } from '../utils/constants';
import { getErrorMessage } from '../utils/error-utils';
import { FFMPEG_INTERNALS } from '../utils/ffmpeg-constants';
import { logger } from '../utils/logger';
import { getAvailableMemory, isMemoryCritical } from '../utils/memory-monitor';
import { getOptimalFPS } from '../utils/quality-optimizer';
import { muxAnimatedWebP } from '../utils/webp-muxer';
import { ffmpegService } from './ffmpeg-service';
import { ModernGifService } from './modern-gif-service';
import type { WebCodecsCaptureMode, WebCodecsFrameFormat } from './webcodecs-decoder-service';
import { WebCodecsDecoderService } from './webcodecs-decoder-service';
import { isWebCodecsCodecSupported, isWebCodecsDecodeSupported } from './webcodecs-support-service';
import { getOptimalPoolSize, WorkerPool } from './worker-pool-service';

/**
 * Maximum number of frames for WebP animation
 * Limits frame count to prevent memory issues and ensure compatibility
 */
const WEBP_ANIMATION_MAX_FRAMES = 240;

/**
 * Maximum duration in seconds for WebP animation
 * Prevents excessively long animations that could cause performance issues
 */
const WEBP_ANIMATION_MAX_DURATION_SECONDS = 10;

/**
 * Minimum frame duration in milliseconds for WebP
 * WebP spec requires at least 8ms per frame
 */
const MIN_WEBP_FRAME_DURATION_MS = 8;

/**
 * Maximum frame duration value (24-bit ceiling)
 * WebP format stores duration in 24 bits: 0xFFFFFF milliseconds
 */
const MAX_WEBP_DURATION_24BIT = 0xffffff;

/**
 * Transparent black background color for WebP animations
 * RGBA(0, 0, 0, 0) for proper alpha channel handling
 */
const WEBP_BACKGROUND_COLOR = { r: 0, g: 0, b: 0, a: 0 } as const;

/**
 * Threshold for detecting significant FPS downsampling.
 * If source FPS exceeds target FPS by more than this ratio, use uniform frame durations
 * to avoid stuttering from uneven timestamp capture.
 *
 * Lowered from 1.15 to 1.05 to use uniform durations more aggressively,
 * which prevents stuttering in complex codecs like AV1/VP9/HEVC.
 *
 * Examples:
 * - 30 FPS → 24 FPS: ratio = 1.25 > 1.05 → uniform durations (smooth)
 * - 25 FPS → 24 FPS: ratio = 1.04 < 1.05 → variable durations (preserves VFR)
 * - 60 FPS → 30 FPS: ratio = 2.0 > 1.05 → uniform durations (smooth)
 */
const FPS_DOWNSAMPLING_THRESHOLD = 1.05;

/**
 * Check if codec is complex (requires special handling)
 *
 * Complex codecs like AV1, VP9, and HEVC require direct WebCodecs frame extraction
 * to avoid double transcoding overhead.
 *
 * @param codec - Video codec string (e.g., 'av01', 'vp09', 'hev1')
 * @returns True if codec is in the complex codec list
 */
const isComplexCodec = (codec?: string): boolean => {
  if (!codec || codec === 'unknown') {
    return false;
  }
  const normalized = codec.toLowerCase();
  return COMPLEX_CODECS.some((entry) => normalized.includes(entry));
};

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
    // NOTE: FFmpeg metadata probing can return duration=0 for some containers/codecs.
    // Treat non-positive / non-finite durations as unknown to avoid clamping the
    // extraction window to 1s (which severely under-samples frames and causes choppy motion).
    // Additionally, some files report implausibly small durations (e.g., <1s) during probe.
    // Using those values would cap extraction to ~1s (via Math.max(1, ...)), causing too few
    // frames for multi-second sources. It's safe to treat small durations as unknown because
    // the decoder will still stop at the real video duration.
    if (durationSeconds !== undefined) {
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        logger.warn(
          'conversion',
          'Invalid duration provided for WebP frame budget; falling back to default budget window',
          {
            durationSeconds,
            targetFps,
          }
        );
      } else if (durationSeconds < 1) {
        logger.debug('conversion', 'Short duration provided for WebP frame budget; using default', {
          durationSeconds,
          targetFps,
        });
      }
    }

    const safeDurationSeconds =
      durationSeconds && Number.isFinite(durationSeconds) && durationSeconds >= 1
        ? durationSeconds
        : undefined;

    const cappedDuration = Math.max(
      1,
      Math.min(
        safeDurationSeconds ?? WEBP_ANIMATION_MAX_DURATION_SECONDS,
        WEBP_ANIMATION_MAX_DURATION_SECONDS
      )
    );
    const estimatedFrames = Math.ceil(cappedDuration * Math.max(1, targetFps));
    const maxFrames = Math.max(1, Math.min(estimatedFrames, WEBP_ANIMATION_MAX_FRAMES));

    logger.debug(
      'conversion',
      `Computed WebP frame extraction budget: targetFps=${targetFps}, durationUsedSeconds=${(
        safeDurationSeconds ?? WEBP_ANIMATION_MAX_DURATION_SECONDS
      ).toFixed(
        3
      )}, cappedDurationSeconds=${cappedDuration.toFixed(3)}, estimatedFrames=${estimatedFrames}, maxFrames=${maxFrames}`,
      {
        targetFps,
        durationSeconds: durationSeconds ?? null,
        durationUsedSeconds: safeDurationSeconds ?? WEBP_ANIMATION_MAX_DURATION_SECONDS,
        cappedDurationSeconds: cappedDuration,
        estimatedFrames,
        maxFrames,
      }
    );

    return maxFrames;
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
    if (frameCount <= 0) {
      return undefined;
    }

    const durationCandidates: number[] = [];

    if (metadata?.duration && Number.isFinite(metadata.duration) && metadata.duration > 0) {
      durationCandidates.push(metadata.duration);
    }

    if (
      captureDurationSeconds &&
      Number.isFinite(captureDurationSeconds) &&
      captureDurationSeconds > 0
    ) {
      durationCandidates.push(captureDurationSeconds);
    }

    if (durationCandidates.length === 0) {
      return undefined;
    }

    const maxDurationSeconds = Math.max(...durationCandidates);
    const cappedDurationSeconds = Math.min(maxDurationSeconds, WEBP_ANIMATION_MAX_DURATION_SECONDS);
    const minimumDurationSeconds = Math.max(0.016, 1 / Math.max(targetFps || 1, 60));

    return Math.max(minimumDurationSeconds, cappedDurationSeconds);
  }

  /**
   * Derive an FPS value that matches captured frames to the effective duration.
   * Clamps to the requested target FPS to avoid overspeed playback while
   * preserving the original pacing for low-FPS or sparse frame captures.
   */
  private resolveWebPFps(frameCount: number, targetFps: number, durationSeconds?: number): number {
    if (!Number.isFinite(targetFps) || targetFps <= 0) {
      return 1;
    }

    if (frameCount <= 0) {
      return Math.max(1, Math.round(targetFps));
    }

    const safeDurationSeconds =
      durationSeconds && Number.isFinite(durationSeconds) && durationSeconds > 0
        ? durationSeconds
        : frameCount / targetFps;

    const derivedFps = frameCount / Math.max(safeDurationSeconds, 1 / targetFps);
    const clampedFps = Math.max(1, Math.min(targetFps, derivedFps));

    return Math.round(clampedFps * 1000) / 1000;
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
    const { frameCount, durationSeconds, fallbackFps } = params;

    if (frameCount <= 0) {
      return [];
    }

    const safeDurationSeconds =
      durationSeconds && Number.isFinite(durationSeconds) && durationSeconds > 0
        ? durationSeconds
        : frameCount / Math.max(1, fallbackFps);

    const minStepSeconds = MIN_WEBP_FRAME_DURATION_MS / 1000;
    const stepSeconds = Math.max(minStepSeconds, safeDurationSeconds / frameCount);

    return Array.from({ length: frameCount }, (_, index) => index * stepSeconds);
  }

  private buildUniformWebPDurations(params: {
    frameCount: number;
    totalDurationMs: number;
  }): number[] {
    const { frameCount, totalDurationMs } = params;

    if (frameCount <= 0) {
      return [];
    }

    const safeTotalMs = Math.max(0, Math.round(totalDurationMs));
    const minTotalMs = frameCount * MIN_WEBP_FRAME_DURATION_MS;
    const clampedTotalMs = Math.max(minTotalMs, safeTotalMs);

    const base = Math.floor(clampedTotalMs / frameCount);
    const remainder = clampedTotalMs - base * frameCount;

    const durations = Array.from({ length: frameCount }, (_, index) =>
      Math.min(
        MAX_WEBP_DURATION_24BIT,
        Math.max(MIN_WEBP_FRAME_DURATION_MS, base + (index < remainder ? 1 : 0))
      )
    );

    return durations;
  }

  private normalizeWebPDurationsToTotal(params: {
    durations: number[];
    targetTotalMs: number;
  }): number[] {
    const { durations, targetTotalMs } = params;

    if (!durations.length) {
      return durations;
    }

    const target = Math.max(0, Math.round(targetTotalMs));
    const normalized = durations.map((duration) =>
      Math.min(MAX_WEBP_DURATION_24BIT, Math.max(MIN_WEBP_FRAME_DURATION_MS, Math.round(duration)))
    );

    let currentTotal = normalized.reduce((sum, value) => sum + value, 0);
    let diff = target - currentTotal;

    // Usually diff is small (rounding error). Adjust by 1ms steps without violating bounds.
    // Cap work to prevent pathological loops.
    const maxIterations = normalized.length * 4 + Math.min(10_000, Math.abs(diff));
    let iterations = 0;

    while (diff !== 0 && iterations < maxIterations) {
      iterations += 1;
      const direction = diff > 0 ? 1 : -1;

      // Spread adjustments across frames to avoid clustering error into a single frame.
      let adjusted = false;
      for (let i = 0; i < normalized.length && diff !== 0; i += 1) {
        const next = normalized[i]! + direction;
        if (next < MIN_WEBP_FRAME_DURATION_MS || next > MAX_WEBP_DURATION_24BIT) {
          continue;
        }
        normalized[i] = next;
        diff -= direction;
        adjusted = true;
      }

      if (!adjusted) {
        break;
      }
    }

    currentTotal = normalized.reduce((sum, value) => sum + value, 0);
    if (currentTotal !== target) {
      logger.warn('conversion', 'Failed to perfectly align WebP durations to target total', {
        targetTotalMs: target,
        currentTotalMs: currentTotal,
        frameCount: normalized.length,
      });
    }

    return normalized;
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
          ? await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/webp', quality })
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

    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(blob);
        bitmap.close();
      } catch (error) {
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
    sourceFPS?: number,
    codec?: string,
    durationSeconds?: number
  ): number[] {
    const defaultDuration = Math.max(
      MIN_WEBP_FRAME_DURATION_MS,
      Math.round(1000 / Math.max(1, fps))
    );
    const targetTotalDurationMs =
      durationSeconds && durationSeconds > 0
        ? Math.max(frameCount * MIN_WEBP_FRAME_DURATION_MS, Math.round(durationSeconds * 1000))
        : null;

    if (frameCount <= 1 || timestamps.length <= 1) {
      if (targetTotalDurationMs) {
        return this.buildUniformWebPDurations({
          frameCount: Math.max(1, frameCount),
          totalDurationMs: targetTotalDurationMs,
        });
      }

      const fallbackDuration = Math.min(
        MAX_WEBP_DURATION_24BIT,
        Math.max(MIN_WEBP_FRAME_DURATION_MS, defaultDuration)
      );
      return Array.from({ length: Math.max(1, frameCount) }, () => fallbackDuration);
    }

    // Validate sourceFPS before using it
    const hasValidSourceFPS =
      sourceFPS && Number.isFinite(sourceFPS) && sourceFPS > 0 && sourceFPS <= 120; // Sanity check: reject unrealistic FPS values

    if (!hasValidSourceFPS && sourceFPS) {
      logger.warn('conversion', 'Invalid source FPS detected, using variable durations', {
        sourceFPS,
        reason: sourceFPS <= 0 ? 'non-positive' : sourceFPS > 120 ? 'unrealistic' : 'non-finite',
      });
    }

    // Force uniform durations for complex codecs to prevent stuttering
    // Complex codecs (AV1, VP9, HEVC) often have irregular frame capture timing
    // which causes jerky playback when using variable durations
    const isComplexCodecSource = isComplexCodec(codec);

    // Detect if significant FPS downsampling occurred or if complex codec requires uniform timing
    const useUniformDurations =
      isComplexCodecSource || (hasValidSourceFPS && sourceFPS / fps > FPS_DOWNSAMPLING_THRESHOLD);

    let durations: number[] = [];

    if (useUniformDurations) {
      const uniformDuration = targetTotalDurationMs
        ? null
        : Math.min(MAX_WEBP_DURATION_24BIT, Math.max(MIN_WEBP_FRAME_DURATION_MS, defaultDuration));

      // UNIFORM MODE: Use fixed duration to avoid stutter
      logger.info('conversion', 'Using uniform frame durations to prevent downsampling stutter', {
        sourceFPS: sourceFPS ?? 'unknown',
        targetFPS: fps,
        ratio: sourceFPS ? (sourceFPS / fps).toFixed(2) : 'N/A',
        duration: uniformDuration ?? 'duration-aligned',
        frameCount,
        isComplexCodec: isComplexCodecSource,
        codec: codec ?? 'unknown',
      });
      durations = targetTotalDurationMs
        ? this.buildUniformWebPDurations({ frameCount, totalDurationMs: targetTotalDurationMs })
        : Array.from({ length: frameCount }, () => uniformDuration ?? defaultDuration);
    } else {
      // VARIABLE MODE: Use timestamp deltas for VFR or near-matching FPS
      logger.info('conversion', 'Using variable frame durations based on timestamps', {
        sourceFPS: sourceFPS ?? 'unknown',
        targetFPS: fps,
        ratio: sourceFPS ? (sourceFPS / fps).toFixed(2) : 'N/A',
        frameCount,
      });

      for (let i = 0; i < frameCount; i += 1) {
        const currentTimestamp: number =
          typeof timestamps[i] === 'number' && Number.isFinite(timestamps[i])
            ? (timestamps[i] as number)
            : i > 0 && typeof timestamps[i - 1] === 'number'
              ? (timestamps[i - 1] as number)
              : 0;
        const nextTimestamp = timestamps[i + 1];
        if (typeof nextTimestamp === 'number' && Number.isFinite(nextTimestamp)) {
          const deltaMs = Math.max(
            MIN_WEBP_FRAME_DURATION_MS,
            Math.round((nextTimestamp - currentTimestamp) * 1000)
          );
          durations.push(Math.min(MAX_WEBP_DURATION_24BIT, deltaMs));
        } else {
          durations.push(defaultDuration);
        }
      }
    }

    // Ensure the last frame has a duration
    if (durations.length < frameCount) {
      durations.push(
        targetTotalDurationMs ? Math.round(targetTotalDurationMs / frameCount) : defaultDuration
      );
    }

    // Align total duration to the target duration when provided to prevent perceived speed changes
    if (targetTotalDurationMs) {
      const currentTotalMs = durations.reduce((sum, value) => sum + value, 0);
      if (currentTotalMs > 0 && currentTotalMs !== targetTotalDurationMs) {
        const scale = targetTotalDurationMs / currentTotalMs;
        const scaled = durations.map((duration) =>
          Math.min(
            MAX_WEBP_DURATION_24BIT,
            Math.max(MIN_WEBP_FRAME_DURATION_MS, Math.round(duration * scale))
          )
        );
        durations = this.normalizeWebPDurationsToTotal({
          durations: scaled,
          targetTotalMs: targetTotalDurationMs,
        });
      }
    }

    return durations.slice(0, frameCount);
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
      hasAlpha: true,
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
   * Extracts PNG frames directly from complex codecs (AV1, VP9, HEVC)
   * without H.264 intermediate transcoding. Uses FFmpeg for final encoding.
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
    } = params;
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

    const frameFiles: string[] = [];
    // Collect frames by index to avoid duplicate names inflating the final frameCount.
    // A duplicated name (e.g. frame_000005.png twice) can make frameFiles.length > actual
    // sequence length, which then causes validateFrameSequence() to look for a non-existent
    // last frame and fail with an FS error.
    const framesByIndex: Array<{ name: string; data: Uint8Array } | undefined> = [];
    const maxFrames = this.getMaxWebPFrames(targetFps, metadata?.duration);

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

      // Direct WebCodecs → PNG pipeline for complex codecs
      // Use FFmpeg frame-sequence encoding for stable WebP output
      const startTime = Date.now();

      const frameFormat = 'png';

      const runDecode = async (
        captureMode: WebCodecsCaptureMode,
        overrideTargetFps: number = targetFps
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
          onFrame: async (frame) => {
            // Collect frames for batch VFS write (3-5x faster than sequential)
            if (frame.data && frame.data.byteLength > 0) {
              // Validate frame data before queuing
              if (frame.data.byteLength < 100) {
                logger.warn(
                  'conversion',
                  `Suspicious small frame from WebCodecs: ${frame.name} (${frame.data.byteLength} bytes)`,
                  {
                    byteLength: frame.data.byteLength,
                  }
                );
              }
              framesByIndex[frame.index] = { name: frame.name, data: frame.data };
            } else {
              logger.error('conversion', `Rejected 0-byte frame from WebCodecs: ${frame.name}`, {
                hasData: !!frame.data,
                byteLength: frame.data?.byteLength ?? 0,
              });
            }
          },
          onProgress: reportDecodeProgress,
          shouldCancel: () => ffmpegService.isCancellationRequested(),
        });
      };

      // For AV1, skip track-based auto mode when rVFC is available.
      // TrackProcessor capture can severely under-capture on some browsers for AV1,
      // costing a full playback duration before we fall back to seek.
      const initialCaptureMode: WebCodecsCaptureMode = shouldSkipAv1FrameCallbackProbe
        ? 'seek'
        : isAv1 && supportsFrameCallback
          ? 'frame-callback'
          : 'auto';

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
          ? Math.min(targetFps, getAv1SeekFpsCap(metadata?.duration))
          : targetFps;

      let decodeResult = await runDecode(initialCaptureMode, initialSeekTargetFps);

      // If auto capture under-extracts frames compared to duration-based target,
      // retry with deterministic seek capture to ensure enough images for smooth motion.
      const expectedFramesFromDuration = Math.min(
        maxFrames,
        Math.max(1, Math.ceil(Math.max(0, decodeResult.duration) * Math.max(1, targetFps)))
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
          `WebCodecs initial capture under-extracted frames; retrying with fallback capture modes (captured=${decodeResult.frameCount}, expected≈${expectedFramesFromDuration}, required>=${requiredFrames}, initial=${initialCaptureMode}, used=${decodeResult.captureModeUsed ?? 'unknown'})`,
          {
            codec: metadata?.codec ?? 'unknown',
            capturedFrames: decodeResult.frameCount,
            expectedFramesFromDuration,
            requiredFrames,
            targetFps,
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
                targetFps,
                durationSeconds: decodeResult.duration,
                maxFrames,
                scale,
                frameFormat,
              }
            );

            decodeResult = await runDecode('frame-callback');
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
        const retryExpectedFramesFromDuration = Math.min(
          maxFrames,
          Math.max(1, Math.ceil(Math.max(0, decodeResult.duration) * Math.max(1, targetFps)))
        );
        const retryRequiredFrames = Math.max(1, retryExpectedFramesFromDuration - 1);

        if (decodeResult.frameCount < retryRequiredFrames) {
          // Clear any partial results before the final retry.
          framesByIndex.length = 0;
          // Seek capture for AV1 can be extremely slow (often ~1s/frame on some devices).
          // To reduce total conversion time while preserving correct playback duration
          // (via duration-aligned timestamps), cap seek sampling FPS more aggressively
          // for longer clips. For medium/low quality we prefer speed over maximum smoothness.
          const av1SeekFpsCap = getAv1SeekFpsCap(decodeResult.duration);
          const seekTargetFps = isAv1 ? Math.min(targetFps, av1SeekFpsCap) : targetFps;

          if (seekTargetFps !== targetFps) {
            logger.info('conversion', 'Capping FPS for seek fallback to reduce conversion time', {
              codec: metadata?.codec ?? 'unknown',
              requestedFps: targetFps,
              seekFps: seekTargetFps,
              seekFpsCap: isAv1 ? av1SeekFpsCap : null,
              durationSeconds: decodeResult.duration,
              reason: 'seek fallback for WebCodecs-only codec',
            });
          }

          decodeResult = await runDecode('seek', seekTargetFps);
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

      // Batch write frames to VFS in parallel for 3-5x speedup
      const orderedFrames = framesByIndex.filter(
        (frame): frame is { name: string; data: Uint8Array } => Boolean(frame)
      );

      if (orderedFrames.length > 0) {
        const WRITE_BATCH_SIZE = 50; // Write 50 frames per batch
        logger.info('conversion', 'Batch writing frames to VFS', {
          totalFrames: orderedFrames.length,
          batchSize: WRITE_BATCH_SIZE,
        });

        for (let i = 0; i < orderedFrames.length; i += WRITE_BATCH_SIZE) {
          const batch = orderedFrames.slice(
            i,
            Math.min(i + WRITE_BATCH_SIZE, orderedFrames.length)
          );

          // Write batch in parallel
          await Promise.all(
            batch.map(async (frame) => {
              await ffmpegService.writeVirtualFile(frame.name, frame.data);
              frameFiles.push(frame.name);
            })
          );
        }

        logger.info('conversion', 'VFS write complete', {
          framesWritten: frameFiles.length,
        });
      }

      const elapsed = Date.now() - startTime;
      const estimatedFramesFromCapturedDuration = Math.max(
        1,
        Math.ceil(Math.max(0, decodeResult.duration) * Math.max(1, decodeResult.fps))
      );

      logger.info(
        'conversion',
        `Frame extraction complete: frameCount=${decodeResult.frameCount}, durationSeconds=${decodeResult.duration.toFixed(3)}, targetFps=${targetFps}, maxFramesRequested=${maxFrames}, queuedFrames=${orderedFrames.length}, writtenFrames=${frameFiles.length}`,
        {
          frameCount: decodeResult.frameCount,
          duration: decodeResult.duration,
          elapsed: `${elapsed}ms`,
          format,
          capturedFramesCount: capturedFrames?.length ?? 0,
          targetFps,
          decodeFps: decodeResult.fps,
          maxFramesRequested: maxFrames,
          estimatedFramesFromDuration: estimatedFramesFromCapturedDuration,
          queuedFrames: orderedFrames.length,
          writtenFrames: frameFiles.length,
        }
      );

      ffmpegService.reportStatus(`Converting frames to ${format.toUpperCase()}...`);
      const animationDurationSeconds = this.resolveAnimationDurationSeconds(
        frameFiles.length,
        targetFps,
        metadata,
        decodeResult.duration
      );

      const fpsForEncoding = this.resolveWebPFps(
        frameFiles.length,
        targetFps,
        animationDurationSeconds
      );

      if (fpsForEncoding !== targetFps) {
        logger.info('conversion', 'Adjusted WebP FPS to match captured pacing', {
          targetFps,
          adjustedFps: fpsForEncoding,
          frameCount: frameFiles.length,
          durationSeconds: animationDurationSeconds ?? decodeResult.duration,
        });
      }

      // Complex codecs (AV1/VP9/HEVC) are especially prone to timestamp jitter when
      // downsampling via WebCodecs capture. To ensure the resulting WebP animation
      // moves smoothly and matches the intended playback duration, we build a
      // stable, duration-aligned timestamp series for encoding.
      const timestampsForEncoding = this.buildDurationAlignedTimestamps({
        frameCount: frameFiles.length,
        durationSeconds: animationDurationSeconds ?? decodeResult.duration,
        fallbackFps: fpsForEncoding,
      });

      logger.info('conversion', 'Using duration-aligned timestamps for complex codec WebP', {
        codec: metadata?.codec ?? 'unknown',
        frameCount: frameFiles.length,
        durationSeconds: (animationDurationSeconds ?? decodeResult.duration).toFixed(3),
      });

      const outputBlob = await ffmpegService.encodeFrameSequence({
        format: 'webp', // format is guaranteed to be 'webp' here after GIF check
        options,
        frameCount: frameFiles.length,
        fps: fpsForEncoding,
        durationSeconds: animationDurationSeconds ?? decodeResult.duration,
        frameFiles,
        frameTimestamps: timestampsForEncoding,
      });

      const outputBlobWithMetadata = outputBlob as ConversionOutputBlob;
      if (!outputBlobWithMetadata.wasTranscoded) {
        outputBlobWithMetadata.wasTranscoded = true;
      }

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

      // Clean up temporary frame files
      if (frameFiles.length > 0) {
        try {
          await ffmpegService.deleteVirtualFiles(frameFiles);
        } catch (cleanupError) {
          logger.warn('conversion', 'Failed to clean up frame files', {
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }

      // Log detailed error information for debugging
      const errorStack = error instanceof Error ? error.stack : 'No stack trace';
      const detailedError = {
        error: errorMessage,
        codec: metadata?.codec,
        format,
        framesWritten: frameFiles.length,
        stack: errorStack?.substring(0, 500), // Truncate stack for readability
      };
      logger.error('conversion', 'WebCodecs direct path failed', detailedError);
      // Also log to console for debugging in browser dev tools
      if (typeof console !== 'undefined' && console.error) {
        console.error('[WebCodecs direct] Error:', errorMessage);
        if (errorStack) {
          console.error('[WebCodecs direct] Stack:', errorStack.substring(0, 500));
        }
      }
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
    metadata?: VideoMetadata
  ): Promise<ConversionOutputBlob> {
    const { quality, scale } = options;
    const settings =
      format === 'gif' ? QUALITY_PRESETS.gif[quality] : QUALITY_PRESETS.webp[quality];
    const useModernGif = format === 'gif' && ModernGifService.isSupported();

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

    const decoder = new WebCodecsDecoderService();
    const frameFiles: string[] = [];
    const capturedFrames: ImageData[] = [];
    const webpCapturedFrames: ImageData[] = []; // Collect WebP frames for batch encoding
    const webpEncodedFrames: Uint8Array[] = [];
    const webpFrameTimestamps: number[] = [];
    const webpQualityRatio = format === 'webp' ? QUALITY_PRESETS.webp[quality].quality / 100 : null;
    let lastValidEncodedFrame: Uint8Array | null = null;

    // Determine if we need RGBA frames (for modern-gif or static WebP)
    const needsRGBA = useModernGif || format === 'webp';
    const frameFormat: WebCodecsFrameFormat = needsRGBA
      ? 'rgba'
      : FFMPEG_INTERNALS.WEBCODECS.FRAME_FORMAT;

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

    // Determine if FFmpeg is needed for initial frame handling
    const needsFFmpeg = format === 'gif' && !useModernGif;

    const decodeStart = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.DECODE_START;
    const decodeEnd = FFMPEG_INTERNALS.PROGRESS.WEBCODECS.DECODE_END;
    const reportDecodeProgress = (current: number, total: number) => {
      const progress = decodeStart + ((decodeEnd - decodeStart) * current) / Math.max(1, total);
      ffmpegService.reportProgress(Math.round(progress));
    };

    ffmpegService.beginExternalConversion(metadata, quality);

    let externalEnded = false;
    const endConversion = () => {
      if (externalEnded) {
        return;
      }
      ffmpegService.endExternalConversion();
      externalEnded = true;
    };

    // PRIORITY: Use direct WebCodecs path for complex codecs (AV1, VP9, HEVC)
    // This extracts PNG frames directly without H.264 intermediate transcoding
    try {
      if (this.shouldUseWebCodecsPath(metadata)) {
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
          });

          if (webCodecsResult) {
            endConversion();
            return webCodecsResult;
          }

          // If WebCodecs path fails, fall through to direct FFmpeg path
          logger.warn('conversion', 'WebCodecs direct path failed, trying FFmpeg fallback', {
            codec: metadata?.codec,
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

          logger.warn('conversion', 'H.264 intermediate path error, trying direct WebCodecs', {
            error: errorMessage,
            codec: metadata?.codec,
          });
        }
      }

      if (needsFFmpeg && !ffmpegService.isLoaded()) {
        logger.warn('conversion', 'FFmpeg not initialized, reinitializing...');
        await ffmpegService.initialize();
      }

      ffmpegService.reportStatus('Decoding with WebCodecs...');
      ffmpegService.reportProgress(decodeStart);

      const captureModes: WebCodecsCaptureMode[] = ['auto', 'seek'];
      let captureModeUsed: WebCodecsCaptureMode | null = null;
      let decodeResult: Awaited<ReturnType<WebCodecsDecoderService['decodeToFrames']>> | null =
        null;

      for (const captureMode of captureModes) {
        try {
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
            shouldCancel: () => ffmpegService.isCancellationRequested(),
            onProgress: reportDecodeProgress,
            onFrame: async (frame) => {
              if (format === 'webp') {
                if (!frame.imageData) {
                  throw new Error('WebCodecs did not provide raw frame data.');
                }
                // Collect frames for batch encoding (parallelized later)
                webpCapturedFrames.push(frame.imageData);
                webpFrameTimestamps.push(frame.timestamp);
                return;
              }

              if (useModernGif) {
                if (!frame.imageData) {
                  throw new Error('WebCodecs did not provide raw frame data.');
                }
                capturedFrames.push(frame.imageData);
                return;
              }

              // Validate frame data exists and is not empty
              if (!frame.data || frame.data.byteLength === 0) {
                if (!lastValidEncodedFrame) {
                  logger.error('conversion', 'WebCodecs produced empty frame with no fallback', {
                    frameName: frame.name,
                    frameIndex: frame.index,
                  });
                  throw new Error(
                    'WebCodecs produced empty frame data at the start of the sequence. ' +
                      'This indicates codec incompatibility. Falling back to FFmpeg.'
                  );
                }

                // Reuse the last valid encoded frame to avoid writing 0-byte frames
                const reusedFrame = new Uint8Array(lastValidEncodedFrame);
                logger.warn(
                  'conversion',
                  'WebCodecs produced empty frame data, reusing last frame',
                  {
                    frameName: frame.name,
                    frameIndex: frame.index,
                    dataSize: frame.data?.byteLength ?? 0,
                  }
                );
                await ffmpegService.writeVirtualFile(frame.name, reusedFrame);
                frameFiles.push(frame.name);
                return;
              }

              const encodedFrame = new Uint8Array(frame.data);
              lastValidEncodedFrame = encodedFrame;
              await ffmpegService.writeVirtualFile(frame.name, encodedFrame);
              frameFiles.push(frame.name);
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
          if (frameFiles.length > 0) {
            await ffmpegService.deleteVirtualFiles(frameFiles);
            frameFiles.length = 0;
          }
          capturedFrames.length = 0;

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
        frameFilesCount: frameFiles.length,
        webpEncodedFrames: webpEncodedFrames.length,
      });

      ffmpegService.reportProgress(decodeEnd);
      ffmpegService.reportStatus(`Encoding ${format.toUpperCase()}...`);

      const reportEncodeProgress = (current: number, total: number) => {
        const progress =
          FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START +
          ((FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_END -
            FFMPEG_INTERNALS.PROGRESS.WEBCODECS.ENCODE_START) *
            current) /
            Math.max(1, total);
        ffmpegService.reportProgress(Math.round(progress));
      };

      const encodeWithFFmpegFallback = async (errorMessage: string): Promise<Blob> => {
        // H.264 intermediate path already attempted at the start of convert()
        // Skip redundant retry and go directly to FFmpeg frame re-extraction
        logger.warn('conversion', 'WebCodecs encoder failed, retrying with FFmpeg frames', {
          error: errorMessage,
        });

        if (!ffmpegService.isLoaded()) {
          await ffmpegService.initialize();
        }

        if (frameFiles.length > 0) {
          await ffmpegService.deleteVirtualFiles(frameFiles);
          frameFiles.length = 0;
        }

        capturedFrames.length = 0;

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
            shouldCancel: () => ffmpegService.isCancellationRequested(),
            onProgress: reportDecodeProgress,
            onFrame: async (frame) => {
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

          outputBlob = await this.gifWorkerPool.execute(async (worker) => {
            return await worker.encode(serializableFrames, {
              width: decodeResult.width,
              height: decodeResult.height,
              fps: targetFps,
              quality,
              onProgress: reportEncodeProgress,
              shouldCancel: () => ffmpegService.isCancellationRequested(),
            });
          });
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          logger.warn('conversion', 'GIF worker encoding failed, retrying on main thread', {
            error: errorMessage,
          });
          try {
            outputBlob = await ModernGifService.encode(capturedFrames, {
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
          outputBlob = await ModernGifService.encode(capturedFrames, {
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
        logger.info('conversion', 'Using WebP muxer path with parallel frame encoding');

        // Batch encode WebP frames in parallel for 3-4x speedup
        if (webpCapturedFrames.length > 0 && webpQualityRatio !== null) {
          // Dynamic chunk size based on CPU cores for better parallelization
          const hwConcurrency = navigator.hardwareConcurrency || 4;
          const CHUNK_SIZE = Math.min(20, Math.max(10, hwConcurrency * 2));
          const totalFrames = webpCapturedFrames.length;

          logger.info('conversion', 'Parallel WebP frame encoding', {
            totalFrames,
            chunkSize: CHUNK_SIZE,
            estimatedBatches: Math.ceil(totalFrames / CHUNK_SIZE),
          });

          // Create encoder function for parallel execution
          const encodeFrame = this.createWebPFrameEncoder(webpQualityRatio);

          // Process frames in batches
          for (let i = 0; i < totalFrames; i += CHUNK_SIZE) {
            const chunk = webpCapturedFrames.slice(i, Math.min(i + CHUNK_SIZE, totalFrames));

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
          logger.info('conversion', 'Adjusted WebP animation duration to align with frame budget', {
            metadataDuration: metadata.duration,
            resolvedDuration: animationDurationSeconds,
            frameCount: webpEncodedFrames.length,
            fps: targetFps,
          });
        }

        const muxedWebP = await (async (): Promise<Blob | null> => {
          try {
            const result = await this.muxWebPFrames({
              encodedFrames: webpEncodedFrames,
              timestamps: webpFrameTimestamps,
              width: decodeResult.width,
              height: decodeResult.height,
              fps: targetFps,
              metadata,
              durationSeconds: animationDurationSeconds,
              onProgress: reportEncodeProgress,
              shouldCancel: () => ffmpegService.isCancellationRequested(),
            });

            if (!result) {
              fallbackReason = 'WebP muxer produced no output';
              logger.warn('conversion', 'WebP muxer produced no output, using FFmpeg fallback', {
                frameCount: decodeResult.frameCount,
              });
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
      // Fallback to FFmpeg for animated WebP or unsupported formats
      else
        logger.info('conversion', 'Using FFmpeg frame sequence encoding', {
          format,
          frameFilesCount: frameFiles.length,
          capturedFramesCount: capturedFrames.length,
          hasFirstCapturedFrame: !!capturedFrames[0],
        });
      outputBlob = await ffmpegService.encodeFrameSequence({
        format: format as 'gif' | 'webp',
        options,
        frameCount: decodeResult.frameCount,
        fps: targetFps,
        durationSeconds: metadata?.duration ?? decodeResult.duration,
        frameFiles,
      });

      const completionProgress =
        format === 'gif'
          ? FFMPEG_INTERNALS.PROGRESS.GIF.COMPLETE
          : FFMPEG_INTERNALS.PROGRESS.WEBP.COMPLETE;
      ffmpegService.reportProgress(completionProgress);

      // Cleanup captured frames for non-FFmpeg encoders
      if (capturedFrames.length > 0 && (useModernGif || format === 'webp')) {
        capturedFrames.length = 0;
      }

      return outputBlob;
    } catch (error) {
      if (frameFiles.length > 0) {
        await ffmpegService.deleteVirtualFiles(frameFiles);
      }
      throw error;
    } finally {
      endConversion();
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
