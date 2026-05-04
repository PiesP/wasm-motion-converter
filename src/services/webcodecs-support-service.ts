// External dependencies

// Type imports
import type { VideoMetadata } from '@t/conversion-types';
import { getCodecCandidates } from '@utils/codec-utils';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

/**
 * WebCodecs API support status
 *
 * Represents the availability of various WebCodecs APIs and related browser features
 * for GPU-accelerated video/image processing.
 */
type WebCodecsSupportStatus = {
  /** Any WebCodecs API is available */
  available: boolean;
  /** VideoDecoder API (decode video frames) */
  videoDecoder: boolean;
  /** VideoEncoder API (encode video frames) */
  videoEncoder: boolean;
  /** ImageDecoder API (decode images) */
  imageDecoder: boolean;
  /** ImageEncoder API (encode images) */
  imageEncoder: boolean;
  /** VideoFrame API (represent video frames) */
  videoFrame: boolean;
  /** MediaStreamTrackProcessor API (extract frames from stream) */
  trackProcessor: boolean;
  /** HTMLMediaElement.captureStream() support */
  captureStream: boolean;
};

/** Cached WebCodecs support status to avoid repeated checks */
let cachedStatus: WebCodecsSupportStatus | null = null;

/**
 * Reset cached WebCodecs support status.
 *
 * Use when browser capabilities may have changed (e.g., after experimental
 * flag toggle, runtime feature detection retry, or testing).
 */
export function resetWebCodecsSupportCache(): void {
  cachedStatus = null;
}

/**
 * Get global scope with fallback
 *
 * @returns Global scope object (globalThis or empty object)
 */
const getGlobal = (): typeof globalThis =>
  typeof globalThis !== 'undefined' ? globalThis : ({} as typeof globalThis);

/**
 * Get WebCodecs API support status
 *
 * Detects availability of WebCodecs APIs (VideoDecoder, VideoEncoder, ImageDecoder, etc.)
 * and related browser features. Result is cached after first call.
 *
 * @param forceRefresh - When true, bypasses cache and re-detects from scratch
 * @returns Support status object with flags for each API
 *
 * @example
 * const status = getWebCodecsSupportStatus();
 * if (status.videoDecoder && status.trackProcessor) {
 *   // Use GPU-accelerated video decoding
 * }
 */
export const getWebCodecsSupportStatus = (forceRefresh = false) => {
  if (cachedStatus && !forceRefresh) {
    return cachedStatus;
  }

  const globalScope = getGlobal() as typeof globalThis & {
    VideoDecoder?: typeof VideoDecoder;
    VideoEncoder?: typeof VideoEncoder;
    ImageDecoder?: typeof ImageDecoder;
    ImageEncoder?: typeof ImageEncoder;
    MediaStreamTrackProcessor?: typeof MediaStreamTrackProcessor;
  };

  const videoDecoder = typeof globalScope.VideoDecoder !== 'undefined';
  const videoEncoder = typeof globalScope.VideoEncoder !== 'undefined';
  const imageDecoder = typeof globalScope.ImageDecoder !== 'undefined';
  const imageEncoder = typeof globalScope.ImageEncoder !== 'undefined';
  const videoFrame = typeof globalScope.VideoFrame !== 'undefined';
  const trackProcessor = typeof globalScope.MediaStreamTrackProcessor !== 'undefined';
  const captureStream =
    typeof HTMLMediaElement !== 'undefined' &&
    typeof (HTMLMediaElement.prototype as unknown as Record<string, unknown>).captureStream ===
      'function';

  const available =
    videoDecoder || videoEncoder || imageDecoder || imageEncoder || videoFrame || trackProcessor;

  cachedStatus = {
    available,
    videoDecoder,
    videoEncoder,
    imageDecoder,
    imageEncoder,
    videoFrame,
    trackProcessor,
    captureStream,
  };

  return cachedStatus;
};

/**
 * Check if WebCodecs video decoding is supported
 *
 * Requires HTMLVideoElement, HTMLCanvasElement, and at least one of:
 * - MediaStreamTrackProcessor + captureStream (preferred)
 * - requestVideoFrameCallback (fallback)
 * - Video seeking (universal fallback)
 *
 * @param forceRefresh - When true, bypasses cache and re-detects from scratch
 * @returns True if WebCodecs decoding is usable
 */
export const isWebCodecsDecodeSupported = (forceRefresh = false): boolean => {
  const status = getWebCodecsSupportStatus(forceRefresh);
  const hasVideoElement =
    typeof HTMLVideoElement !== 'undefined' && typeof HTMLCanvasElement !== 'undefined';
  if (!hasVideoElement) {
    return false;
  }

  const supportsFrameCallback =
    typeof HTMLVideoElement !== 'undefined' &&
    typeof (HTMLVideoElement.prototype as { requestVideoFrameCallback?: unknown })
      .requestVideoFrameCallback === 'function';

  // Track processor is preferred, but we can fall back to requestVideoFrameCallback or seek capture.
  if (status.trackProcessor && status.captureStream) {
    return true;
  }

  if (supportsFrameCallback) {
    return true;
  }

  return true;
};

/**
 * Normalize codec string to lowercase
 *
 * @param codec - Raw codec string (e.g., 'H264', 'AV1')
 * @returns Normalized codec string (e.g., 'h264', 'av1')
 */
/**
 * Check if specific codec is supported for WebCodecs decoding
 *
 * Tests codec support using multiple methods:
 * 1. VideoDecoder.isConfigSupported() (preferred, hardware-accelerated)
 * 2. navigator.mediaCapabilities.decodingInfo() (fallback)
 * 3. HTMLVideoElement.canPlayType() (universal fallback)
 *
 * @param codec - Codec name (e.g., 'h264', 'av1', 'vp9')
 * @param fileType - Video MIME type (e.g., 'video/mp4', 'video/webm')
 * @param metadata - Optional video metadata for accurate testing
 * @param forceRefresh - When true, bypasses cache and re-detects from scratch
 * @returns True if codec is supported
 *
 * @example
 * const supported = await isWebCodecsCodecSupported('av1', 'video/mp4', metadata);
 * if (supported) {
 *   // Use direct WebCodecs decoding
 * } else {
 *   // Fall back to FFmpeg
 * }
 */
export async function isWebCodecsCodecSupported(
  codec: string,
  fileType: string,
  metadata?: VideoMetadata,
  forceRefresh = false
): Promise<boolean> {
  const candidates = getCodecCandidates(codec);
  if (candidates.length === 0) {
    return false;
  }

  const status = getWebCodecsSupportStatus(forceRefresh);
  if (!status.available && typeof HTMLVideoElement === 'undefined') {
    return false;
  }

  const width = metadata?.width || 640;
  const height = metadata?.height || 360;
  const bitrate = metadata?.bitrate || 2_000_000;
  const framerate = metadata?.framerate || 30;

  if (status.videoDecoder && typeof VideoDecoder !== 'undefined') {
    for (const codecString of candidates) {
      try {
        const result = await VideoDecoder.isConfigSupported({
          codec: codecString,
          codedWidth: width,
          codedHeight: height,
          hardwareAcceleration: 'prefer-hardware',
        });
        if (result.supported) {
          return true;
        }
      } catch (error) {
        logger.warn('conversion', 'VideoDecoder.isConfigSupported failed', {
          codec: codecString,
          error: getErrorMessage(error),
        });
      }
    }
  }

  if (typeof navigator !== 'undefined' && navigator.mediaCapabilities) {
    for (const codecString of candidates) {
      try {
        const info = await navigator.mediaCapabilities.decodingInfo({
          type: 'file',
          video: {
            contentType: `${fileType || 'video/mp4'}; codecs="${codecString}"`,
            width,
            height,
            bitrate,
            framerate,
          },
        });
        if (info.supported) {
          return true;
        }
      } catch (error) {
        logger.warn('conversion', 'MediaCapabilities decodingInfo failed', {
          codec: codecString,
          error: getErrorMessage(error),
        });
      }
    }
  }

  if (typeof document !== 'undefined' && typeof HTMLVideoElement !== 'undefined') {
    const testVideo = document.createElement('video');
    for (const codecString of candidates) {
      const canPlay = testVideo.canPlayType(`${fileType || 'video/mp4'}; codecs="${codecString}"`);
      if (canPlay === 'probably' || canPlay === 'maybe') {
        return true;
      }
    }
  }

  return false;
}
