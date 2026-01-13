/**
 * Capability Service
 *
 * Probes the browser's real WebCodecs capabilities and caches results.
 *
 * Cache locations:
 * - window.__VIDEO_CAPS__
 * - localStorage["video_caps_v4"]
 */

import type { VideoCapabilities } from '@t/video-pipeline-types';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

// NOTE: bumped to invalidate older cached results where `hardwareAcceleration` probing
// could throw and incorrectly report codecs as unsupported.
const STORAGE_KEY = 'video_caps_v4' as const;

const DEFAULT_CAPS: VideoCapabilities = {
  h264: false,
  hevc: false,
  av1: false,
  canvasWebpEncode: false,
  offscreenWebpEncode: false,
  webpEncode: false,
  hardwareAccelerated: false,
};

type VideoDecoderConfigWithAcceleration = VideoDecoderConfig & {
  hardwareAcceleration?: 'prefer-hardware' | 'prefer-software';
};

class CapabilityService {
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

      const canvasWebpEncode = parsed.canvasWebpEncode === true;
      const offscreenWebpEncode = parsed.offscreenWebpEncode === true;
      const webpEncode = parsed.webpEncode === true || canvasWebpEncode || offscreenWebpEncode;

      // Defensive validation: ensure booleans
      const safe: VideoCapabilities = {
        h264: parsed.h264 === true,
        hevc: parsed.hevc === true,
        av1: parsed.av1 === true,
        canvasWebpEncode,
        offscreenWebpEncode,
        webpEncode,
        hardwareAccelerated: parsed.hardwareAccelerated === true,
      };

      if (typeof parsed.h264HardwareDecode === 'boolean') {
        safe.h264HardwareDecode = parsed.h264HardwareDecode;
      }
      if (typeof parsed.hevcHardwareDecode === 'boolean') {
        safe.hevcHardwareDecode = parsed.hevcHardwareDecode;
      }
      if (typeof parsed.av1HardwareDecode === 'boolean') {
        safe.av1HardwareDecode = parsed.av1HardwareDecode;
      }

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

    const baseDecodeConfig = (codec: string): VideoDecoderConfig => ({
      codec,
      codedWidth: 640,
      codedHeight: 360,
    });

    const probeDecodeSupport = async (params: {
      codec: string;
      prefer?: 'prefer-hardware' | 'prefer-software';
    }): Promise<{
      supported: boolean;
      hardwareAccelerationParamSupported: boolean;
    }> => {
      if (!hasVideoDecoder || typeof VideoDecoder.isConfigSupported !== 'function') {
        return { supported: false, hardwareAccelerationParamSupported: false };
      }

      const base = baseDecodeConfig(params.codec);

      // Try with `hardwareAcceleration` first (when requested) to infer HW/SW signals.
      if (params.prefer) {
        const withAcceleration: VideoDecoderConfigWithAcceleration = {
          ...base,
          hardwareAcceleration: params.prefer,
        };

        try {
          const support = await VideoDecoder.isConfigSupported(
            withAcceleration as VideoDecoderConfig
          );
          return {
            supported: support.supported ?? false,
            hardwareAccelerationParamSupported: true,
          };
        } catch (error) {
          // Some browsers reject the `hardwareAcceleration` field entirely.
          // Fall back to a baseline probe so we don't incorrectly mark codecs unsupported.
          try {
            const support = await VideoDecoder.isConfigSupported(base);
            logger.debug(
              'general',
              'VideoDecoder.isConfigSupported rejected hardwareAcceleration; using baseline probe',
              {
                codec: params.codec,
                prefer: params.prefer,
                error: getErrorMessage(error),
              }
            );
            return {
              supported: support.supported ?? false,
              hardwareAccelerationParamSupported: false,
            };
          } catch (fallbackError) {
            logger.debug('general', 'VideoDecoder.isConfigSupported failed during probing', {
              codec: params.codec,
              prefer: params.prefer,
              error: getErrorMessage(fallbackError),
            });
            return {
              supported: false,
              hardwareAccelerationParamSupported: false,
            };
          }
        }
      }

      // Baseline probe (no hardwareAcceleration)
      try {
        const support = await VideoDecoder.isConfigSupported(base);
        return {
          supported: support.supported ?? false,
          hardwareAccelerationParamSupported: false,
        };
      } catch (error) {
        logger.debug('general', 'VideoDecoder.isConfigSupported failed during probing', {
          codec: params.codec,
          error: getErrorMessage(error),
        });
        return { supported: false, hardwareAccelerationParamSupported: false };
      }
    };

    const probeCodec = async (codec: string): Promise<{ supported: boolean; hwHint?: boolean }> => {
      const base = await probeDecodeSupport({ codec });
      const hw = await probeDecodeSupport({ codec, prefer: 'prefer-hardware' });
      const sw = await probeDecodeSupport({ codec, prefer: 'prefer-software' });

      const supported = base.supported || hw.supported || sw.supported;
      const accelParamSupported =
        hw.hardwareAccelerationParamSupported || sw.hardwareAccelerationParamSupported;

      if (!accelParamSupported) {
        return { supported };
      }

      if (hw.hardwareAccelerationParamSupported && hw.supported) {
        return { supported, hwHint: true };
      }

      if (sw.hardwareAccelerationParamSupported && sw.supported) {
        return { supported, hwHint: false };
      }

      return { supported };
    };

    const testOffscreenWebPEncode = async (): Promise<boolean> => {
      try {
        // OffscreenCanvas WebP encode probe (best-effort; mirrors worker-based encoder checks)
        if (typeof OffscreenCanvas !== 'undefined') {
          try {
            const canvas = new OffscreenCanvas(1, 1);
            const blob = await canvas.convertToBlob({ type: 'image/webp' });
            if (blob && blob.size > 0 && blob.type === 'image/webp') {
              return true;
            }
          } catch {
            return false;
          }
        }

        return false;
      } catch (error) {
        logger.debug('general', 'OffscreenCanvas WebP encoding probe failed', {
          error: getErrorMessage(error),
        });
        return false;
      }
    };

    const testCanvasWebPEncode = async (): Promise<boolean> => {
      try {
        // HTMLCanvas WebP encode probe (mirrors `webp-canvas` encoder adapter)
        if (typeof document === 'undefined') {
          return false;
        }

        const createdCanvas = document.createElement('canvas');
        createdCanvas.width = 1;
        createdCanvas.height = 1;

        const ctx = createdCanvas.getContext('2d');
        if (!ctx) {
          return false;
        }

        ctx.fillStyle = 'rgb(0,0,0)';
        ctx.fillRect(0, 0, 1, 1);

        const blob = await new Promise<Blob | null>((resolve) => {
          createdCanvas.toBlob(
            (result) => {
              resolve(result);
            },
            'image/webp',
            0.9
          );
        });

        return Boolean(blob && blob.size > 0 && blob.type === 'image/webp');
      } catch (error) {
        logger.debug('general', 'Canvas WebP encoding probe failed during capability detection', {
          error: getErrorMessage(error),
        });
        return false;
      }
    };

    // Decode support probing (required codec strings)
    const h264 = await probeCodec('avc1.42E01E');
    const hevc = await probeCodec('hvc1.1.6.L93.B0');
    const av1 = await probeCodec('av01.0.05M.08');

    const offscreenWebpEncode = await testOffscreenWebPEncode();
    const canvasWebpEncode = await testCanvasWebPEncode();
    const webpEncode = offscreenWebpEncode || canvasWebpEncode;

    const anyHw = h264.hwHint === true || hevc.hwHint === true || av1.hwHint === true;

    const caps: VideoCapabilities = {
      h264: h264.supported,
      hevc: hevc.supported,
      av1: av1.supported,
      canvasWebpEncode,
      offscreenWebpEncode,
      webpEncode,
      hardwareAccelerated: anyHw,
    };

    // Preserve per-codec hardware decode signals when we can infer them.
    if (typeof h264.hwHint === 'boolean') {
      caps.h264HardwareDecode = h264.hwHint;
    }
    if (typeof hevc.hwHint === 'boolean') {
      caps.hevcHardwareDecode = hevc.hwHint;
    }
    if (typeof av1.hwHint === 'boolean') {
      caps.av1HardwareDecode = av1.hwHint;
    }

    return caps;
  }
}

export const capabilityService = CapabilityService.getInstance();
