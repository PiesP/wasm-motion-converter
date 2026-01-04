import type { VideoMetadata } from '../types/conversion-types';
import { FFMPEG_INTERNALS } from '../utils/ffmpeg-constants';
import { logger } from '../utils/logger';
import {
  getWebCodecsSupportStatus,
  isWebCodecsCodecSupported,
  isWebCodecsDecodeSupported,
} from './webcodecs-support';

export type WebCodecsFrameFormat = 'png' | 'jpeg';

export type WebCodecsProgressCallback = (current: number, total: number) => void;
export type WebCodecsCaptureMode = 'auto' | 'frame-callback' | 'seek' | 'track';

export interface WebCodecsFramePayload {
  name: string;
  data: Uint8Array;
  index: number;
  timestamp: number;
}

export interface WebCodecsDecodeOptions {
  file: File;
  targetFps: number;
  scale: number;
  frameFormat: WebCodecsFrameFormat;
  frameQuality: number;
  framePrefix: string;
  frameDigits: number;
  frameStartNumber: number;
  captureMode?: WebCodecsCaptureMode;
  onFrame: (frame: WebCodecsFramePayload) => Promise<void>;
  onProgress?: WebCodecsProgressCallback;
  shouldCancel?: () => boolean;
}

export interface WebCodecsDecodeResult {
  frameFiles: string[];
  frameCount: number;
  width: number;
  height: number;
  fps: number;
  duration: number;
}

type CaptureContext = {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  targetWidth: number;
  targetHeight: number;
};

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

const createCanvas = (width: number, height: number): CaptureContext => {
  const hasDocument = typeof document !== 'undefined';
  if (hasDocument) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
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
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    throw new Error('Canvas 2D context not available');
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  return { canvas, context, targetWidth: width, targetHeight: height };
};

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

const formatFrameName = (
  prefix: string,
  digits: number,
  index: number,
  extension: string
): string => `${prefix}${String(index).padStart(digits, '0')}.${extension}`;

const normalizeDuration = (duration: number): number => (Number.isFinite(duration) ? duration : 0);

export class WebCodecsDecoderService {
  private activeUrls = new Set<string>();

  static isSupported(): boolean {
    return (
      typeof document !== 'undefined' &&
      typeof HTMLVideoElement !== 'undefined' &&
      typeof HTMLCanvasElement !== 'undefined' &&
      isWebCodecsDecodeSupported()
    );
  }

  static async isCodecSupported(
    codec: string,
    fileType: string,
    metadata?: VideoMetadata
  ): Promise<boolean> {
    return isWebCodecsCodecSupported(codec, fileType, metadata);
  }

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
      const captureContext = createCanvas(targetWidth, targetHeight);
      const frameFiles: string[] = [];
      const estimatedTotalFrames = Math.max(1, Math.ceil(duration * targetFps));

      video.currentTime = 0;

      let consecutiveEmptyFrames = 0;
      const MAX_CONSECUTIVE_EMPTY_FRAMES = 3; // Abort early if we get multiple empty frames
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

        const blob = await canvasToBlob(
          captureContext.canvas,
          frameFormat === 'png' ? 'image/png' : 'image/jpeg',
          frameFormat === 'jpeg' ? frameQuality : undefined
        );
        if (blob.size === 0) {
          consecutiveEmptyFrames += 1;
          if (consecutiveEmptyFrames >= MAX_CONSECUTIVE_EMPTY_FRAMES) {
            throw new Error(
              `WebCodecs decoder produced ${consecutiveEmptyFrames} consecutive empty frames at frame ${index}. ` +
                'This typically indicates codec incompatibility (e.g., AV1). Falling back to FFmpeg.'
            );
          }
          logger.warn('conversion', `WebCodecs produced empty frame ${index}, retrying`, {
            consecutiveEmptyFrames,
            maxAllowed: MAX_CONSECUTIVE_EMPTY_FRAMES,
          });
          // Still throw to fail-fast after threshold
          throw new Error('Captured empty frame from WebCodecs decoder.');
        }
        consecutiveEmptyFrames = 0; // Reset counter on successful frame

        const data = new Uint8Array(await blob.arrayBuffer());
        if (data.byteLength === 0) {
          throw new Error('Captured empty frame data from WebCodecs decoder.');
        }
        const frameName = formatFrameName(
          framePrefix,
          frameDigits,
          frameStartNumber + index,
          frameFormat
        );
        await onFrame({ name: frameName, data, index, timestamp });
        frameFiles.push(frameName);
        onProgress?.(frameFiles.length, estimatedTotalFrames);
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
          shouldCancel
        );
      } else if (captureMode === 'frame-callback') {
        if (!supportsFrameCallback) {
          throw new Error('requestVideoFrameCallback is not supported in this browser.');
        }
        await this.captureWithFrameCallback(video, duration, targetFps, captureFrame, shouldCancel);
      } else if (captureMode === 'seek') {
        await this.captureWithSeeking(video, duration, targetFps, captureFrame, shouldCancel);
      } else if (supportsTrackProcessor) {
        try {
          await this.captureWithTrackProcessor(
            video,
            duration,
            targetFps,
            captureFrame,
            shouldCancel
          );
        } catch (error) {
          logger.warn('conversion', 'WebCodecs track capture failed, falling back', {
            error: error instanceof Error ? error.message : String(error),
          });
          if (supportsFrameCallback) {
            await this.captureWithFrameCallback(
              video,
              duration,
              targetFps,
              captureFrame,
              shouldCancel
            );
          } else {
            await this.captureWithSeeking(video, duration, targetFps, captureFrame, shouldCancel);
          }
        }
      } else if (supportsFrameCallback) {
        await this.captureWithFrameCallback(video, duration, targetFps, captureFrame, shouldCancel);
      } else {
        await this.captureWithSeeking(video, duration, targetFps, captureFrame, shouldCancel);
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

  private async captureWithFrameCallback(
    video: HTMLVideoElement,
    duration: number,
    targetFps: number,
    captureFrame: (index: number, timestamp: number) => Promise<void>,
    shouldCancel?: () => boolean
  ): Promise<void> {
    try {
      await video.play();
    } catch (error) {
      logger.warn('conversion', 'Autoplay blocked, falling back to seek capture', {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.captureWithSeeking(video, duration, targetFps, captureFrame, shouldCancel);
      return;
    }

    const frameInterval = 1 / targetFps;
    const totalFrames = Math.max(1, Math.ceil(duration * targetFps));
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
  }

  private async captureWithTrackProcessor(
    video: HTMLVideoElement,
    duration: number,
    targetFps: number,
    captureFrame: (index: number, timestamp: number) => Promise<void>,
    shouldCancel?: () => boolean
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
        error: error instanceof Error ? error.message : String(error),
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
    const totalFrames = Math.max(1, Math.ceil(duration * targetFps));
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
    }
  }

  private async captureWithSeeking(
    video: HTMLVideoElement,
    duration: number,
    targetFps: number,
    captureFrame: (index: number, timestamp: number) => Promise<void>,
    shouldCancel?: () => boolean
  ): Promise<void> {
    video.pause();
    const frameInterval = 1 / targetFps;
    const totalFrames = Math.max(1, Math.ceil(duration * targetFps));
    const epsilon = 0.001;

    for (let index = 0; index < totalFrames; index += 1) {
      if (shouldCancel?.()) {
        throw new Error('Conversion cancelled by user');
      }

      const targetTime = Math.min(duration - epsilon, index * frameInterval);
      await this.seekTo(video, targetTime);
      await captureFrame(index, targetTime);
    }
  }

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

  private cleanupVideo(video: HTMLVideoElement, url: string): void {
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch (error) {
      logger.debug('conversion', 'Video element cleanup failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (this.activeUrls.has(url)) {
      URL.revokeObjectURL(url);
      this.activeUrls.delete(url);
    }
  }
}
