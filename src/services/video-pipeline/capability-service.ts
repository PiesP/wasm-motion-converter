/**
 * Capability Service
 *
 * Probes the browser's real WebCodecs capabilities and caches results.
 *
 * Cache locations:
 * - window.__VIDEO_CAPS__
 * - localStorage["video_caps_v1"]
 */

import type { VideoCapabilities } from '@t/video-pipeline-types';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

const STORAGE_KEY = 'video_caps_v1' as const;

const DEFAULT_CAPS: VideoCapabilities = {
  h264: false,
  hevc: false,
  av1: false,
  webpEncode: false,
  hardwareAccelerated: false,
};

type VideoDecoderConfigWithAcceleration = VideoDecoderConfig & {
  hardwareAcceleration?: 'prefer-hardware' | 'prefer-software';
};

type VideoEncoderConfigWithAcceleration = VideoEncoderConfig & {
  hardwareAcceleration?: 'prefer-hardware' | 'prefer-software';
};

export class CapabilityService {
  private static instance: CapabilityService | null = null;

  static getInstance(): CapabilityService {
    CapabilityService.instance ??= new CapabilityService();
    return CapabilityService.instance;
  }

  private cached: VideoCapabilities | null = null;

  // Enforce singleton
  private constructor() {}

  /**
   * Get cached capabilities (in-memory, localStorage, or defaults).
   *
   * This method is synchronous and never probes Web APIs.
   */
  getCached(): VideoCapabilities {
    if (this.cached) {
      return this.cached;
    }

    const fromStorage = this.readFromStorage();
    if (fromStorage) {
      this.cached = fromStorage;
      return fromStorage;
    }

    this.cached = { ...DEFAULT_CAPS };
    return this.cached;
  }

  /**
   * Probe runtime capabilities and persist results.
   */
  async detectCapabilities(): Promise<VideoCapabilities> {
    if (this.cached) {
      return this.cached;
    }

    const cached = this.readFromStorage();
    if (cached) {
      this.cached = cached;
      this.exposeToWindow(cached);
      return cached;
    }

    const caps = await this.probe();

    this.cached = caps;
    this.writeToStorage(caps);
    this.exposeToWindow(caps);

    logger.info('general', '[VideoCaps] detected', caps);

    return caps;
  }

  private exposeToWindow(caps: VideoCapabilities): void {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.__VIDEO_CAPS__ = caps;
    } catch (error) {
      logger.warn('general', 'Failed to expose window.__VIDEO_CAPS__ (non-critical)', {
        error: getErrorMessage(error),
      });
    }
  }

  private readFromStorage(): VideoCapabilities | null {
    if (typeof window === 'undefined') {
      return null;
    }

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as Partial<VideoCapabilities>;

      // Defensive validation: ensure booleans
      const safe: VideoCapabilities = {
        h264: parsed.h264 === true,
        hevc: parsed.hevc === true,
        av1: parsed.av1 === true,
        webpEncode: parsed.webpEncode === true,
        hardwareAccelerated: parsed.hardwareAccelerated === true,
      };

      return safe;
    } catch (error) {
      logger.warn('general', 'Failed to read cached video caps (non-critical)', {
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  private writeToStorage(caps: VideoCapabilities): void {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(caps));
    } catch (error) {
      logger.warn('general', 'Failed to write cached video caps (non-critical)', {
        error: getErrorMessage(error),
      });
    }
  }

  private async probe(): Promise<VideoCapabilities> {
    // Capability probing is browser-only.
    if (typeof window === 'undefined') {
      return { ...DEFAULT_CAPS };
    }

    const hasVideoDecoder = 'VideoDecoder' in window && typeof VideoDecoder !== 'undefined';
    const hasVideoEncoder = 'VideoEncoder' in window && typeof VideoEncoder !== 'undefined';

    const testDecode = async (params: {
      codec: string;
      prefer: 'prefer-hardware' | 'prefer-software';
    }): Promise<boolean> => {
      if (!hasVideoDecoder || typeof VideoDecoder.isConfigSupported !== 'function') {
        return false;
      }

      const config: VideoDecoderConfigWithAcceleration = {
        codec: params.codec,
        codedWidth: 640,
        codedHeight: 360,
        hardwareAcceleration: params.prefer,
      };

      try {
        const support = await VideoDecoder.isConfigSupported(config as VideoDecoderConfig);
        return support.supported ?? false;
      } catch (error) {
        logger.debug('general', 'VideoDecoder.isConfigSupported failed during probing', {
          codec: params.codec,
          prefer: params.prefer,
          error: getErrorMessage(error),
        });
        return false;
      }
    };

    const testEncodeWebP = async (): Promise<boolean> => {
      if (!hasVideoEncoder || typeof VideoEncoder.isConfigSupported !== 'function') {
        return false;
      }

      const config: VideoEncoderConfigWithAcceleration = {
        // Per prompt requirement (even though many browsers do not support this codec string).
        codec: 'webp',
        width: 16,
        height: 16,
        bitrate: 100_000,
        framerate: 1,
        hardwareAcceleration: 'prefer-hardware',
      };

      try {
        const support = await VideoEncoder.isConfigSupported(config as VideoEncoderConfig);
        return support.supported ?? false;
      } catch (error) {
        logger.debug('general', 'VideoEncoder.isConfigSupported failed during probing', {
          codec: config.codec,
          error: getErrorMessage(error),
        });
        return false;
      }
    };

    // Decode support probing (required codec strings)
    const h264Hw = await testDecode({
      codec: 'avc1.42E01E',
      prefer: 'prefer-hardware',
    });
    const h264Sw = h264Hw
      ? true
      : await testDecode({ codec: 'avc1.42E01E', prefer: 'prefer-software' });

    const hevcHw = await testDecode({
      codec: 'hvc1.1.6.L93.B0',
      prefer: 'prefer-hardware',
    });
    const hevcSw = hevcHw
      ? true
      : await testDecode({
          codec: 'hvc1.1.6.L93.B0',
          prefer: 'prefer-software',
        });

    const av1Hw = await testDecode({
      codec: 'av01.0.05M.08',
      prefer: 'prefer-hardware',
    });
    const av1Sw = av1Hw
      ? true
      : await testDecode({ codec: 'av01.0.05M.08', prefer: 'prefer-software' });

    const webpEncode = await testEncodeWebP();

    const anyHw = h264Hw || hevcHw || av1Hw;

    const caps: VideoCapabilities = {
      h264: h264Sw,
      hevc: hevcSw,
      av1: av1Sw,
      webpEncode,
      hardwareAccelerated: anyHw,
    };

    return caps;
  }
}

export const capabilityService = CapabilityService.getInstance();
