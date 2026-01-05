import type { VideoMetadata } from '../types/conversion-types';
import { logger } from '../utils/logger';

export type WebCodecsSupportStatus = {
  available: boolean;
  videoDecoder: boolean;
  videoEncoder: boolean;
  imageDecoder: boolean;
  imageEncoder: boolean;
  videoFrame: boolean;
  trackProcessor: boolean;
  captureStream: boolean;
};

let cachedStatus: WebCodecsSupportStatus | null = null;

const getGlobal = (): typeof globalThis =>
  typeof globalThis !== 'undefined' ? globalThis : ({} as typeof globalThis);

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

const normalizeCodec = (codec: string): string => codec.trim().toLowerCase();

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
          error: error instanceof Error ? error.message : String(error),
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
          error: error instanceof Error ? error.message : String(error),
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

// H.264 encoder codec strings in order of preference
// - avc1.42E01E: Baseline Profile Level 3.0 (most compatible)
// - avc1.4D401E: Main Profile Level 3.0 (better compression)
// - avc1.42001E: Baseline Profile Level 3.0 (alternative)
// - avc1.640028: High Profile Level 4.0 (best quality but less compatible)
const H264_ENCODER_CODECS = [
  'avc1.42E01E', // Baseline Level 3.0
  'avc1.4D401E', // Main Level 3.0
  'avc1.42001E', // Baseline Level 3.0 (alt)
  'avc1.640028', // High Level 4.0
];

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
          error: error instanceof Error ? error.message : String(error),
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
