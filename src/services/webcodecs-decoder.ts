// External dependencies
import { getErrorMessage } from '../utils/error-utils';
import { FFMPEG_INTERNALS } from '../utils/ffmpeg-constants';
import { logger } from '../utils/logger';
import {
  getWebCodecsSupportStatus,
  isWebCodecsCodecSupported,
  isWebCodecsDecodeSupported,
} from './webcodecs-support';

// Type imports
import type { VideoMetadata } from '../types/conversion-types';

/**
 * Frame format type for WebCodecs output
 * - png: PNG format (lossless, larger file size)
 * - jpeg: JPEG format (lossy compression, smaller file size)
 * - rgba: Raw RGBA pixel data (for in-memory processing)
 */
export type WebCodecsFrameFormat = 'png' | 'jpeg' | 'rgba';

/**
 * Progress callback type for frame extraction
 * Reports current frame count and total expected frames
 */
export type WebCodecsProgressCallback = (current: number, total: number) => void;

/**
 * Capture mode for WebCodecs frame extraction
 * - auto: Automatically select best mode (track → frame-callback → seek)
 * - frame-callback: Use requestVideoFrameCallback API (Chrome/Edge)
 * - seek: Manual seeking with seeked event (universal fallback)
 * - track: MediaStreamTrackProcessor API (experimental)
 */
export type WebCodecsCaptureMode = 'auto' | 'frame-callback' | 'seek' | 'track';

/**
 * Frame payload delivered to onFrame callback
 */
export interface WebCodecsFramePayload {
  /** Frame filename (e.g., 'frame_000001.png') */
  name: string;
  /** Encoded frame data (PNG/JPEG bytes) - undefined for rgba format */
  data?: Uint8Array;
  /** Raw RGBA pixel data - undefined for png/jpeg formats */
  imageData?: ImageData;
  /** Zero-based frame index */
  index: number;
  /** Frame timestamp in seconds */
  timestamp: number;
}

/**
 * Options for WebCodecs video decoding
 */
export interface WebCodecsDecodeOptions {
  /** Input video file */
  file: File;
  /** Target frames per second (frame extraction rate) */
  targetFps: number;
  /** Scale factor (0.0 to 1.0) - 1.0 = original size */
  scale: number;
  /** Output frame format (png, jpeg, or rgba) */
  frameFormat: WebCodecsFrameFormat;
  /** JPEG quality (0.0 to 1.0) - ignored for png/rgba */
  frameQuality: number;
  /** Frame filename prefix (e.g., 'frame_') */
  framePrefix: string;
  /** Number of zero-padded digits in filename (e.g., 6 = '000001') */
  frameDigits: number;
  /** Starting frame number (usually 0) */
  frameStartNumber: number;
  /** Optional maximum frame count (for limiting output) */
  maxFrames?: number;
  /** Frame capture mode (auto, track, frame-callback, seek) */
  captureMode?: WebCodecsCaptureMode;
  /** Callback invoked for each extracted frame */
  onFrame: (frame: WebCodecsFramePayload) => Promise<void>;
  /** Optional progress callback */
  onProgress?: WebCodecsProgressCallback;
  /** Optional cancellation check */
  shouldCancel?: () => boolean;
}

/**
 * Result of WebCodecs video decoding
 */
export interface WebCodecsDecodeResult {
  /** Array of frame filenames */
  frameFiles: string[];
  /** Total number of extracted frames */
  frameCount: number;
  /** Frame width in pixels (after scaling) */
  width: number;
  /** Frame height in pixels (after scaling) */
  height: number;
  /** Target frames per second */
  fps: number;
  /** Video duration in seconds */
  duration: number;
}

/**
 * Canvas context for frame capture
 * Encapsulates canvas, rendering context, and dimensions
 */
type CaptureContext = {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  targetWidth: number;
  targetHeight: number;
};

/**
 * Maximum consecutive empty frames before failing
 * Reduced from 3 to 2 for faster AV1 codec fallback detection
 */
const MAX_CONSECUTIVE_EMPTY_FRAMES = 2;

/**
 * Wait for event with timeout
 *
 * Creates a promise that resolves when the target event fires or rejects on timeout.
 *
 * @param target - Event target to listen to
 * @param eventName - Name of event to wait for
 * @param timeoutMs - Timeout in milliseconds
 * @returns Promise that resolves with the event or rejects on timeout
 */
const waitForEvent = (target: EventTarget, eventName: string, timeoutMs: number): Promise<Event> =>
  new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);

    const onEvent = (event: Event) => {
      cleanup();
      resolve(event);
    };

    const cleanup = () => {
      window.clearTimeout(timer);
      target.removeEventListener(eventName, onEvent);
    };

    target.addEventListener(eventName, onEvent, { once: true });
  });

/**
 * Create canvas for frame capture
 *
 * Creates either OffscreenCanvas or HTMLCanvasElement with 2D context.
 * Configures high-quality image smoothing for better scaling.
 *
 * @param width - Canvas width in pixels
 * @param height - Canvas height in pixels
 * @param willReadFrequently - Optimize context for frequent reads (RGBA extraction)
 * @returns Canvas context wrapper with dimensions
 */
const createCanvas = (
  width: number,
  height: number,
  willReadFrequently: boolean = false
): CaptureContext => {
  const hasDocument = typeof document !== 'undefined';
  if (hasDocument) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently });
    if (!context) {
      throw new Error('Canvas 2D context not available');
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    return { canvas, context, targetWidth: width, targetHeight: height };
  }

  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('Canvas rendering is not available in this environment.');
  }

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently });
  if (!context) {
    throw new Error('Canvas 2D context not available');
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  return { canvas, context, targetWidth: width, targetHeight: height };
};

/**
 * Convert canvas to Blob
 *
 * Uses OffscreenCanvas.convertToBlob() when available, falls back to toBlob().
 *
 * @param canvas - Canvas to convert
 * @param mimeType - MIME type ('image/png' or 'image/jpeg')
 * @param quality - Optional quality (0.0 to 1.0, for JPEG only)
 * @returns Promise that resolves with Blob
 */
const canvasToBlob = async (
  canvas: OffscreenCanvas | HTMLCanvasElement,
  mimeType: string,
  quality?: number
): Promise<Blob> => {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type: mimeType, quality });
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        reject(new Error('Failed to capture frame'));
      },
      mimeType,
      quality
    );
  });
};

/**
 * Format frame filename
 *
 * Creates zero-padded frame filename (e.g., 'frame_000042.png').
 *
 * @param prefix - Filename prefix
 * @param digits - Number of zero-padded digits
 * @param index - Frame index
 * @param extension - File extension
 * @returns Formatted filename
 */
const formatFrameName = (
  prefix: string,
  digits: number,
  index: number,
  extension: string
): string => `${prefix}${String(index).padStart(digits, '0')}.${extension}`;

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
      onFrame,
      onProgress,
      shouldCancel,
    } = options;

    const url = URL.createObjectURL(file);
    this.activeUrls.add(url);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = url;

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

      const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
      const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
      const captureContext = createCanvas(targetWidth, targetHeight, frameFormat === 'rgba');
      const frameFiles: string[] = [];
      const estimatedTotalFrames = Math.max(1, Math.ceil(duration * targetFps));
      const totalFrames =
        maxFrames && maxFrames > 0
          ? Math.max(1, Math.min(maxFrames, estimatedTotalFrames))
          : estimatedTotalFrames;

      video.currentTime = 0;

      let consecutiveEmptyFrames = 0;
      const startDecodeTime = Date.now();

      const captureFrame = async (index: number, timestamp: number) => {
        if (shouldCancel?.()) {
          throw new Error('Conversion cancelled by user');
        }

        // Fail-fast if decode is taking too long (indicates stall)
        const elapsed = Date.now() - startDecodeTime;
        if (elapsed > FFMPEG_INTERNALS.WEBCODECS.MAX_TOTAL_DECODE_MS) {
          throw new Error(
            `WebCodecs decode exceeded ${FFMPEG_INTERNALS.WEBCODECS.MAX_TOTAL_DECODE_MS}ms timeout at frame ${index}. ` +
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
          const blob = await canvasToBlob(
            captureContext.canvas,
            frameFormat === 'png' ? 'image/png' : 'image/jpeg',
            frameFormat === 'jpeg' ? frameQuality : undefined
          );
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
        const frameName = formatFrameName(
          framePrefix,
          frameDigits,
          frameStartNumber + index,
          frameFormat
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
        await this.captureWithFrameCallback(
          video,
          duration,
          targetFps,
          captureFrame,
          shouldCancel,
          totalFrames
        );
      } else if (captureMode === 'seek') {
        await this.captureWithSeeking(
          video,
          duration,
          targetFps,
          captureFrame,
          shouldCancel,
          totalFrames
        );
      } else if (supportsTrackProcessor) {
        try {
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
        await this.captureWithFrameCallback(
          video,
          duration,
          targetFps,
          captureFrame,
          shouldCancel,
          totalFrames
        );
      } else {
        await this.captureWithSeeking(
          video,
          duration,
          targetFps,
          captureFrame,
          shouldCancel,
          totalFrames
        );
      }

      return {
        frameFiles,
        frameCount: frameFiles.length,
        width: targetWidth,
        height: targetHeight,
        fps: targetFps,
        duration,
      };
    } finally {
      this.cleanupVideo(video, url);
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
    maxFrames?: number
  ): Promise<void> {
    try {
      await video.play();
    } catch (error) {
      logger.warn('conversion', 'Autoplay blocked, falling back to seek capture', {
        error: getErrorMessage(error),
      });
      await this.captureWithSeeking(
        video,
        duration,
        targetFps,
        captureFrame,
        shouldCancel,
        maxFrames
      );
      return;
    }

    const frameInterval = 1 / targetFps;
    const totalFrames =
      maxFrames && maxFrames > 0
        ? Math.max(1, Math.min(maxFrames, Math.ceil(duration * targetFps)))
        : Math.max(1, Math.ceil(duration * targetFps));
    const epsilon = 0.001;
    let nextFrameTime = 0;
    let frameIndex = 0;

    await new Promise<void>((resolve, reject) => {
      let finished = false;
      let stallTimer: ReturnType<typeof setTimeout> | null = null;

      const clearStallTimer = () => {
        if (stallTimer) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
      };

      const scheduleStallTimer = () => {
        clearStallTimer();
        stallTimer = setTimeout(() => {
          if (finished) {
            return;
          }
          finished = true;
          reject(new Error('WebCodecs frame capture stalled.'));
        }, FFMPEG_INTERNALS.WEBCODECS.FRAME_STALL_TIMEOUT_MS);
      };

      const finalize = () => {
        if (finished) {
          return;
        }
        finished = true;
        clearStallTimer();
        video.removeEventListener('ended', handleEnded);
        video.removeEventListener('error', handleError);
        resolve();
      };

      const handleEnded = () => {
        finalize();
      };

      const handleError = () => {
        if (finished) {
          return;
        }
        finished = true;
        clearStallTimer();
        reject(new Error('WebCodecs video decode error.'));
      };

      video.addEventListener('ended', handleEnded, { once: true });
      video.addEventListener('error', handleError, { once: true });
      scheduleStallTimer();

      const handleFrame = async (
        _now: number,
        metadata: VideoFrameCallbackMetadata
      ): Promise<void> => {
        try {
          if (finished) {
            return;
          }
          if (shouldCancel?.()) {
            finished = true;
            reject(new Error('Conversion cancelled by user'));
            return;
          }

          const mediaTime = metadata.mediaTime ?? video.currentTime;
          const shouldCapture = frameIndex === 0 || mediaTime + epsilon >= nextFrameTime;

          if (shouldCapture) {
            await captureFrame(frameIndex, mediaTime);
            frameIndex += 1;
            nextFrameTime += frameInterval;
            scheduleStallTimer();
          }

          if (frameIndex >= totalFrames || mediaTime + epsilon >= duration || video.ended) {
            finalize();
            return;
          }

          video.requestVideoFrameCallback(handleFrame);
        } catch (error) {
          if (finished) {
            return;
          }
          finished = true;
          clearStallTimer();
          reject(error);
        }
      };

      video.requestVideoFrameCallback(handleFrame);
    });

    logger.info('conversion', 'WebCodecs frame-callback capture completed', {
      capturedFrames: frameIndex,
      totalFrames,
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
    if (
      typeof MediaStreamTrackProcessor === 'undefined' ||
      typeof (video as unknown as Record<string, unknown>).captureStream !== 'function'
    ) {
      throw new Error('WebCodecs track processor is not available in this browser.');
    }

    try {
      await video.play();
    } catch (error) {
      logger.warn('conversion', 'Autoplay blocked for track capture', {
        error: getErrorMessage(error),
      });
      throw error;
    }

    const stream = (video as unknown as { captureStream(): MediaStream }).captureStream();
    const [track] = stream.getVideoTracks();
    if (!track) {
      throw new Error('No video track available for WebCodecs capture.');
    }

    const processor = new MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();
    const frameIntervalUs = 1_000_000 / targetFps;
    const totalFrames =
      maxFrames && maxFrames > 0
        ? Math.max(1, Math.min(maxFrames, Math.ceil(duration * targetFps)))
        : Math.max(1, Math.ceil(duration * targetFps));
    const epsilonUs = 1_000;
    let nextFrameTimeUs = 0;
    let frameIndex = 0;
    const startDecodeTime = Date.now();

    const readFrame = async (): Promise<ReadableStreamReadResult<VideoFrame>> => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      try {
        return await Promise.race([
          reader.read(),
          new Promise<ReadableStreamReadResult<VideoFrame>>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new Error('WebCodecs track capture stalled.'));
            }, FFMPEG_INTERNALS.WEBCODECS.FRAME_STALL_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    };

    try {
      while (frameIndex < totalFrames) {
        if (shouldCancel?.()) {
          throw new Error('Conversion cancelled by user');
        }

        const elapsed = Date.now() - startDecodeTime;
        if (elapsed > FFMPEG_INTERNALS.WEBCODECS.MAX_TOTAL_DECODE_MS) {
          throw new Error(
            `WebCodecs decode exceeded ${FFMPEG_INTERNALS.WEBCODECS.MAX_TOTAL_DECODE_MS}ms timeout at frame ${frameIndex}. ` +
              'Codec incompatibility detected. Falling back to FFmpeg.'
          );
        }

        const { value: frame, done } = await readFrame();
        if (done || !frame) {
          break;
        }

        try {
          const timestampUs =
            typeof frame.timestamp === 'number'
              ? frame.timestamp
              : Math.round(video.currentTime * 1_000_000);
          const shouldCapture = frameIndex === 0 || timestampUs + epsilonUs >= nextFrameTimeUs;

          if (shouldCapture) {
            await captureFrame(frameIndex, timestampUs / 1_000_000);
            frameIndex += 1;
            nextFrameTimeUs += frameIntervalUs;
          }

          if (timestampUs / 1_000_000 >= duration) {
            break;
          }
        } finally {
          frame.close();
        }
      }
    } finally {
      reader.releaseLock();
      track.stop();
      video.pause();
      logger.info('conversion', 'WebCodecs track capture completed', {
        capturedFrames: frameIndex,
        totalFrames,
        elapsed: Date.now() - startDecodeTime,
      });
    }
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
    maxFrames?: number
  ): Promise<void> {
    video.pause();

    // Fast extraction for single-frame formats (WebP)
    // Seek to a representative frame (25% into video or middle) instead of first frame
    if (maxFrames === 1) {
      if (shouldCancel?.()) {
        throw new Error('Conversion cancelled by user');
      }

      // Choose representative frame: 25% duration mark, clamped to valid range
      // This provides better representation than first frame (often black/fade-in)
      const epsilon = 0.001;
      const representativeTime = Math.min(duration - epsilon, Math.max(epsilon, duration * 0.25));

      logger.info('conversion', 'Fast single-frame extraction', {
        duration,
        targetTime: representativeTime,
        position: '25%',
      });

      await this.seekTo(video, representativeTime);
      await captureFrame(0, representativeTime);
      return;
    }

    // Standard multi-frame extraction
    const frameInterval = 1 / targetFps;
    const totalFrames =
      maxFrames && maxFrames > 0
        ? Math.max(1, Math.min(maxFrames, Math.ceil(duration * targetFps)))
        : Math.max(1, Math.ceil(duration * targetFps));
    const epsilon = 0.001;

    for (let index = 0; index < totalFrames; index += 1) {
      if (shouldCancel?.()) {
        throw new Error('Conversion cancelled by user');
      }

      const targetTime = Math.min(duration - epsilon, index * frameInterval);
      await this.seekTo(video, targetTime);
      await captureFrame(index, targetTime);
    }

    logger.info('conversion', 'WebCodecs seek-based capture completed', {
      capturedFrames: totalFrames,
      totalFrames,
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
  private async seekTo(video: HTMLVideoElement, time: number): Promise<void> {
    if (Number.isNaN(time)) {
      throw new Error('Invalid seek time for video decode.');
    }

    const clampedTime = Math.max(0, time);
    if (Math.abs(video.currentTime - clampedTime) < 0.0001) {
      return;
    }

    video.currentTime = clampedTime;
    await waitForEvent(video, 'seeked', FFMPEG_INTERNALS.WEBCODECS.SEEK_TIMEOUT_MS);
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
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch (error) {
      logger.debug('conversion', 'Video element cleanup failed', {
        error: getErrorMessage(error),
      });
    }

    if (this.activeUrls.has(url)) {
      URL.revokeObjectURL(url);
      this.activeUrls.delete(url);
    }
  }
}
