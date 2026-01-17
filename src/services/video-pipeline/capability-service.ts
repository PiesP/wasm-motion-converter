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

type HardwareAccelerationPreference = 'prefer-hardware' | 'prefer-software';

type VideoDecoderConfigWithAcceleration = VideoDecoderConfig & {
  hardwareAcceleration?: HardwareAccelerationPreference;
};

type DecodeSupportResult = {
  supported: boolean;
  hardwareAccelerationParamSupported: boolean;
};

type CodecProbeResult = {
  supported: boolean;
  hwHint?: boolean;
};

type WebpEncodeSupport = {
  canvasWebpEncode: boolean;
  offscreenWebpEncode: boolean;
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
    if (!this.hasWindow()) {
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
    if (!this.canUseStorage()) {
      return null;
    }

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as Partial<VideoCapabilities>;
      return this.sanitizeStoredCaps(parsed);
    } catch (error) {
      logger.warn('general', 'Failed to read cached video caps (non-critical)', {
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  private writeToStorage(caps: VideoCapabilities): void {
    if (!this.canUseStorage()) {
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

  private sanitizeStoredCaps(parsed: Partial<VideoCapabilities>): VideoCapabilities {
    const canvasWebpEncode = parsed.canvasWebpEncode === true;
    const offscreenWebpEncode = parsed.offscreenWebpEncode === true;
    const webpEncode = parsed.webpEncode === true || canvasWebpEncode || offscreenWebpEncode;

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
  }

  private async probe(): Promise<VideoCapabilities> {
    if (!this.hasWindow()) {
      return { ...DEFAULT_CAPS };
    }

    const h264 = await this.probeCodec('avc1.42E01E');
    const hevc = await this.probeCodec('hvc1.1.6.L93.B0');
    const av1 = await this.probeCodec('av01.0.05M.08');

    const webpSupport = await this.probeWebpEncodeSupport();
    const webpEncode = webpSupport.offscreenWebpEncode || webpSupport.canvasWebpEncode;

    const anyHw = h264.hwHint === true || hevc.hwHint === true || av1.hwHint === true;

    const caps: VideoCapabilities = {
      h264: h264.supported,
      hevc: hevc.supported,
      av1: av1.supported,
      canvasWebpEncode: webpSupport.canvasWebpEncode,
      offscreenWebpEncode: webpSupport.offscreenWebpEncode,
      webpEncode,
      hardwareAccelerated: anyHw,
    };

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

  private async probeCodec(codec: string): Promise<CodecProbeResult> {
    const base = await this.probeDecodeSupport({ codec });
    const hw = await this.probeDecodeSupport({ codec, prefer: 'prefer-hardware' });
    const sw = await this.probeDecodeSupport({ codec, prefer: 'prefer-software' });

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
  }

  private async probeDecodeSupport(params: {
    codec: string;
    prefer?: HardwareAccelerationPreference;
  }): Promise<DecodeSupportResult> {
    if (!this.canProbeVideoDecoder()) {
      return { supported: false, hardwareAccelerationParamSupported: false };
    }

    const base = this.createBaseDecodeConfig(params.codec);

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
  }

  private async probeWebpEncodeSupport(): Promise<WebpEncodeSupport> {
    const [offscreenWebpEncode, canvasWebpEncode] = await Promise.all([
      this.testOffscreenWebpEncode(),
      this.testCanvasWebpEncode(),
    ]);

    return {
      offscreenWebpEncode,
      canvasWebpEncode,
    };
  }

  private async testOffscreenWebpEncode(): Promise<boolean> {
    try {
      if (typeof OffscreenCanvas === 'undefined') {
        return false;
      }

      const canvas = new OffscreenCanvas(1, 1);
      const blob = await canvas.convertToBlob({ type: 'image/webp' });
      return Boolean(blob && blob.size > 0 && blob.type === 'image/webp');
    } catch (error) {
      logger.debug('general', 'OffscreenCanvas WebP encoding probe failed', {
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  private async testCanvasWebpEncode(): Promise<boolean> {
    try {
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
  }

  private createBaseDecodeConfig(codec: string): VideoDecoderConfig {
    return {
      codec,
      codedWidth: 640,
      codedHeight: 360,
    };
  }

  private canProbeVideoDecoder(): boolean {
    return (
      this.hasWindow() &&
      typeof VideoDecoder !== 'undefined' &&
      typeof VideoDecoder.isConfigSupported === 'function'
    );
  }

  private hasWindow(): boolean {
    return typeof window !== 'undefined';
  }

  private canUseStorage(): boolean {
    return this.hasWindow() && typeof window.localStorage !== 'undefined';
  }
}

export const capabilityService = CapabilityService.getInstance();
