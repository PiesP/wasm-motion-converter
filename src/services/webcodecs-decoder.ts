import type { VideoMetadata } from '../types/conversion-types';
import { FFMPEG_INTERNALS } from '../utils/ffmpeg-constants';
import { logger } from '../utils/logger';

export type WebCodecsFrameFormat = 'png' | 'jpeg';

export type WebCodecsProgressCallback = (current: number, total: number) => void;

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
  const hasOffscreenCanvas = typeof OffscreenCanvas !== 'undefined';
  const canvas = hasOffscreenCanvas
    ? new OffscreenCanvas(width, height)
    : document.createElement('canvas');

  if (!hasOffscreenCanvas) {
    canvas.width = width;
    canvas.height = height;
  }

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
      typeof HTMLCanvasElement !== 'undefined'
    );
  }

  static getCodecString(codec: string): string | null {
    const normalized = codec.toLowerCase();
    if (normalized === 'av1' || normalized === 'av01') {
      return 'av01.0.05M.08';
    }
    if (normalized === 'vp9') {
      return 'vp09.00.10.08';
    }
    if (normalized === 'hevc' || normalized === 'h265') {
      return 'hvc1.1.6.L93.B0';
    }
    return null;
  }

  static async isCodecSupported(
    codec: string,
    fileType: string,
    metadata?: VideoMetadata
  ): Promise<boolean> {
    if (typeof navigator === 'undefined' || !('mediaCapabilities' in navigator)) {
      return true;
    }

    const codecString = WebCodecsDecoderService.getCodecString(codec);
    if (!codecString) {
      return true;
    }

    const contentType = `${fileType || 'video/mp4'}; codecs="${codecString}"`;
    const width = metadata?.width || 640;
    const height = metadata?.height || 360;
    const bitrate = metadata?.bitrate || 2_000_000;
    const framerate = metadata?.framerate || 30;

    try {
      const info = await navigator.mediaCapabilities.decodingInfo({
        type: 'file',
        video: {
          contentType,
          width,
          height,
          bitrate,
          framerate,
        },
      });
      return info.supported;
    } catch (error) {
      logger.warn('conversion', 'MediaCapabilities decodingInfo failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
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

      const captureFrame = async (index: number, timestamp: number) => {
        if (shouldCancel?.()) {
          throw new Error('Conversion cancelled by user');
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
        const data = new Uint8Array(await blob.arrayBuffer());
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

      const supportsFrameCallback = typeof video.requestVideoFrameCallback === 'function';
      if (supportsFrameCallback) {
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
    const epsilon = 0.001;
    let nextFrameTime = 0;
    let frameIndex = 0;

    await new Promise<void>((resolve, reject) => {
      const handleFrame = async (
        _now: number,
        metadata: VideoFrameCallbackMetadata
      ): Promise<void> => {
        try {
          if (shouldCancel?.()) {
            reject(new Error('Conversion cancelled by user'));
            return;
          }

          const mediaTime = metadata.mediaTime ?? video.currentTime;
          const shouldCapture = frameIndex === 0 || mediaTime + epsilon >= nextFrameTime;

          if (shouldCapture) {
            await captureFrame(frameIndex, mediaTime);
            frameIndex += 1;
            nextFrameTime += frameInterval;
          }

          if (mediaTime + epsilon >= duration || frameIndex * frameInterval > duration) {
            resolve();
            return;
          }

          video.requestVideoFrameCallback(handleFrame);
        } catch (error) {
          reject(error);
        }
      };

      video.requestVideoFrameCallback(handleFrame);
    });
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
