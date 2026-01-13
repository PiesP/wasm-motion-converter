// Internal dependencies

// Type imports
import type { VideoMetadata } from '@t/conversion-types';
import { getErrorMessage } from '@utils/error-utils';
import { FFMPEG_INTERNALS } from '@utils/ffmpeg-constants';
import { logger } from '@utils/logger';

import { captureWithDemuxer as captureWithDemuxerMode } from '@services/webcodecs/decoder/demuxer-capture';
import { captureWithFrameCallback as captureWithFrameCallbackMode } from '@services/webcodecs/decoder/capture-modes/frame-callback-capture';
import { captureWithSeeking as captureWithSeekingMode } from '@services/webcodecs/decoder/capture-modes/seek-capture';
import { captureWithTrackProcessor as captureWithTrackProcessorMode } from '@services/webcodecs/decoder/capture-modes/track-processor-capture';
import { canvasToBlob, createCanvas } from '@services/webcodecs/decoder/canvas';
import { formatFrameName } from '@services/webcodecs/decoder/frame-naming';
import { waitForEvent } from '@services/webcodecs/decoder/wait-for-event';
import { canUseDemuxer, detectContainer } from '@services/webcodecs/demuxer/demuxer-factory';
import type {
  WebCodecsCaptureMode,
  WebCodecsDecodeOptions,
  WebCodecsDecodeResult,
} from '@services/webcodecs/decoder/types';
import {
  getWebCodecsSupportStatus,
  isWebCodecsCodecSupported,
  isWebCodecsDecodeSupported,
} from './webcodecs-support-service';

export type {
  WebCodecsCaptureMode,
  WebCodecsDecodeOptions,
  WebCodecsDecodeResult,
  WebCodecsFrameFormat,
  WebCodecsFramePayload,
  WebCodecsProgressCallback,
} from '@services/webcodecs/decoder/types';

/**
 * Maximum time (ms) allowed for canvas.convertToBlob() operation
 * VP9/complex codecs may stall during GPU->CPU readback; timeout forces fallback to FFmpeg
 */
const CANVAS_ENCODE_TIMEOUT_MS = 5000;

/**
 * Maximum consecutive empty frames before failing
 * Reduced from 3 to 2 for faster AV1 codec fallback detection
 */
const MAX_CONSECUTIVE_EMPTY_FRAMES = 2;

/**
 * Normalize video duration
 *
 * Ensures duration is a finite number, returns 0 for invalid values.
 *
 * @param duration - Raw duration value
 * @returns Normalized duration (0 if not finite)
 */
const normalizeDuration = (duration: number): number => (Number.isFinite(duration) ? duration : 0);

/**
 * WebCodecs Decoder Service
 *
 * Provides GPU-accelerated video frame extraction using WebCodecs API.
 * Supports multiple capture modes with automatic fallback:
 * - Track processor (fastest, experimental)
 * - Frame callback (Chrome/Edge, recommended)
 * - Manual seeking (universal fallback)
 *
 * Features:
 * - Hardware-accelerated video decoding
 * - Multiple output formats (PNG, JPEG, RGBA)
 * - Automatic codec compatibility detection
 * - Empty frame detection with fast AV1 fallback
 * - Cancellation support
 * - Progress reporting
 *
 * @see webcodecs-conversion-service.ts for usage examples
 */
export class WebCodecsDecoderService {
  private activeUrls = new Set<string>();

  /**
   * Check if WebCodecs decoding is supported
   *
   * Validates browser support for required APIs:
   * - HTMLVideoElement, HTMLCanvasElement
   * - WebCodecs VideoDecoder API
   *
   * @returns True if WebCodecs decoding is available
   */
  static isSupported(): boolean {
    return (
      typeof document !== 'undefined' &&
      typeof HTMLVideoElement !== 'undefined' &&
      typeof HTMLCanvasElement !== 'undefined' &&
      isWebCodecsDecodeSupported()
    );
  }

  /**
   * Check if specific codec is supported
   *
   * Tests codec support using VideoDecoder.isConfigSupported().
   *
   * @param codec - Video codec string (e.g., 'avc1', 'vp09', 'av01')
   * @param fileType - MIME type of video file
   * @param metadata - Optional video metadata
   * @returns Promise that resolves to true if codec is supported
   */
  static async isCodecSupported(
    codec: string,
    fileType: string,
    metadata?: VideoMetadata
  ): Promise<boolean> {
    return isWebCodecsCodecSupported(codec, fileType, metadata);
  }

  /**
   * Decode video to frames
   *
   * Main entry point for WebCodecs frame extraction.
   * Automatically selects best capture mode and handles fallbacks.
   *
   * @param options - Decode options with file, fps, scale, format, callbacks
   * @returns Promise with decode result (frame files, count, dimensions, fps, duration)
   * @throws Error if WebCodecs not supported or decode fails
   *
   * @example
   * ```typescript
   * const decoder = new WebCodecsDecoderService();
   * const result = await decoder.decodeToFrames({
   *   file: videoFile,
   *   targetFps: 15,
   *   scale: 1.0,
   *   frameFormat: 'png',
   *   frameQuality: 0.95,
   *   framePrefix: 'frame_',
   *   frameDigits: 6,
   *   frameStartNumber: 0,
   *   captureMode: 'auto',
   *   onFrame: async (frame) => { },
   *   onProgress: (current, total) => { }
   * });
   * ```
   */
  async decodeToFrames(options: WebCodecsDecodeOptions): Promise<WebCodecsDecodeResult> {
    if (!WebCodecsDecoderService.isSupported()) {
      throw new Error('WebCodecs decode path is not supported in this browser.');
    }

    const {
      file,
      targetFps,
      scale,
      frameFormat,
      frameQuality,
      framePrefix,
      frameDigits,
      frameStartNumber,
      maxFrames,
      captureMode = 'auto',
      codec,
      quality,
      onFrame,
      onProgress,
      shouldCancel,
    } = options;

    // Some demuxer eligibility checks benefit from having a codec value available.
    // We pass a minimal metadata object so canUseDemuxer() can log and filter more accurately.
    const demuxerMetadata: VideoMetadata | undefined = codec
      ? {
          width: 0,
          height: 0,
          duration: 0,
          codec,
          framerate: 0,
          bitrate: 0,
        }
      : undefined;

    // Priority 1: Try demuxer path first (eliminates seeking overhead for AV1/HEVC/VP9)
    // Only attempt if captureMode is 'auto' or explicitly 'demuxer'
    if (captureMode === 'demuxer' && !canUseDemuxer(file, demuxerMetadata)) {
      throw new Error('Demuxer capture mode requested but is not available for this file.');
    }

    if (
      (captureMode === 'auto' || captureMode === 'demuxer') &&
      canUseDemuxer(file, demuxerMetadata)
    ) {
      try {
        logger.info('conversion', 'Attempting demuxer-based frame capture', {
          fileName: file.name,
          container: detectContainer(file),
          codec: codec ?? 'unknown',
        });

        const demuxerResult = await captureWithDemuxerMode(
          file,
          targetFps,
          scale,
          frameFormat,
          frameQuality,
          framePrefix,
          frameDigits,
          frameStartNumber,
          maxFrames,
          quality,
          onFrame,
          onProgress,
          shouldCancel,
          demuxerMetadata
        );

        if (demuxerResult) {
          logger.info('conversion', 'Demuxer capture completed successfully', {
            frameCount: demuxerResult.frameCount,
            duration: demuxerResult.duration,
          });
          return demuxerResult;
        }
      } catch (error) {
        logger.warn('conversion', 'Demuxer path failed, falling back to playback modes', {
          error: getErrorMessage(error),
          codec: codec ?? 'unknown',
        });

        // If the caller explicitly requested demuxer mode, do not silently fall back.
        // This lets higher-level routing choose the next best strategy deterministically.
        if (captureMode === 'demuxer') {
          throw error;
        }
        // Fall through to HTMLVideoElement-based capture modes
      }
    }

    // Priority 2-4: HTMLVideoElement-based capture modes (existing logic)
    const url = URL.createObjectURL(file);
    this.activeUrls.add(url);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = url;

    // IMPORTANT: Keep the video attached to the DOM to reduce throttling.
    // Some browsers aggressively throttle decode / frame callbacks for off-DOM
    // or non-rendered media elements, which can cause severe under-capture.
    // We hide the element off-screen instead of using display:none.
    this.attachVideoForDecode(video);

    try {
      await waitForEvent(video, 'loadedmetadata', FFMPEG_INTERNALS.WEBCODECS.METADATA_TIMEOUT_MS);
      const duration = normalizeDuration(video.duration);
      const sourceWidth = video.videoWidth || 0;
      const sourceHeight = video.videoHeight || 0;

      if (!sourceWidth || !sourceHeight || !duration) {
        throw new Error('Video metadata not available for hardware decode.');
      }

      if (video.readyState < 2) {
        await waitForEvent(video, 'loadeddata', FFMPEG_INTERNALS.WEBCODECS.METADATA_TIMEOUT_MS);
      }

      // VP9/HEVC codec workaround: Automatic scale reduction
      // VP9/complex codecs can cause GPU memory pressure & stalls during canvas encoding.
      // Reduce canvas size by 25% (0.75 scale) to alleviate GPU memory bottlenecks.
      const isComplexCodec = codec && /vp9|hevc|h\.265|h265|hvc1|hev1/i.test(codec);
      const effectiveScale = isComplexCodec && scale >= 0.9 ? scale * 0.75 : scale;

      const targetWidth = Math.max(1, Math.round(sourceWidth * effectiveScale));
      const targetHeight = Math.max(1, Math.round(sourceHeight * effectiveScale));
      const captureContext = createCanvas(targetWidth, targetHeight, frameFormat === 'rgba');

      if (isComplexCodec && effectiveScale !== scale) {
        logger.info('conversion', 'Applied VP9/HEVC codec scale reduction', {
          originalScale: scale,
          effectiveScale,
          targetWidth,
          targetHeight,
          codec,
        });
      }
      const frameFiles: string[] = [];
      const estimatedTotalFrames = Math.max(1, Math.ceil(duration * targetFps));
      const totalFrames =
        maxFrames && maxFrames > 0
          ? Math.max(1, Math.min(maxFrames, estimatedTotalFrames))
          : estimatedTotalFrames;

      // Total decode timeout: seeking can legitimately take longer because it performs
      // many discrete seeks (one per frame). Keep fail-fast behavior for realtime modes.
      const computeMaxTotalDecodeMs = (mode: WebCodecsCaptureMode): number => {
        if (mode !== 'seek') {
          return FFMPEG_INTERNALS.WEBCODECS.MAX_TOTAL_DECODE_MS;
        }

        // Conservative per-frame budget for seek-based capture.
        // Example: 115 frames → ~230s budget (2s/frame), capped to 240s.
        const perFrameBudgetMs = 2000;
        const estimatedMs = totalFrames * perFrameBudgetMs;
        const upperBoundMs = 240_000;
        return Math.min(
          upperBoundMs,
          Math.max(FFMPEG_INTERNALS.WEBCODECS.MAX_TOTAL_DECODE_MS, estimatedMs)
        );
      };

      let effectiveCaptureMode: WebCodecsCaptureMode = captureMode;
      let maxTotalDecodeMs = computeMaxTotalDecodeMs(effectiveCaptureMode);

      logger.info(
        'conversion',
        `WebCodecs decode budget: durationSeconds=${duration.toFixed(
          3
        )}, targetFps=${targetFps}, estimatedTotalFrames=${estimatedTotalFrames}, maxFrames=${
          maxFrames ?? 'null'
        }, totalFrames=${totalFrames}, scale=${scale}, frameFormat=${frameFormat}, captureMode=${captureMode}`,
        {
          durationSeconds: duration,
          targetFps,
          estimatedTotalFrames,
          maxFrames: maxFrames ?? null,
          totalFrames,
          scale,
          frameFormat,
          captureMode,
        }
      );

      video.currentTime = 0;

      let consecutiveEmptyFrames = 0;
      const startDecodeTime = Date.now();

      const captureFrame = async (index: number, timestamp: number) => {
        if (shouldCancel?.()) {
          throw new Error('Conversion cancelled by user');
        }

        // Fail-fast if decode is taking too long (indicates stall)
        const elapsed = Date.now() - startDecodeTime;
        if (elapsed > maxTotalDecodeMs) {
          throw new Error(
            `WebCodecs decode exceeded ${maxTotalDecodeMs}ms timeout (mode=${effectiveCaptureMode}) at frame ${index}. ` +
              'Codec incompatibility detected. Falling back to FFmpeg.'
          );
        }

        captureContext.context.drawImage(
          video,
          0,
          0,
          captureContext.targetWidth,
          captureContext.targetHeight
        );

        let data: Uint8Array | undefined;
        let imageData: ImageData | undefined;

        if (frameFormat === 'rgba') {
          imageData = captureContext.context.getImageData(
            0,
            0,
            captureContext.targetWidth,
            captureContext.targetHeight
          );
          if (imageData.data.length === 0) {
            consecutiveEmptyFrames += 1;
            logger.warn('conversion', `WebCodecs produced empty RGBA frame ${index}, skipping`, {
              consecutiveEmptyFrames,
              maxAllowed: MAX_CONSECUTIVE_EMPTY_FRAMES,
            });

            if (consecutiveEmptyFrames >= MAX_CONSECUTIVE_EMPTY_FRAMES) {
              throw new Error(
                `WebCodecs decoder produced ${consecutiveEmptyFrames} consecutive empty frames at frame ${index}. ` +
                  'This typically indicates codec incompatibility (e.g., AV1). Falling back to FFmpeg.'
              );
            }
            return; // Skip empty frame without emitting
          }
          consecutiveEmptyFrames = 0;
        } else {
          // Determine optimal encoding format based on quality preset & codec
          // Use JPEG for low/medium quality (3-5x faster encoding), PNG for high quality
          // VP9/HEVC: Force JPEG to reduce canvas encoding latency (avoid GPU stalls)
          const forceJpegForComplexCodec = isComplexCodec;
          const shouldUseJpeg =
            forceJpegForComplexCodec ||
            frameFormat === 'jpeg' ||
            (frameFormat === 'png' && quality && (quality === 'low' || quality === 'medium'));

          const encodeMimeType = shouldUseJpeg ? 'image/jpeg' : 'image/png';
          const encodeQuality = shouldUseJpeg
            ? quality === 'low'
              ? 0.75 // Low quality: 75% JPEG
              : quality === 'medium'
                ? 0.85 // Medium quality: 85% JPEG
                : frameQuality // Fallback to provided frameQuality if available
            : undefined; // PNG: no quality parameter (lossless)

          // Prefer OffscreenCanvas.convertToBlob() when available (non-blocking, faster)
          // Fall back to HTMLCanvasElement.toBlob() for broader compatibility
          // Add timeout to detect GPU stalls (VP9/HEVC can cause blocking encodes)
          const convertBlobWithTimeout = async (): Promise<Blob> => {
            const timeoutPromise = new Promise<Blob>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `Canvas encoding timeout (${CANVAS_ENCODE_TIMEOUT_MS}ms) - GPU stall detected`
                    )
                  ),
                CANVAS_ENCODE_TIMEOUT_MS
              )
            );

            if ('convertToBlob' in captureContext.canvas) {
              try {
                const blobPromise = (captureContext.canvas as OffscreenCanvas).convertToBlob({
                  type: encodeMimeType,
                  quality: encodeQuality,
                });
                return Promise.race([blobPromise, timeoutPromise]);
              } catch (offscreenError) {
                // Fall back to canvasToBlob if OffscreenCanvas fails
                logger.debug(
                  'conversion',
                  'OffscreenCanvas.convertToBlob() failed, using fallback',
                  {
                    error: getErrorMessage(offscreenError),
                  }
                );
                const blobPromise = canvasToBlob(
                  captureContext.canvas,
                  encodeMimeType,
                  encodeQuality
                );
                return Promise.race([blobPromise, timeoutPromise]);
              }
            }
            // Fallback to HTMLCanvasElement.toBlob()
            const blobPromise = canvasToBlob(captureContext.canvas, encodeMimeType, encodeQuality);
            return Promise.race([blobPromise, timeoutPromise]);
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
            // Timeout during canvas encode suggests codec incompatibility or GPU saturation
            throw new Error(
              `Canvas encoding stalled at frame ${index}. ` +
                'This may indicate codec incompatibility or GPU memory exhaustion. Falling back to FFmpeg.'
            );
          }

          if (blob.size === 0) {
            consecutiveEmptyFrames += 1;
            logger.warn('conversion', `WebCodecs produced empty frame ${index}, skipping`, {
              consecutiveEmptyFrames,
              maxAllowed: MAX_CONSECUTIVE_EMPTY_FRAMES,
            });

            if (consecutiveEmptyFrames >= MAX_CONSECUTIVE_EMPTY_FRAMES) {
              throw new Error(
                `WebCodecs decoder produced ${consecutiveEmptyFrames} consecutive empty frames at frame ${index}. ` +
                  'This typically indicates codec incompatibility (e.g., AV1). Falling back to FFmpeg.'
              );
            }
            return; // Skip this empty capture and keep decoding
          }

          data = new Uint8Array(await blob.arrayBuffer());
          if (data.byteLength === 0) {
            consecutiveEmptyFrames += 1;
            logger.warn('conversion', `WebCodecs produced empty frame data at ${index}, skipping`, {
              consecutiveEmptyFrames,
              maxAllowed: MAX_CONSECUTIVE_EMPTY_FRAMES,
            });

            if (consecutiveEmptyFrames >= MAX_CONSECUTIVE_EMPTY_FRAMES) {
              throw new Error(
                `WebCodecs decoder produced ${consecutiveEmptyFrames} consecutive empty frames at frame ${index}. ` +
                  'This typically indicates codec incompatibility (e.g., AV1). Falling back to FFmpeg.'
              );
            }
            return;
          }
          consecutiveEmptyFrames = 0; // Reset counter on successful frame
        }

        // Use actual encoded format for filename extension to match blob content
        // Critical: FFmpeg PNG decoder fails on JPEG data (signature 0xFFD8FFE0 vs 0x89504E47)
        const actualFormat =
          frameFormat === 'rgba'
            ? 'rgba'
            : frameFormat === 'jpeg'
              ? 'jpeg'
              : quality && (quality === 'low' || quality === 'medium')
                ? 'jpeg'
                : 'png';

        const frameName = formatFrameName(
          framePrefix,
          frameDigits,
          index,
          frameStartNumber,
          actualFormat
        );
        try {
          await onFrame({ name: frameName, data, imageData, index, timestamp });
        } catch (frameCallbackError) {
          throw new Error(
            `onFrame callback failed at frame ${index}: ` +
              (frameCallbackError instanceof Error
                ? frameCallbackError.message
                : String(frameCallbackError))
          );
        }
        frameFiles.push(frameName);
        onProgress?.(frameFiles.length, totalFrames);
      };

      const supportStatus = getWebCodecsSupportStatus();
      const supportsFrameCallback = typeof video.requestVideoFrameCallback === 'function';
      const supportsTrackProcessor = supportStatus.trackProcessor && supportStatus.captureStream;

      if (captureMode === 'track') {
        if (!supportsTrackProcessor) {
          throw new Error('WebCodecs track processor is not supported in this browser.');
        }
        effectiveCaptureMode = 'track';
        maxTotalDecodeMs = computeMaxTotalDecodeMs(effectiveCaptureMode);
        await this.captureWithTrackProcessor(
          video,
          duration,
          targetFps,
          captureFrame,
          shouldCancel,
          totalFrames
        );
      } else if (captureMode === 'frame-callback') {
        if (!supportsFrameCallback) {
          throw new Error('requestVideoFrameCallback is not supported in this browser.');
        }
        effectiveCaptureMode = 'frame-callback';
        maxTotalDecodeMs = computeMaxTotalDecodeMs(effectiveCaptureMode);
        await this.captureWithFrameCallback(
          video,
          duration,
          targetFps,
          captureFrame,
          shouldCancel,
          totalFrames,
          codec
        );
      } else if (captureMode === 'seek') {
        effectiveCaptureMode = 'seek';
        maxTotalDecodeMs = computeMaxTotalDecodeMs(effectiveCaptureMode);
        await this.captureWithSeeking(
          video,
          duration,
          targetFps,
          captureFrame,
          shouldCancel,
          totalFrames,
          codec
        );
      } else if (supportsTrackProcessor) {
        try {
          effectiveCaptureMode = 'track';
          maxTotalDecodeMs = computeMaxTotalDecodeMs(effectiveCaptureMode);
          await this.captureWithTrackProcessor(
            video,
            duration,
            targetFps,
            captureFrame,
            shouldCancel,
            totalFrames
          );
        } catch (error) {
          const errorMsg = getErrorMessage(error);
          const errorStack = error instanceof Error ? error.stack : '';
          logger.warn('conversion', 'WebCodecs track capture failed, falling back', {
            error: errorMsg,
            supportsFrameCallback,
            stack: errorStack,
          });
          if (supportsFrameCallback) {
            logger.info(
              'conversion',
              'WebCodecs decoder: Attempting frame-callback fallback mode',
              {}
            );
            effectiveCaptureMode = 'frame-callback';
            maxTotalDecodeMs = computeMaxTotalDecodeMs(effectiveCaptureMode);
            await this.captureWithFrameCallback(
              video,
              duration,
              targetFps,
              captureFrame,
              shouldCancel,
              totalFrames
            );
          } else {
            logger.info(
              'conversion',
              'WebCodecs decoder: frame-callback not supported, using seek fallback',
              {}
            );
            effectiveCaptureMode = 'seek';
            maxTotalDecodeMs = computeMaxTotalDecodeMs(effectiveCaptureMode);
            await this.captureWithSeeking(
              video,
              duration,
              targetFps,
              captureFrame,
              shouldCancel,
              totalFrames
            );
          }
        }
      } else if (supportsFrameCallback) {
        effectiveCaptureMode = 'frame-callback';
        maxTotalDecodeMs = computeMaxTotalDecodeMs(effectiveCaptureMode);
        await this.captureWithFrameCallback(
          video,
          duration,
          targetFps,
          captureFrame,
          shouldCancel,
          totalFrames,
          codec
        );
      } else {
        effectiveCaptureMode = 'seek';
        maxTotalDecodeMs = computeMaxTotalDecodeMs(effectiveCaptureMode);
        await this.captureWithSeeking(
          video,
          duration,
          targetFps,
          captureFrame,
          shouldCancel,
          totalFrames,
          codec
        );
      }

      return {
        frameFiles,
        frameCount: frameFiles.length,
        captureModeUsed: effectiveCaptureMode,
        width: targetWidth,
        height: targetHeight,
        fps: targetFps,
        duration,
      };
    } finally {
      this.cleanupVideo(video, url);
    }
  }

  private attachVideoForDecode(video: HTMLVideoElement): void {
    if (typeof document === 'undefined') {
      return;
    }

    const body = document.body;
    if (!body) {
      return;
    }

    if (video.parentElement) {
      return;
    }

    try {
      video.style.position = 'fixed';
      // Keep the element inside the viewport so browsers treat it as "rendered".
      // Some engines may throttle frame callbacks and captureStream for offscreen
      // or fully transparent videos, which can cause severe under-capture.
      video.style.right = '0';
      video.style.bottom = '0';
      video.style.width = '2px';
      video.style.height = '2px';
      // Avoid fully transparent (0) to reduce the chance of "not painted" optimizations.
      video.style.opacity = '0.001';
      video.style.pointerEvents = 'none';
      video.style.zIndex = '0';
      video.style.background = 'transparent';
      video.style.contain = 'strict';
      video.style.transform = 'translateZ(0)';
      body.appendChild(video);
    } catch (error) {
      logger.debug('conversion', 'Failed to attach video element for decode', {
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Capture frames using requestVideoFrameCallback
   *
   * Uses Chrome/Edge's requestVideoFrameCallback API for precise frame timing.
   * Falls back to seek-based capture if autoplay is blocked.
   *
   * @param video - Video element to capture from
   * @param duration - Video duration in seconds
   * @param targetFps - Target frames per second
   * @param captureFrame - Callback to invoke for each frame
   * @param shouldCancel - Optional cancellation check
   * @param maxFrames - Optional maximum frame count
   */
  private async captureWithFrameCallback(
    video: HTMLVideoElement,
    duration: number,
    targetFps: number,
    captureFrame: (index: number, timestamp: number) => Promise<void>,
    shouldCancel?: () => boolean,
    maxFrames?: number,
    codec?: string
  ): Promise<void> {
    await captureWithFrameCallbackMode({
      video,
      duration,
      targetFps,
      captureFrame,
      shouldCancel,
      maxFrames,
      codec,
      captureWithSeeking: (
        targetVideo,
        targetDuration,
        fps,
        onCapture,
        cancel,
        frameLimit,
        targetCodec
      ) =>
        this.captureWithSeeking(
          targetVideo,
          targetDuration,
          fps,
          onCapture,
          cancel,
          frameLimit,
          targetCodec
        ),
    });
  }

  /**
   * Capture frames using MediaStreamTrackProcessor
   *
   * Uses experimental MediaStreamTrackProcessor API for hardware-accelerated capture.
   * Requires MediaStream.captureStream() support.
   *
   * @param video - Video element to capture from
   * @param duration - Video duration in seconds
   * @param targetFps - Target frames per second
   * @param captureFrame - Callback to invoke for each frame
   * @param shouldCancel - Optional cancellation check
   * @param maxFrames - Optional maximum frame count
   * @throws Error if track processor not available or autoplay blocked
   */
  private async captureWithTrackProcessor(
    video: HTMLVideoElement,
    duration: number,
    targetFps: number,
    captureFrame: (index: number, timestamp: number) => Promise<void>,
    shouldCancel?: () => boolean,
    maxFrames?: number
  ): Promise<void> {
    await captureWithTrackProcessorMode({
      video,
      duration,
      targetFps,
      captureFrame,
      shouldCancel,
      maxFrames,
    });
  }

  /**
   * Capture frames using manual seeking
   *
   * Universal fallback method that works in all browsers.
   * Seeks to each frame position and captures after 'seeked' event.
   * For single-frame extraction, seeks to 25% duration for better representation.
   *
   * @param video - Video element to capture from
   * @param duration - Video duration in seconds
   * @param targetFps - Target frames per second
   * @param captureFrame - Callback to invoke for each frame
   * @param shouldCancel - Optional cancellation check
   * @param maxFrames - Optional maximum frame count
   */
  private async captureWithSeeking(
    video: HTMLVideoElement,
    duration: number,
    targetFps: number,
    captureFrame: (index: number, timestamp: number) => Promise<void>,
    shouldCancel?: () => boolean,
    maxFrames?: number,
    codec?: string
  ): Promise<void> {
    await captureWithSeekingMode({
      video,
      duration,
      targetFps,
      captureFrame,
      shouldCancel,
      maxFrames,
      codec,
      getSeekTimeoutForCodec: (targetCodec) => this.getSeekTimeoutForCodec(targetCodec),
      seekTo: (targetVideo, time, timeoutMs) => this.seekTo(targetVideo, time, timeoutMs),
    });
  }

  /**
   * Seek video to specific time
   *
   * Sets video.currentTime and waits for 'seeked' event.
   * Skips seek if already at target time (within 0.0001s).
   *
   * @param video - Video element to seek
   * @param time - Target time in seconds
   * @throws Error if time is NaN or seek times out
   */
  /**
   * Calculate codec-aware seek timeout
   *
   * AV1 and other complex codecs require more time for seeking due to keyframe complexity.
   * Using a shorter timeout prevents unnecessary waiting on fast seeks.
   *
   * @param codec - Video codec string (e.g., 'av01', 'vp9', 'h264')
   * @returns Timeout in milliseconds
   */
  private getSeekTimeoutForCodec(codec?: string): number {
    if (!codec) {
      return 1500; // Default timeout for unknown codecs
    }

    const normalizedCodec = codec.toLowerCase();
    const isAv1 = normalizedCodec.includes('av1') || normalizedCodec.includes('av01');
    const isVp9 = normalizedCodec.includes('vp9') || normalizedCodec.includes('vp09');
    const isHevc = normalizedCodec.includes('hevc') || normalizedCodec.includes('hvc1');

    // Complex codecs may need more time for seeking
    if (isAv1 || isHevc) {
      return 2000; // 2s for AV1/HEVC (reduced from 5s baseline)
    }
    if (isVp9) {
      return 1800; // 1.8s for VP9
    }

    // Simple codecs (H.264, VP8, etc.) seek quickly
    return 1500; // 1.5s for H.264 and other simple codecs
  }

  private async seekTo(
    video: HTMLVideoElement,
    time: number,
    timeoutMs: number = FFMPEG_INTERNALS.WEBCODECS.SEEK_TIMEOUT_MS
  ): Promise<void> {
    if (Number.isNaN(time)) {
      throw new Error('Invalid seek time for video decode.');
    }

    const clampedTime = Math.max(0, time);
    if (Math.abs(video.currentTime - clampedTime) < 0.0001) {
      return;
    }

    // Prefer fastSeek() when available (can be faster than setting currentTime
    // and waiting for a full seek pipeline in some browsers).
    const maybeFastSeek = video as HTMLVideoElement & {
      fastSeek?: (time: number) => void;
    };
    if (typeof maybeFastSeek.fastSeek === 'function') {
      maybeFastSeek.fastSeek(clampedTime);
    } else {
      video.currentTime = clampedTime;
    }
    await waitForEvent(video, 'seeked', timeoutMs);
  }

  /**
   * Clean up video element and revoke object URL
   *
   * Pauses video, removes src, and revokes blob URL to free memory.
   *
   * @param video - Video element to clean up
   * @param url - Blob URL to revoke
   */
  private cleanupVideo(video: HTMLVideoElement, url: string): void {
    const cleanupStart = Date.now();

    try {
      logger.debug('conversion', 'WebCodecs: Starting video cleanup');

      // Pause playback
      try {
        video.pause();
        logger.debug('conversion', 'WebCodecs: Video paused');
      } catch (error) {
        logger.debug('conversion', 'WebCodecs: Failed to pause video', {
          error: getErrorMessage(error),
        });
      }

      // Remove src attribute and clear srcObject
      try {
        video.removeAttribute('src');
        video.srcObject = null;
        logger.debug('conversion', 'WebCodecs: Src attribute and srcObject cleared');
      } catch (error) {
        logger.debug('conversion', 'WebCodecs: Failed to remove src attribute/srcObject', {
          error: getErrorMessage(error),
        });
      }

      // Trigger media load reset
      try {
        video.load();
        logger.debug('conversion', 'WebCodecs: Load called to reset media');
      } catch (error) {
        logger.debug('conversion', 'WebCodecs: Failed to call load', {
          error: getErrorMessage(error),
        });
      }

      // Reset media element properties to ensure clean state
      try {
        video.currentTime = 0;
        video.autoplay = false;
        video.controls = false;
        logger.debug('conversion', 'WebCodecs: Media element properties reset');
      } catch (error) {
        logger.debug('conversion', 'WebCodecs: Failed to reset media element properties', {
          error: getErrorMessage(error),
        });
      }

      // If we attached the element to the DOM for decode, remove it.
      if (video.parentElement) {
        try {
          video.remove();
          logger.debug('conversion', 'WebCodecs: Video element removed from DOM');
        } catch (error) {
          logger.debug('conversion', 'WebCodecs: Failed to remove video from DOM', {
            error: getErrorMessage(error),
          });
        }
      }
    } catch (error) {
      logger.debug('conversion', 'WebCodecs: Video element cleanup failed', {
        error: getErrorMessage(error),
      });
    }

    // Revoke object URL
    try {
      if (this.activeUrls.has(url)) {
        URL.revokeObjectURL(url);
        this.activeUrls.delete(url);
        logger.debug('conversion', 'WebCodecs: Object URL revoked');
      }
    } catch (error) {
      logger.debug('conversion', 'WebCodecs: Failed to revoke object URL', {
        error: getErrorMessage(error),
      });
    }

    const cleanupTime = Date.now() - cleanupStart;
    logger.debug('conversion', 'WebCodecs: Video cleanup complete', {
      elapsedMs: cleanupTime,
    });
  }
}
