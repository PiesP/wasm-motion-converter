/**
 * Extended Capability Service
 *
 * Comprehensive capability detection including VP8/VP9 codecs, encoders,
 * and environment features. Builds upon the base CapabilityService.
 *
 * Cache locations:
 * - localStorage["extended_video_caps_v4"]
 * - window.__EXTENDED_VIDEO_CAPS__ (dev mode)
 *
 * TTL: 24 hours
 * Invalidation: hardware profile change, version bump, TTL expiry, browser updates
 */

import { createSingleton } from '@services/shared/singleton-service';
import { capabilityService } from '@services/video-pipeline/capability-service';
import { isWebCodecsDecodeSupported } from '@services/webcodecs-support-service';
import type { ExtendedCapabilities } from '@t/video-pipeline-types';
import { getErrorMessage } from '@utils/error-utils';
import { isHardwareCacheValid } from '@utils/hardware-profile';
import { logger } from '@utils/logger';

// NOTE: bumped to invalidate older cached results where `hardwareAcceleration` probing
// could throw and incorrectly report codecs as unsupported.
const STORAGE_KEY = 'extended_video_caps_v4' as const;
const DETECTION_VERSION = 6 as const;

/**
 * Capability cache TTL (24 hours)
 *
 * Reduced from 7 days to be more responsive to:
 * - GPU driver updates
 * - Browser updates
 * - Hardware availability changes
 * - WebCodecs API changes
 */
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Cached extended capabilities with TTL and version
 */
interface CachedExtendedCapabilities {
  capabilities: ExtendedCapabilities;
  version: number;
  storedAt: number;
  expiresAt: number;
  hardwareProfileHash: string;
}

type HardwareAccelerationPreference = 'prefer-hardware' | 'prefer-software';

type VideoDecoderConfigWithAcceleration = VideoDecoderConfig & {
  hardwareAcceleration?: HardwareAccelerationPreference;
};

type DecodeSupportResult = {
  supported: boolean;
  hardwareAccelerationParamSupported: boolean;
};

type CodecDecodeResult = {
  supported: boolean;
  hwHint?: boolean;
};

const DEFAULT_EXTENDED_CAPS: ExtendedCapabilities = {
  // Base capabilities (from VideoCapabilities)
  h264: false,
  hevc: false,
  av1: false,
  canvasWebpEncode: false,
  offscreenWebpEncode: false,
  webpEncode: false,
  hardwareAccelerated: false,

  // Extended codec support
  vp8: false,
  vp9: false,

  // Encoder capabilities
  gifEncode: true, // Always true (modern-gif WASM)
  mp4Encode: false,

  // Environment features
  sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true,
  workerSupport: typeof Worker !== 'undefined',
  webcodecsDecode: false,
  offscreenCanvas: typeof OffscreenCanvas !== 'undefined',

  // Performance indicators
  hardwareDecodeCores: undefined,
  estimatedMemoryMB: undefined,

  // Detection metadata
  detectedAt: 0,
  detectionVersion: DETECTION_VERSION,
};

class ExtendedCapabilityService {
  private cached: ExtendedCapabilities | null = null;

  /**
   * Get cached capabilities (in-memory, localStorage, or defaults).
   *
   * This method is synchronous and never probes Web APIs.
   */
  getCached(): ExtendedCapabilities {
    if (this.cached) {
      return this.cached;
    }

    const fromStorage = this.readFromStorage();
    if (fromStorage) {
      this.cached = fromStorage;
      return fromStorage;
    }

    this.cached = { ...DEFAULT_EXTENDED_CAPS };
    return this.cached;
  }

  /**
   * Probe runtime capabilities and persist results.
   *
   * Detects H.264, HEVC, AV1, VP8, VP9 decode support,
   * GIF/WebP/MP4 encode support, and environment features.
   *
   * @returns Promise resolving to extended capabilities
   */
  async detectCapabilities(): Promise<ExtendedCapabilities> {
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

    logger.info('general', '[ExtendedVideoCaps] detected', caps);

    return caps;
  }

  /**
   * Clear cached capabilities (force re-detection)
   */
  clearCache(): void {
    this.cached = null;

    if (!this.canUseStorage()) {
      return;
    }

    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      logger.warn('general', 'Failed to clear extended capability cache', {
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Expose capabilities on window for debugging (dev mode only)
   */
  private exposeToWindow(caps: ExtendedCapabilities): void {
    if (!this.hasWindow()) {
      return;
    }

    try {
      if (import.meta.env.DEV) {
        window.__EXTENDED_VIDEO_CAPS__ = caps;
      }
    } catch (error) {
      logger.warn('general', 'Failed to expose window.__EXTENDED_VIDEO_CAPS__ (non-critical)', {
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Read capabilities from localStorage with validation
   */
  private readFromStorage(): ExtendedCapabilities | null {
    if (!this.canUseStorage()) {
      return null;
    }

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as CachedExtendedCapabilities;

      if (!this.isCacheValid(parsed)) {
        logger.debug('general', 'Extended capability cache invalid, will re-detect', {
          reason: this.getCacheInvalidReason(parsed),
        });
        window.localStorage.removeItem(STORAGE_KEY);
        return null;
      }

      return parsed.capabilities;
    } catch (error) {
      logger.warn('general', 'Failed to read cached extended caps (non-critical)', {
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  /**
   * Write capabilities to localStorage
   */
  private writeToStorage(caps: ExtendedCapabilities): void {
    if (!this.canUseStorage()) {
      return;
    }

    try {
      const now = Date.now();
      const cached: CachedExtendedCapabilities = {
        capabilities: caps,
        version: DETECTION_VERSION,
        storedAt: now,
        expiresAt: now + TTL_MS,
        hardwareProfileHash: this.getHardwareProfileHash(),
      };

      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
    } catch (error) {
      logger.warn('general', 'Failed to write cached extended caps (non-critical)', {
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Check if cached data is still valid
   */
  private isCacheValid(cached: CachedExtendedCapabilities): boolean {
    if (cached.version !== DETECTION_VERSION) {
      return false;
    }

    if (Date.now() > cached.expiresAt) {
      return false;
    }

    if (cached.hardwareProfileHash !== this.getHardwareProfileHash()) {
      return false;
    }

    if (!isHardwareCacheValid()) {
      return false;
    }

    return true;
  }

  /**
   * Get reason why cache is invalid (for logging)
   */
  private getCacheInvalidReason(cached: CachedExtendedCapabilities): string {
    if (cached.version !== DETECTION_VERSION) {
      return `version mismatch (cached: ${cached.version}, current: ${DETECTION_VERSION})`;
    }

    if (Date.now() > cached.expiresAt) {
      return `TTL expired (cached: ${new Date(cached.expiresAt).toISOString()})`;
    }

    if (cached.hardwareProfileHash !== this.getHardwareProfileHash()) {
      return 'hardware profile changed';
    }

    if (!isHardwareCacheValid()) {
      return 'hardware cache invalid';
    }

    return 'unknown reason';
  }

  /**
   * Get hardware profile hash for cache validation
   */
  private getHardwareProfileHash(): string {
    if (typeof navigator === 'undefined') {
      return 'server';
    }

    const cores = navigator.hardwareConcurrency || 0;
    const ua = navigator.userAgent.substring(0, 50);

    return `${cores}:${ua}`;
  }

  /**
   * Probe all capabilities
   */
  private async probe(): Promise<ExtendedCapabilities> {
    if (!this.hasWindow()) {
      return { ...DEFAULT_EXTENDED_CAPS };
    }

    const baseCaps = await capabilityService.detectCapabilities();

    const vp8 = await this.probeCodecDecode('vp8');
    const vp9 = await this.probeCodecDecode('vp09.00.10.08');

    const gifEncode = true;
    const mp4Encode = await this.testMP4Encode();

    const sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
    const crossOriginIsolated =
      typeof window.crossOriginIsolated !== 'undefined' && window.crossOriginIsolated === true;
    const workerSupport = typeof Worker !== 'undefined';
    const webcodecsDecode = isWebCodecsDecodeSupported();
    const offscreenCanvas = typeof OffscreenCanvas !== 'undefined';

    const hardwareDecodeCores = navigator.hardwareConcurrency;
    const estimatedMemoryMB = this.estimateMemory();

    const caps: ExtendedCapabilities = {
      ...baseCaps,
      vp8: vp8.supported,
      vp9: vp9.supported,
      gifEncode,
      mp4Encode,
      sharedArrayBuffer,
      crossOriginIsolated,
      workerSupport,
      webcodecsDecode,
      offscreenCanvas,
      hardwareDecodeCores,
      estimatedMemoryMB,
      detectedAt: Date.now(),
      detectionVersion: DETECTION_VERSION,
    };

    if (typeof vp8.hwHint === 'boolean') {
      caps.vp8HardwareDecode = vp8.hwHint;
    }
    if (typeof vp9.hwHint === 'boolean') {
      caps.vp9HardwareDecode = vp9.hwHint;
    }

    return caps;
  }

  private createBaseDecodeConfig(codec: string): VideoDecoderConfig {
    return {
      codec,
      codedWidth: 640,
      codedHeight: 360,
    };
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

  private async probeCodecDecode(codec: string): Promise<CodecDecodeResult> {
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

  /**
   * Test MP4 encoder availability (WebAV)
   */
  private async testMP4Encode(): Promise<boolean> {
    try {
      // Dynamic import to avoid circular dependencies
      const { createWebAVMP4Service } = await import('@services/webav/webav-mp4-service');
      const service = createWebAVMP4Service();
      return await service.isAvailable();
    } catch (error) {
      logger.debug('general', 'WebAV MP4 encoder test failed', {
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  /**
   * Estimate available memory in MB
   */
  private estimateMemory(): number | undefined {
    if (typeof navigator === 'undefined') {
      return undefined;
    }

    const performanceMemory = (
      performance as Performance & { memory?: { jsHeapSizeLimit?: number } }
    ).memory;
    if (performanceMemory?.jsHeapSizeLimit) {
      return Math.round(performanceMemory.jsHeapSizeLimit / (1024 * 1024));
    }

    const cores = navigator.hardwareConcurrency || 2;
    if (cores >= 8) {
      return 4096;
    }
    if (cores >= 4) {
      return 2048;
    }
    return 1024;
  }

  private hasWindow(): boolean {
    return typeof window !== 'undefined';
  }

  private canUseStorage(): boolean {
    return this.hasWindow() && typeof window.localStorage !== 'undefined';
  }

  private canProbeVideoDecoder(): boolean {
    return (
      this.hasWindow() &&
      typeof VideoDecoder !== 'undefined' &&
      typeof VideoDecoder.isConfigSupported === 'function'
    );
  }
}

export const extendedCapabilityService = createSingleton(
  'ExtendedCapabilityService',
  () => new ExtendedCapabilityService()
);
