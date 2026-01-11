// External dependencies
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

// Type imports
import type { VideoMetadata } from '@t/conversion-types';

/**
 * WebCodecs API support status
 *
 * Represents the availability of various WebCodecs APIs and related browser features
 * for GPU-accelerated video/image processing.
 */
export type WebCodecsSupportStatus = {
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

/**
 * Codec candidates for H.264 encoder
 *
 * Listed in order of preference:
 * - Baseline Profile: Most compatible, lower compression
 * - Main Profile: Better compression
 * - High Profile: Best quality, less compatible
 */
const H264_ENCODER_CODECS = [
  'avc1.42E01E', // Baseline Level 3.0
  'avc1.4D401E', // Main Level 3.0
  'avc1.42001E', // Baseline Level 3.0 (alt)
  'avc1.640028', // High Level 4.0
];

/** Cached WebCodecs support status to avoid repeated checks */
let cachedStatus: WebCodecsSupportStatus | null = null;

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
 * @returns Support status object with flags for each API
 *
 * @example
 * const status = getWebCodecsSupportStatus();
 * if (status.videoDecoder && status.trackProcessor) {
 *   // Use GPU-accelerated video decoding
 * }
 */
export const getWebCodecsSupportStatus = (): WebCodecsSupportStatus => {
  if (cachedStatus) {
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
 * @returns True if WebCodecs decoding is usable
 */
export const isWebCodecsDecodeSupported = (): boolean => {
  const status = getWebCodecsSupportStatus();
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
const normalizeCodec = (codec: string): string => codec.trim().toLowerCase();

/**
 * Get codec string candidates for testing
 *
 * Maps generic codec names to specific codec strings with profiles/levels.
 * Returns multiple candidates for fallback testing.
 *
 * @param codec - Generic codec name (e.g., 'h264', 'av1', 'vp9')
 * @returns Array of specific codec strings to test
 *
 * @example
 * getCodecCandidates('av1') // ['av01.0.05M.08', 'av01.0.08M.08', 'av01.0.08M.10']
 * getCodecCandidates('h264') // ['avc1.42E01E', 'avc1.4D401E']
 */
const getCodecCandidates = (codec: string): string[] => {
  const normalized = normalizeCodec(codec);
  switch (normalized) {
    case 'av1':
    case 'av01':
      return ['av01.0.05M.08', 'av01.0.08M.08', 'av01.0.08M.10'];
    case 'vp9':
    case 'vp09':
      return ['vp09.00.10.08', 'vp9'];
    case 'vp8':
    case 'vp08':
      return ['vp8', 'vp08.00.10.08'];
    case 'hevc':
    case 'h265':
    case 'hvc1':
    case 'hev1':
      return ['hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0'];
    case 'h264':
    case 'avc':
    case 'avc1':
    case 'avc3':
      return ['avc1.42E01E', 'avc1.4D401E'];
    default:
      return [];
  }
};

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
  metadata?: VideoMetadata
): Promise<boolean> {
  const candidates = getCodecCandidates(codec);
  if (candidates.length === 0) {
    return false;
  }

  const status = getWebCodecsSupportStatus();
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

/**
 * Get H.264 encoder configuration supported by the browser
 *
 * Tests multiple H.264 profiles (Baseline, Main, High) with hardware and software acceleration.
 * Returns the first supported configuration.
 *
 * @param params - Encoder parameters (width, height, bitrate, framerate)
 * @returns Supported VideoEncoderConfig or null if no config is supported
 *
 * @example
 * const config = await getH264EncoderConfig({
 *   width: 1280,
 *   height: 720,
 *   bitrate: 2_000_000,
 *   framerate: 30
 * });
 * if (config) {
 *   const encoder = new VideoEncoder(...);
 *   encoder.configure(config);
 * }
 */
export async function getH264EncoderConfig(params: {
  width: number;
  height: number;
  bitrate: number;
  framerate: number;
}): Promise<VideoEncoderConfig | null> {
  const status = getWebCodecsSupportStatus();
  if (!status.videoEncoder || typeof VideoEncoder === 'undefined') {
    return null;
  }

  const width = Math.max(1, Math.round(params.width));
  const height = Math.max(1, Math.round(params.height));
  const bitrate = Math.max(100_000, Math.round(params.bitrate));
  const framerate = Math.max(1, Math.round(params.framerate));

  // Try hardware acceleration first, then software fallback
  const accelerationModes: ('prefer-hardware' | 'prefer-software')[] = [
    'prefer-hardware',
    'prefer-software',
  ];

  for (const hardwareAcceleration of accelerationModes) {
    for (const codec of H264_ENCODER_CODECS) {
      const config: VideoEncoderConfig = {
        codec,
        width,
        height,
        bitrate,
        framerate,
        hardwareAcceleration,
        avc: { format: 'annexb' },
      };

      try {
        const support = await VideoEncoder.isConfigSupported(config);
        if (support.supported) {
          logger.info('conversion', 'H.264 encoder config found', {
            codec,
            hardwareAcceleration,
            width,
            height,
            bitrate,
            framerate,
          });
          return support.config ?? config;
        }
      } catch (error) {
        logger.warn('conversion', 'VideoEncoder.isConfigSupported failed', {
          codec,
          hardwareAcceleration,
          error: getErrorMessage(error),
        });
      }
    }
  }

  logger.error('conversion', 'No H.264 encoder configuration supported', {
    width,
    height,
    bitrate,
    framerate,
    triedCodecs: H264_ENCODER_CODECS,
    triedAccelerations: accelerationModes,
  });

  return null;
}
