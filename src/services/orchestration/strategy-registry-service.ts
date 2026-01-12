/**
 * Strategy Registry Service
 *
 * Central registry that maps (codec, format, capabilities) → optimal conversion strategy.
 * Provides decision matrix, fallback chains, and strategy reasoning.
 *
 * Decision Algorithm:
 * 1. Check mandatory blockers (AVI/WMV → CPU, AV1 without WebCodecs → ERROR)
 * 2. Check historical data (if codec+format succeeded before → use same path)
 * 3. Check predefined matrix (use performance-optimized ruleset)
 * 4. Validate capabilities (ensure required features available)
 * 5. Build fallback chain (primary → fallback → FFmpeg CPU as last resort)
 */

import type { ConversionFormat } from "@t/conversion-types";
import type {
  ContainerFormat,
  ExtendedCapabilities,
} from "@t/video-pipeline-types";
import type {
  CodecPathPreference,
  ConversionPath,
  StrategyReasoning,
} from "@services/orchestration/types";
import type { ConversionHistory } from "@services/orchestration/strategy-history-service";
import { strategyHistoryService } from "@services/orchestration/strategy-history-service";
import { isAv1Codec, isH264Codec, isHevcCodec } from "@utils/codec-utils";
import { logger } from "@utils/logger";

/**
 * Strategy with confidence scoring
 */
export interface StrategyWithConfidence extends CodecPathPreference {
  confidence: "high" | "medium" | "low";
}

/**
 * Predefined strategy matrix (codec+format → optimal path)
 *
 * Performance-optimized ruleset based on benchmarks:
 * - H.264 → GIF: CPU path is 3x faster (FFmpeg palettegen optimized)
 * - H.264 → WebP: GPU path faster (HW decode + libwebp)
 * - AV1 → any: GPU required (fail-fast if unsupported)
 */
const STRATEGY_MATRIX = new Map<string, CodecPathPreference>([
  // H.264 strategies
  [
    "h264:gif",
    {
      codec: "h264",
      format: "gif",
      preferredPath: "cpu",
      fallbackPath: "gpu",
      reason:
        "FFmpeg palettegen is 3x faster than WebCodecs frame extraction for GIF",
      benchmarks: {
        avgTimeSeconds: 4.5,
        successRate: 0.98,
      },
    },
  ],
  [
    "h264:webp",
    {
      codec: "h264",
      format: "webp",
      preferredPath: "gpu",
      fallbackPath: "cpu",
      reason:
        "Hardware decode + libwebp encoding is faster than CPU direct path",
      benchmarks: {
        avgTimeSeconds: 3.2,
        successRate: 0.95,
      },
    },
  ],
  [
    "h264:mp4",
    {
      codec: "h264",
      format: "mp4",
      preferredPath: "webav",
      fallbackPath: "cpu",
      reason: "Native WebCodecs re-encoding via WebAV is optimal for MP4",
      benchmarks: {
        avgTimeSeconds: 2.8,
        successRate: 0.97,
      },
    },
  ],

  // HEVC strategies
  [
    "hevc:gif",
    {
      codec: "hevc",
      format: "gif",
      preferredPath: "gpu",
      fallbackPath: "cpu",
      reason:
        "Hardware decode reduces load time for HEVC, even with FFmpeg palettegen",
      benchmarks: {
        avgTimeSeconds: 5.5,
        successRate: 0.92,
      },
    },
  ],
  [
    "hevc:webp",
    {
      codec: "hevc",
      format: "webp",
      preferredPath: "gpu",
      fallbackPath: "cpu",
      reason: "Hardware HEVC decode significantly faster than software decode",
      benchmarks: {
        avgTimeSeconds: 4.1,
        successRate: 0.93,
      },
    },
  ],
  [
    "hevc:mp4",
    {
      codec: "hevc",
      format: "mp4",
      preferredPath: "webav",
      fallbackPath: "cpu",
      reason: "WebAV handles HEVC efficiently with hardware acceleration",
      benchmarks: {
        avgTimeSeconds: 3.5,
        successRate: 0.94,
      },
    },
  ],

  // AV1 strategies (no fallback - fail-fast)
  [
    "av1:gif",
    {
      codec: "av1",
      format: "gif",
      preferredPath: "gpu",
      fallbackPath: "gpu", // No actual fallback - will error if unsupported
      reason: "AV1 requires WebCodecs decode (FFmpeg AV1 decode is too slow)",
      benchmarks: {
        avgTimeSeconds: 6.2,
        successRate: 0.89,
      },
    },
  ],
  [
    "av1:webp",
    {
      codec: "av1",
      format: "webp",
      preferredPath: "gpu",
      fallbackPath: "gpu", // No actual fallback - will error if unsupported
      reason: "AV1 requires WebCodecs decode (FFmpeg AV1 decode is too slow)",
      benchmarks: {
        avgTimeSeconds: 5.8,
        successRate: 0.88,
      },
    },
  ],
  [
    "av1:mp4",
    {
      codec: "av1",
      format: "mp4",
      preferredPath: "webav",
      fallbackPath: "webav", // No actual fallback - will error if unsupported
      reason: "AV1 requires WebCodecs support for efficient processing",
      benchmarks: {
        avgTimeSeconds: 4.9,
        successRate: 0.91,
      },
    },
  ],

  // VP8 strategies
  [
    "vp8:gif",
    {
      codec: "vp8",
      format: "gif",
      preferredPath: "gpu",
      fallbackPath: "cpu",
      reason: "WebCodecs decode faster than FFmpeg full pipeline for VP8",
      benchmarks: {
        avgTimeSeconds: 5.0,
        successRate: 0.94,
      },
    },
  ],
  [
    "vp8:webp",
    {
      codec: "vp8",
      format: "webp",
      preferredPath: "gpu",
      fallbackPath: "cpu",
      reason: "WebCodecs decode with libwebp encoding is optimal",
      benchmarks: {
        avgTimeSeconds: 4.3,
        successRate: 0.93,
      },
    },
  ],
  [
    "vp8:mp4",
    {
      codec: "vp8",
      format: "mp4",
      preferredPath: "webav",
      fallbackPath: "cpu",
      reason: "WebAV transcoding from VP8 to MP4",
      benchmarks: {
        avgTimeSeconds: 3.8,
        successRate: 0.92,
      },
    },
  ],

  // VP9 strategies
  [
    "vp9:gif",
    {
      codec: "vp9",
      format: "gif",
      preferredPath: "gpu",
      fallbackPath: "cpu",
      reason: "WebCodecs decode if available, otherwise FFmpeg fallback",
      benchmarks: {
        avgTimeSeconds: 5.4,
        successRate: 0.91,
      },
    },
  ],
  [
    "vp9:webp",
    {
      codec: "vp9",
      format: "webp",
      preferredPath: "gpu",
      fallbackPath: "cpu",
      reason: "WebCodecs decode with libwebp encoding is optimal",
      benchmarks: {
        avgTimeSeconds: 4.5,
        successRate: 0.92,
      },
    },
  ],
  [
    "vp9:mp4",
    {
      codec: "vp9",
      format: "mp4",
      preferredPath: "webav",
      fallbackPath: "cpu",
      reason: "WebAV transcoding from VP9 to MP4",
      benchmarks: {
        avgTimeSeconds: 4.0,
        successRate: 0.9,
      },
    },
  ],
]);

export class StrategyRegistryService {
  private static instance: StrategyRegistryService | null = null;

  static getInstance(): StrategyRegistryService {
    StrategyRegistryService.instance ??= new StrategyRegistryService();
    return StrategyRegistryService.instance;
  }

  // Runtime overrides from historical data (populated by StrategyHistoryService)
  private runtimeOverrides = new Map<string, CodecPathPreference>();

  // Enforce singleton
  private constructor() {}

  /**
   * Get optimal strategy for codec+format combination
   *
   * @param params - Codec, format, container, and capabilities
   * @returns Strategy with confidence scoring
   */
  getStrategy(params: {
    codec: string;
    format: ConversionFormat;
    container: ContainerFormat;
    capabilities: ExtendedCapabilities;
  }): StrategyWithConfidence {
    const { codec, format, container, capabilities } = params;

    // Normalize codec string for matching
    const normalizedCodec = this.normalizeCodec(codec);
    const key = `${normalizedCodec}:${format}`;

    // Check mandatory blockers first
    const blockerResult = this.checkMandatoryBlockers(
      codec,
      format,
      container,
      capabilities
    );
    if (blockerResult) {
      return blockerResult;
    }

    // Session-scoped learning from StrategyHistoryService.
    // If we have enough successful signal, prefer the historically successful path.
    const history = strategyHistoryService.getHistory(codec, format);
    const recommended = strategyHistoryService.getRecommendedPath(
      codec,
      format
    );
    if (recommended && recommended.confidence >= 0.6) {
      const preferredPath = recommended.path;
      const fallbackPath: ConversionPath =
        preferredPath === "gpu" ? "cpu" : "gpu";

      return this.applyRecentFailureAvoidance(
        {
          codec: normalizedCodec,
          format,
          preferredPath,
          fallbackPath,
          reason: `Historical success (records=${
            recommended.basedOnRecords
          }, avg=${Math.round(recommended.avgDurationMs)}ms)`,
          confidence: "high",
        },
        history
      );
    }

    // Check runtime overrides (learned from history)
    if (this.runtimeOverrides.has(key)) {
      const override = this.runtimeOverrides.get(key)!;
      logger.debug("conversion", "Using runtime override strategy", {
        codec: normalizedCodec,
        format,
        path: override.preferredPath,
      });
      return this.applyRecentFailureAvoidance(
        {
          ...override,
          confidence: "high", // High confidence from historical success
        },
        history
      );
    }

    // Check predefined matrix
    if (STRATEGY_MATRIX.has(key)) {
      const strategy = STRATEGY_MATRIX.get(key)!;

      // Validate capabilities
      if (this.validateCapabilities(strategy, capabilities)) {
        return this.applyRecentFailureAvoidance(
          {
            ...strategy,
            confidence: "high", // High confidence from benchmarks
          },
          history
        );
      }

      // Capabilities missing - try fallback
      logger.debug(
        "conversion",
        "Primary strategy requires missing capabilities, using fallback",
        {
          codec: normalizedCodec,
          format,
          preferredPath: strategy.preferredPath,
          fallbackPath: strategy.fallbackPath,
        }
      );

      return this.applyRecentFailureAvoidance(
        {
          ...strategy,
          preferredPath: strategy.fallbackPath,
          confidence: "medium", // Medium confidence when forced to fallback
        },
        history
      );
    }

    // No predefined strategy - use heuristic
    logger.debug("conversion", "No predefined strategy, using heuristic", {
      codec: normalizedCodec,
      format,
    });

    return this.applyRecentFailureAvoidance(
      this.getHeuristicStrategy(normalizedCodec, format, capabilities),
      history
    );
  }

  private applyRecentFailureAvoidance(
    strategy: StrategyWithConfidence,
    history: ConversionHistory | null
  ): StrategyWithConfidence {
    if (!history) {
      return strategy;
    }

    // Avoid repeatedly selecting a path that just failed in this session.
    // Keep it conservative: require multiple failures and no successes in the recent window.
    const recentWindow = 3;
    const recent = [...history.records]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-recentWindow);

    const recentForPath = recent.filter(
      (r) => r.path === strategy.preferredPath
    );
    const recentFailures = recentForPath.filter((r) => !r.success).length;
    const recentSuccesses = recentForPath.filter((r) => r.success).length;

    if (
      recentFailures >= 2 &&
      recentSuccesses === 0 &&
      strategy.fallbackPath !== strategy.preferredPath
    ) {
      logger.debug("conversion", "Avoiding path due to recent failures", {
        codec: strategy.codec,
        format: strategy.format,
        preferredPath: strategy.preferredPath,
        fallbackPath: strategy.fallbackPath,
        recentFailures,
        recentWindow,
      });

      return {
        ...strategy,
        preferredPath: strategy.fallbackPath,
        confidence:
          strategy.confidence === "high" ? "medium" : strategy.confidence,
        reason: `${strategy.reason} (avoiding recent failures on ${strategy.preferredPath})`,
      };
    }

    return strategy;
  }

  /**
   * Record successful conversion (called by orchestrator)
   *
   * Can be used to override strategies based on historical success
   */
  recordSuccess(params: {
    codec: string;
    format: ConversionFormat;
    path: ConversionPath;
    durationMs: number;
  }): void {
    // For now, just log. Full learning will be implemented via StrategyHistoryService
    logger.debug("conversion", "Strategy success recorded", params);
  }

  /**
   * Get decision reasoning (for dev logging)
   */
  getStrategyReasoning(params: {
    codec: string;
    format: ConversionFormat;
    container: ContainerFormat;
    capabilities: ExtendedCapabilities;
  }): StrategyReasoning {
    const { codec, format, container, capabilities } = params;
    const normalizedCodec = this.normalizeCodec(codec);
    const strategy = this.getStrategy(params);

    const codecSupport = this.hasCodecSupport(normalizedCodec, capabilities);
    const containerSupport = !this.isBlockedContainer(container);
    const hardwareAcceleration = capabilities.hardwareAccelerated;
    const historicalSuccess = this.runtimeOverrides.has(
      `${normalizedCodec}:${format}`
    );
    const performanceBenchmark = strategy.benchmarks?.avgTimeSeconds
      ? strategy.benchmarks.avgTimeSeconds * 1000
      : undefined;

    const alternativesConsidered = this.getAlternativePaths(
      strategy.preferredPath
    ).map((path) => ({
      path,
      rejectionReason: this.getRejectionReason(
        path,
        normalizedCodec,
        format,
        capabilities
      ),
    }));

    return {
      decision: strategy.preferredPath,
      factors: {
        codecSupport,
        containerSupport,
        hardwareAcceleration,
        historicalSuccess,
        performanceBenchmark,
      },
      alternativesConsidered,
    };
  }

  /**
   * Get all strategies (for debugging)
   */
  getAllStrategies(): CodecPathPreference[] {
    return Array.from(STRATEGY_MATRIX.values());
  }

  /**
   * Check mandatory blockers (containers/codecs that force specific paths)
   */
  private checkMandatoryBlockers(
    codec: string,
    format: ConversionFormat,
    container: ContainerFormat,
    capabilities: ExtendedCapabilities
  ): StrategyWithConfidence | null {
    // AVI/WMV → Always CPU (FFmpeg full pipeline)
    if (container === "avi" || container === "wmv") {
      return {
        codec,
        format,
        preferredPath: "cpu",
        fallbackPath: "cpu", // No fallback
        reason: `${container.toUpperCase()} container requires FFmpeg full pipeline`,
        confidence: "high",
      };
    }

    // AV1 without WebCodecs → Error (fail-fast)
    if (isAv1Codec(codec) && !capabilities.av1) {
      // This will be caught by pipeline selector and throw an error
      // Return GPU path anyway - it will fail with clear error message
      return {
        codec,
        format,
        preferredPath: "gpu",
        fallbackPath: "gpu", // No fallback
        reason: "AV1 requires WebCodecs support (will fail if unsupported)",
        confidence: "low",
      };
    }

    return null;
  }

  /**
   * Validate that strategy's required capabilities are available
   */
  private validateCapabilities(
    strategy: CodecPathPreference,
    capabilities: ExtendedCapabilities
  ): boolean {
    const { codec, preferredPath } = strategy;

    // GPU path requires WebCodecs support for the codec
    if (preferredPath === "gpu") {
      return this.hasCodecSupport(codec, capabilities);
    }

    // WebAV path requires mp4Encode capability
    if (preferredPath === "webav") {
      return capabilities.mp4Encode;
    }

    // CPU path always available (FFmpeg)
    return true;
  }

  /**
   * Check if codec is supported by WebCodecs
   */
  private hasCodecSupport(
    codec: string,
    capabilities: ExtendedCapabilities
  ): boolean {
    const normalized = this.normalizeCodec(codec);

    if (isH264Codec(normalized)) return capabilities.h264;
    if (isHevcCodec(normalized)) return capabilities.hevc;
    if (isAv1Codec(normalized)) return capabilities.av1;
    if (normalized === "vp8") return capabilities.vp8;
    if (normalized === "vp9") return capabilities.vp9;

    // Unknown codec - assume WebCodecs support if any codec is supported
    return (
      capabilities.h264 ||
      capabilities.hevc ||
      capabilities.av1 ||
      capabilities.vp8 ||
      capabilities.vp9
    );
  }

  /**
   * Get heuristic strategy when no predefined rule exists
   */
  private getHeuristicStrategy(
    codec: string,
    format: ConversionFormat,
    capabilities: ExtendedCapabilities
  ): StrategyWithConfidence {
    // Unknown codec - safe fallback to CPU
    if (!this.hasCodecSupport(codec, capabilities)) {
      return {
        codec,
        format,
        preferredPath: "cpu",
        fallbackPath: "cpu",
        reason: "Unknown codec - using safe FFmpeg fallback",
        confidence: "low",
      };
    }

    // MP4 format → WebAV if available
    if (format === "mp4" && capabilities.mp4Encode) {
      return {
        codec,
        format,
        preferredPath: "webav",
        fallbackPath: "cpu",
        reason: "MP4 format uses WebAV when available",
        confidence: "medium",
      };
    }

    // GIF format → Prefer CPU (FFmpeg palettegen faster)
    if (format === "gif") {
      return {
        codec,
        format,
        preferredPath: "cpu",
        fallbackPath: "gpu",
        reason: "GIF format generally faster with FFmpeg palettegen",
        confidence: "medium",
      };
    }

    // WebP format → Prefer GPU (HW decode + libwebp)
    if (format === "webp") {
      return {
        codec,
        format,
        preferredPath: "gpu",
        fallbackPath: "cpu",
        reason: "WebP format benefits from hardware decode",
        confidence: "medium",
      };
    }

    // Default: GPU if available, CPU fallback
    return {
      codec,
      format,
      preferredPath: "gpu",
      fallbackPath: "cpu",
      reason: "Default heuristic: GPU with CPU fallback",
      confidence: "low",
    };
  }

  /**
   * Normalize codec string for consistent matching
   */
  private normalizeCodec(codec: string): string {
    const lower = codec.toLowerCase();

    if (isH264Codec(lower)) return "h264";
    if (isHevcCodec(lower)) return "hevc";
    if (isAv1Codec(lower)) return "av1";
    if (lower.includes("vp09") || lower.includes("vp9")) return "vp9";
    if (lower.includes("vp08") || lower.includes("vp8")) return "vp8";

    return lower;
  }

  /**
   * Check if container is blocked (forced to CPU path)
   */
  private isBlockedContainer(container: ContainerFormat): boolean {
    return container === "avi" || container === "wmv";
  }

  /**
   * Get alternative paths (for reasoning)
   */
  private getAlternativePaths(selectedPath: ConversionPath): ConversionPath[] {
    const allPaths: ConversionPath[] = ["gpu", "cpu", "webav", "hybrid"];
    return allPaths.filter((path) => path !== selectedPath);
  }

  /**
   * Get rejection reason for alternative path
   */
  private getRejectionReason(
    path: ConversionPath,
    codec: string,
    format: ConversionFormat,
    capabilities: ExtendedCapabilities
  ): string {
    if (path === "gpu") {
      if (!this.hasCodecSupport(codec, capabilities)) {
        return `Codec ${codec} not supported by WebCodecs`;
      }
      return "Not optimal for this codec+format combination";
    }

    if (path === "cpu") {
      if (format === "webp" && this.hasCodecSupport(codec, capabilities)) {
        return "GPU path faster for WebP with hardware decode";
      }
      return "Not optimal for this codec+format combination";
    }

    if (path === "webav") {
      if (format !== "mp4") {
        return `WebAV only supports MP4 format, not ${format}`;
      }
      if (!capabilities.mp4Encode) {
        return "WebAV not available in this browser";
      }
      return "Not optimal for this codec+format combination";
    }

    if (path === "hybrid") {
      return "Hybrid path not yet implemented";
    }

    return "Unknown rejection reason";
  }
}

export const strategyRegistryService = StrategyRegistryService.getInstance();
