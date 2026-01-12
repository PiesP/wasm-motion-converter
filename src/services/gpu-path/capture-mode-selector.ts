/**
 * Capture Mode Selector
 *
 * Automatically selects the best capture mode for given file and browser capabilities.
 * Manages fallback chain: demuxer → track → frame-callback → seek
 *
 * Features:
 * - Browser capability detection
 * - Codec-aware mode selection
 * - Session-scoped performance caching
 * - Automatic fallback handling
 */

import type { VideoMetadata } from "@t/conversion-types";
import { logger } from "@utils/logger";
import { canUseDemuxer } from "@services/webcodecs/demuxer/demuxer-factory";
import { getWebCodecsSupportStatus } from "@services/webcodecs-support-service";
import type { CaptureMode } from "./types";

/**
 * Browser capabilities for capture modes
 */
export interface CaptureModeCapabilities {
  /** Demuxer-based capture available */
  demuxer: boolean;
  /** Track processor available */
  trackProcessor: boolean;
  /** Frame callback API available */
  frameCallback: boolean;
  /** Seek-based capture (always available) */
  seek: boolean;
}

/**
 * Capture mode selection result
 */
export interface CaptureModeSelection {
  /** Selected capture mode */
  mode: CaptureMode;
  /** Reason for selection */
  reason: string;
  /** Available fallback modes (in order) */
  fallbacks: CaptureMode[];
}

/**
 * Session cache for capture mode performance
 *
 * Tracks which modes work well for specific codecs/containers
 */
class CaptureModePerformanceCache {
  private successfulModes = new Map<string, CaptureMode>();

  /**
   * Get cache key for file and codec
   */
  private getCacheKey(file: File, codec?: string): string {
    const container = file.name.split(".").pop()?.toLowerCase() ?? "unknown";
    const codecKey = codec?.toLowerCase() ?? "unknown";
    return `${container}:${codecKey}`;
  }

  /**
   * Record successful capture mode
   */
  recordSuccess(file: File, mode: CaptureMode, codec?: string): void {
    const key = this.getCacheKey(file, codec);
    this.successfulModes.set(key, mode);
    logger.debug("capture-mode-selector", "Cached successful mode", {
      key,
      mode,
    });
  }

  /**
   * Get previously successful mode
   */
  getSuccessfulMode(file: File, codec?: string): CaptureMode | null {
    const key = this.getCacheKey(file, codec);
    const mode = this.successfulModes.get(key);
    return mode !== undefined ? mode : null;
  }

  /**
   * Clear cache
   */
  clear(): void {
    this.successfulModes.clear();
  }
}

/**
 * Global performance cache
 */
const performanceCache = new CaptureModePerformanceCache();

/**
 * Capture mode selector
 */
export class CaptureModeSelector {
  private capabilities: CaptureModeCapabilities;

  constructor() {
    this.capabilities = this.detectCapabilities();
  }

  /**
   * Detect browser capabilities for capture modes
   */
  private detectCapabilities(): CaptureModeCapabilities {
    const support = getWebCodecsSupportStatus();

    const supportsFrameCallback =
      typeof HTMLVideoElement !== "undefined" &&
      typeof (
        HTMLVideoElement.prototype as { requestVideoFrameCallback?: unknown }
      ).requestVideoFrameCallback === "function";

    const capabilities: CaptureModeCapabilities = {
      demuxer: typeof VideoDecoder !== "undefined", // Basic requirement
      trackProcessor: support.trackProcessor && support.captureStream,
      frameCallback: supportsFrameCallback,
      seek: true, // Always available
    };

    logger.info(
      "capture-mode-selector",
      "Detected capture mode capabilities",
      capabilities
    );

    return capabilities;
  }

  /**
   * Select best capture mode for file
   *
   * Selection priority:
   * 1. Check cache for previously successful mode
   * 2. Demuxer (fastest for complex codecs like AV1/HEVC/VP9)
   * 3. Track processor (hardware-accelerated, experimental)
   * 4. Frame callback (Chrome/Edge, precise timing)
   * 5. Seek (universal fallback)
   *
   * @param file - Video file
   * @param requestedMode - Optional mode override ('auto' for auto-selection)
   * @param metadata - Optional video metadata (codec info)
   * @returns Capture mode selection result
   */
  selectMode(
    file: File,
    requestedMode: CaptureMode = "auto",
    metadata?: VideoMetadata
  ): CaptureModeSelection {
    // If specific mode requested (not 'auto'), validate and return
    if (requestedMode !== "auto") {
      return this.validateRequestedMode(requestedMode);
    }

    // Check cache for previously successful mode
    const cachedMode = performanceCache.getSuccessfulMode(
      file,
      metadata?.codec
    );
    if (cachedMode && this.isModeAvailable(cachedMode, file, metadata)) {
      logger.info("capture-mode-selector", "Using cached successful mode", {
        mode: cachedMode,
        codec: metadata?.codec,
      });
      return {
        mode: cachedMode,
        reason: "Previously successful (cached)",
        fallbacks: this.getFallbackChain(cachedMode),
      };
    }

    // Priority 1: Demuxer (eliminates seeking overhead for complex codecs)
    if (this.capabilities.demuxer && canUseDemuxer(file, metadata)) {
      const codec = metadata?.codec?.toLowerCase() ?? "unknown";
      const isComplexCodec =
        codec.includes("av1") ||
        codec.includes("av01") ||
        codec.includes("hevc") ||
        codec.includes("hvc1") ||
        codec.includes("vp9") ||
        codec.includes("vp09");

      if (isComplexCodec) {
        logger.info(
          "capture-mode-selector",
          "Selected demuxer mode for complex codec",
          {
            codec,
            container: file.name.split(".").pop(),
          }
        );
        return {
          mode: "demuxer",
          reason: `Complex codec (${codec}) benefits from demuxer path`,
          fallbacks: ["track", "frame-callback", "seek"],
        };
      }
    }

    // Priority 2: Track processor (experimental, hardware-accelerated)
    if (this.capabilities.trackProcessor) {
      return {
        mode: "track",
        reason: "Track processor available (hardware-accelerated)",
        fallbacks: ["frame-callback", "seek"],
      };
    }

    // Priority 3: Frame callback (Chrome/Edge, precise timing)
    if (this.capabilities.frameCallback) {
      return {
        mode: "frame-callback",
        reason: "requestVideoFrameCallback available",
        fallbacks: ["seek"],
      };
    }

    // Priority 4: Seek (universal fallback)
    return {
      mode: "seek",
      reason: "Universal fallback (all browsers)",
      fallbacks: [],
    };
  }

  /**
   * Validate requested (non-auto) mode
   */
  private validateRequestedMode(mode: CaptureMode): CaptureModeSelection {
    if (mode === "demuxer") {
      if (!this.capabilities.demuxer) {
        throw new Error(
          "Demuxer mode requested but VideoDecoder API not available"
        );
      }
      return {
        mode: "demuxer",
        reason: "Explicitly requested",
        fallbacks: [],
      };
    }

    if (mode === "track") {
      if (!this.capabilities.trackProcessor) {
        throw new Error("Track processor mode requested but not available");
      }
      return {
        mode: "track",
        reason: "Explicitly requested",
        fallbacks: ["frame-callback", "seek"],
      };
    }

    if (mode === "frame-callback") {
      if (!this.capabilities.frameCallback) {
        throw new Error("Frame callback mode requested but not available");
      }
      return {
        mode: "frame-callback",
        reason: "Explicitly requested",
        fallbacks: ["seek"],
      };
    }

    if (mode === "seek") {
      return {
        mode: "seek",
        reason: "Explicitly requested",
        fallbacks: [],
      };
    }

    throw new Error(`Unknown capture mode: ${mode}`);
  }

  /**
   * Check if specific mode is available for file
   */
  private isModeAvailable(
    mode: CaptureMode,
    file: File,
    metadata?: VideoMetadata
  ): boolean {
    switch (mode) {
      case "demuxer":
        return this.capabilities.demuxer && canUseDemuxer(file, metadata);
      case "track":
        return this.capabilities.trackProcessor;
      case "frame-callback":
        return this.capabilities.frameCallback;
      case "seek":
        return true;
      default:
        return false;
    }
  }

  /**
   * Get fallback chain for given mode
   */
  private getFallbackChain(mode: CaptureMode): CaptureMode[] {
    switch (mode) {
      case "demuxer":
        return ["track", "frame-callback", "seek"];
      case "track":
        return ["frame-callback", "seek"];
      case "frame-callback":
        return ["seek"];
      case "seek":
        return [];
      default:
        return ["seek"];
    }
  }

  /**
   * Get next fallback mode
   *
   * @param currentMode - Current mode that failed
   * @returns Next fallback mode or null if no fallbacks available
   */
  getNextFallback(currentMode: CaptureMode): CaptureMode | null {
    const fallbacks = this.getFallbackChain(currentMode);
    if (fallbacks.length === 0) {
      return null;
    }

    const nextMode = fallbacks[0];
    if (!nextMode) {
      return null;
    }

    logger.info("capture-mode-selector", "Falling back to next mode", {
      from: currentMode,
      to: nextMode,
    });

    return nextMode;
  }

  /**
   * Record successful capture mode for future optimizations
   */
  recordSuccess(file: File, mode: CaptureMode, metadata?: VideoMetadata): void {
    performanceCache.recordSuccess(file, mode, metadata?.codec);
  }

  /**
   * Get browser capabilities
   */
  getCapabilities(): CaptureModeCapabilities {
    return { ...this.capabilities };
  }

  /**
   * Clear performance cache
   */
  clearCache(): void {
    performanceCache.clear();
  }
}

/**
 * Global capture mode selector instance
 */
export const captureModeSelector = new CaptureModeSelector();
