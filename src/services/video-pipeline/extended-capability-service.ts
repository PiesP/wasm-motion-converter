/**
 * Extended Capability Service
 *
 * Comprehensive capability detection including VP8/VP9 codecs, encoders,
 * and environment features. Builds upon the base CapabilityService.
 *
 * Cache locations:
 * - localStorage["extended_video_caps_v2"]
 * - window.__EXTENDED_VIDEO_CAPS__ (dev mode)
 *
 * TTL: 7 days
 * Invalidation: hardware profile change, version bump, TTL expiry
 */

import type { ExtendedCapabilities } from '@t/video-pipeline-types';
import { capabilityService } from '@services/video-pipeline/capability-service';
import { isHardwareCacheValid } from '@utils/hardware-profile';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

const STORAGE_KEY = 'extended_video_caps_v2' as const;
const DETECTION_VERSION = 2 as const;
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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

type VideoDecoderConfigWithAcceleration = VideoDecoderConfig & {
  hardwareAcceleration?: 'prefer-hardware' | 'prefer-software';
};

const DEFAULT_EXTENDED_CAPS: ExtendedCapabilities = {
  // Base capabilities (from VideoCapabilities)
  h264: false,
  hevc: false,
  av1: false,
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

  // Performance indicators
  hardwareDecodeCores: undefined,
  estimatedMemoryMB: undefined,

  // Detection metadata
  detectedAt: 0,
  detectionVersion: DETECTION_VERSION,
};

class ExtendedCapabilityService {
  private static instance: ExtendedCapabilityService | null = null;

  static getInstance(): ExtendedCapabilityService {
    ExtendedCapabilityService.instance ??= new ExtendedCapabilityService();
    return ExtendedCapabilityService.instance;
  }

  private cached: ExtendedCapabilities | null = null;

  // Enforce singleton
  private constructor() {}

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
    // Check cache first
    if (this.cached) {
      return this.cached;
    }

    const cached = this.readFromStorage();
    if (cached) {
      this.cached = cached;
      this.exposeToWindow(cached);
      return cached;
    }

    // Probe capabilities
    const caps = await this.probe();

    // Cache results
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
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch (error) {
        logger.warn('general', 'Failed to clear extended capability cache', {
          error: getErrorMessage(error),
        });
      }
    }
  }

  /**
   * Expose capabilities on window for debugging (dev mode only)
   */
  private exposeToWindow(caps: ExtendedCapabilities): void {
    if (typeof window === 'undefined') {
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
    if (typeof window === 'undefined') {
      return null;
    }

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as CachedExtendedCapabilities;

      // Validate cache
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
    if (typeof window === 'undefined') {
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
    // Check version
    if (cached.version !== DETECTION_VERSION) {
      return false;
    }

    // Check TTL
    if (Date.now() > cached.expiresAt) {
      return false;
    }

    // Check hardware profile
    if (cached.hardwareProfileHash !== this.getHardwareProfileHash()) {
      return false;
    }

    // Check if hardware cache is valid (from existing hardware-profile.ts)
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

    // Simple hash based on hardware concurrency and user agent
    const cores = navigator.hardwareConcurrency || 0;
    const ua = navigator.userAgent.substring(0, 50); // Truncate for storage efficiency

    return `${cores}:${ua}`;
  }

  /**
   * Probe all capabilities
   */
  private async probe(): Promise<ExtendedCapabilities> {
    if (typeof window === 'undefined') {
      return { ...DEFAULT_EXTENDED_CAPS };
    }

    // Get base capabilities from existing service
    const baseCaps = await capabilityService.detectCapabilities();

    // Test VP8/VP9 decode support
    const vp8 = await this.testDecode({
      codec: 'vp8',
      prefer: 'prefer-software',
    });
    const vp9Hw = await this.testDecode({
      codec: 'vp09.00.10.08',
      prefer: 'prefer-hardware',
    });
    const vp9Sw = vp9Hw
      ? true
      : await this.testDecode({
          codec: 'vp09.00.10.08',
          prefer: 'prefer-software',
        });

    // Test encoder availability
    const gifEncode = true; // Always true (modern-gif WASM)
    const mp4Encode = await this.testMP4Encode();

    // Environment detection
    const sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
    const crossOriginIsolated =
      typeof window.crossOriginIsolated !== 'undefined' && window.crossOriginIsolated === true;
    const workerSupport = typeof Worker !== 'undefined';

    // Performance indicators
    const hardwareDecodeCores = navigator.hardwareConcurrency;
    const estimatedMemoryMB = this.estimateMemory();

    const caps: ExtendedCapabilities = {
      // Base capabilities
      ...baseCaps,

      // Extended codec support
      vp8,
      vp9: vp9Sw,

      // Encoder capabilities
      gifEncode,
      mp4Encode,

      // Environment features
      sharedArrayBuffer,
      crossOriginIsolated,
      workerSupport,

      // Performance indicators
      hardwareDecodeCores,
      estimatedMemoryMB,

      // Detection metadata
      detectedAt: Date.now(),
      detectionVersion: DETECTION_VERSION,
    };

    return caps;
  }

  /**
   * Test video decode support for a given codec
   */
  private async testDecode(params: {
    codec: string;
    prefer: 'prefer-hardware' | 'prefer-software';
  }): Promise<boolean> {
    if (
      typeof VideoDecoder === 'undefined' ||
      typeof VideoDecoder.isConfigSupported !== 'function'
    ) {
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

    // Check for performance.memory (non-standard, Chrome only)
    const performanceMemory = (
      performance as Performance & { memory?: { jsHeapSizeLimit?: number } }
    ).memory;
    if (performanceMemory?.jsHeapSizeLimit) {
      return Math.round(performanceMemory.jsHeapSizeLimit / (1024 * 1024));
    }

    // Fallback: Estimate based on device class
    const cores = navigator.hardwareConcurrency || 2;
    if (cores >= 8) {
      return 4096; // High-end device
    } else if (cores >= 4) {
      return 2048; // Mid-range device
    } else {
      return 1024; // Low-end device
    }
  }
}

export const extendedCapabilityService = ExtendedCapabilityService.getInstance();
