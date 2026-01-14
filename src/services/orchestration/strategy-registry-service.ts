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

import type { ConversionFormat } from '@t/conversion-types';
import type { ContainerFormat, ExtendedCapabilities } from '@t/video-pipeline-types';
import type {
  CodecPathPreference,
  ConversionPath,
  StrategyReasoning,
} from '@services/orchestration/types';
import type { ConversionHistory } from '@services/orchestration/strategy-history-service';
import { strategyHistoryService } from '@services/orchestration/strategy-history-service';
import { createSingleton } from '@services/shared/singleton-service';
import { isAv1Codec, isH264Codec, isHevcCodec } from '@utils/codec-utils';
import { logger } from '@utils/logger';

/**
 * Strategy with confidence scoring
 */
interface StrategyWithConfidence extends CodecPathPreference {
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Predefined strategy matrix (codec+format → optimal path)
 *
 * Performance-optimized ruleset based on benchmarks:
 * - H.264 → GIF: Prefer GPU when hardware decode is available (CPU fallback remains fastest for some inputs)
 * - H.264 → WebP: GPU path faster (HW decode + libwebp)
 * - AV1 → any: GPU required (fail-fast if unsupported)
 */
const STRATEGY_MATRIX = new Map<string, CodecPathPreference>([
  // H.264 strategies
  [
    'h264:gif',
    {
      codec: 'h264',
      format: 'gif',
      preferredPath: 'cpu',
      fallbackPath: 'gpu',
      reason: 'FFmpeg palettegen is faster than WebCodecs frame extraction for GIF',
      benchmarks: {
        avgTimeSeconds: 4.5,
        successRate: 0.98,
      },
    },
  ],
  [
    'h264:webp',
    {
      codec: 'h264',
      format: 'webp',
      preferredPath: 'gpu',
      fallbackPath: 'cpu',
      reason: 'Hardware decode + libwebp encoding is faster than CPU direct path',
      benchmarks: {
        avgTimeSeconds: 3.2,
        successRate: 0.95,
      },
    },
  ],
  [
    'h264:mp4',
    {
      codec: 'h264',
      format: 'mp4',
      preferredPath: 'webav',
      fallbackPath: 'cpu',
      reason: 'Native WebCodecs re-encoding via WebAV is optimal for MP4',
      benchmarks: {
        avgTimeSeconds: 2.8,
        successRate: 0.97,
      },
    },
  ],

  // HEVC strategies
  [
    'hevc:gif',
    {
      codec: 'hevc',
      format: 'gif',
      preferredPath: 'gpu',
      fallbackPath: 'cpu',
      reason: 'Hardware decode reduces load time for HEVC, even with FFmpeg palettegen',
      benchmarks: {
        avgTimeSeconds: 5.5,
        successRate: 0.92,
      },
    },
  ],
  [
    'hevc:webp',
    {
      codec: 'hevc',
      format: 'webp',
      preferredPath: 'gpu',
      fallbackPath: 'cpu',
      reason: 'Hardware HEVC decode significantly faster than software decode',
      benchmarks: {
        avgTimeSeconds: 4.1,
        successRate: 0.93,
      },
    },
  ],
  [
    'hevc:mp4',
    {
      codec: 'hevc',
      format: 'mp4',
      preferredPath: 'webav',
      fallbackPath: 'cpu',
      reason: 'WebAV handles HEVC efficiently with hardware acceleration',
      benchmarks: {
        avgTimeSeconds: 3.5,
        successRate: 0.94,
      },
    },
  ],

  // AV1 strategies (CPU fallback for compatibility)
  [
    'av1:gif',
    {
      codec: 'av1',
      format: 'gif',
      preferredPath: 'gpu',
      fallbackPath: 'cpu', // CPU fallback available (slow but compatible)
      reason: 'AV1 prefers WebCodecs HW decode; falls back to FFmpeg CPU decode if unavailable',
      benchmarks: {
        avgTimeSeconds: 6.2,
        successRate: 0.89,
      },
    },
  ],
  [
    'av1:webp',
    {
      codec: 'av1',
      format: 'webp',
      preferredPath: 'gpu',
      fallbackPath: 'cpu', // CPU fallback available (slow but compatible)
      reason: 'AV1 prefers WebCodecs HW decode; falls back to FFmpeg CPU decode if unavailable',
      benchmarks: {
        avgTimeSeconds: 5.8,
        successRate: 0.88,
      },
    },
  ],
  [
    'av1:mp4',
    {
      codec: 'av1',
      format: 'mp4',
      preferredPath: 'webav',
      fallbackPath: 'cpu', // CPU fallback available (FFmpeg re-encode as last resort)
      reason: 'AV1 prefers WebAV; falls back to FFmpeg CPU transcode if unavailable',
      benchmarks: {
        avgTimeSeconds: 4.9,
        successRate: 0.91,
      },
    },
  ],

  // VP8 strategies
  [
    'vp8:gif',
    {
      codec: 'vp8',
      format: 'gif',
      preferredPath: 'cpu',
      fallbackPath: 'gpu',
      reason: 'FFmpeg palettegen is typically faster than WebCodecs for VP8 GIF',
      benchmarks: {
        avgTimeSeconds: 5.0,
        successRate: 0.94,
      },
    },
  ],
  [
    'vp8:webp',
    {
      codec: 'vp8',
      format: 'webp',
      preferredPath: 'gpu',
      fallbackPath: 'cpu',
      reason: 'WebCodecs decode with libwebp encoding is optimal',
      benchmarks: {
        avgTimeSeconds: 4.3,
        successRate: 0.93,
      },
    },
  ],
  [
    'vp8:mp4',
    {
      codec: 'vp8',
      format: 'mp4',
      preferredPath: 'webav',
      fallbackPath: 'cpu',
      reason: 'WebAV transcoding from VP8 to MP4',
      benchmarks: {
        avgTimeSeconds: 3.8,
        successRate: 0.92,
      },
    },
  ],

  // VP9 strategies
  [
    'vp9:gif',
    {
      codec: 'vp9',
      format: 'gif',
      preferredPath: 'cpu',
      fallbackPath: 'gpu',
      reason: 'FFmpeg palettegen is typically faster than WebCodecs for VP9 GIF',
      benchmarks: {
        avgTimeSeconds: 5.4,
        successRate: 0.91,
      },
    },
  ],
  [
    'vp9:webp',
    {
      codec: 'vp9',
      format: 'webp',
      preferredPath: 'gpu',
      fallbackPath: 'cpu',
      reason: 'WebCodecs decode with libwebp encoding is optimal',
      benchmarks: {
        avgTimeSeconds: 4.5,
        successRate: 0.92,
      },
    },
  ],
  [
    'vp9:mp4',
    {
      codec: 'vp9',
      format: 'mp4',
      preferredPath: 'webav',
      fallbackPath: 'cpu',
      reason: 'WebAV transcoding from VP9 to MP4',
      benchmarks: {
        avgTimeSeconds: 4.0,
        successRate: 0.9,
      },
    },
  ],
]);

class StrategyRegistryService {
  /**
   * History confidence threshold for adaptive path selection
   *
   * Minimum confidence required to use historical data for strategy selection.
   * Reduced from 0.6 to 0.4 to enable faster adaptation:
   * - 0.4 confidence ≈ 3 successful conversions
   * - 0.6 confidence ≈ 5 successful conversions
   *
   * Lower threshold allows system to learn optimal paths more quickly
   * while still requiring meaningful statistical signal.
   */
  private static readonly HISTORY_CONFIDENCE_THRESHOLD = 0.4;

  // Runtime overrides from historical data (populated by StrategyHistoryService)
  private runtimeOverrides = new Map<string, CodecPathPreference>();

  private getCodecHardwareDecodeHint(
    codec: string,
    capabilities: ExtendedCapabilities
  ): boolean | null {
    const normalized = this.normalizeCodec(codec);

    if (isH264Codec(normalized)) {
      return typeof capabilities.h264HardwareDecode === 'boolean'
        ? capabilities.h264HardwareDecode
        : null;
    }
    if (isHevcCodec(normalized)) {
      return typeof capabilities.hevcHardwareDecode === 'boolean'
        ? capabilities.hevcHardwareDecode
        : null;
    }
    if (isAv1Codec(normalized)) {
      return typeof capabilities.av1HardwareDecode === 'boolean'
        ? capabilities.av1HardwareDecode
        : null;
    }
    if (normalized === 'vp8') {
      return typeof capabilities.vp8HardwareDecode === 'boolean'
        ? capabilities.vp8HardwareDecode
        : null;
    }
    if (normalized === 'vp9') {
      return typeof capabilities.vp9HardwareDecode === 'boolean'
        ? capabilities.vp9HardwareDecode
        : null;
    }

    return null;
  }

  private shouldPreferGpuForGif(codec: string, capabilities: ExtendedCapabilities): boolean {
    const normalized = this.normalizeCodec(codec);

    // WebCodecs decode required for GPU path
    if (!capabilities.webcodecsDecode) {
      return false;
    }

    // Codec must be supported
    if (!this.hasCodecSupport(normalized, capabilities)) {
      return false;
    }

    // AV1 always prefers GPU (no efficient CPU decode)
    if (isAv1Codec(normalized)) {
      return true;
    }

    // Check hardware decode support for HEVC and H.264
    if (isHevcCodec(normalized) || isH264Codec(normalized)) {
      const hint = this.getCodecHardwareDecodeHint(normalized, capabilities);

      // Explicit hardware decode hint takes precedence
      if (hint === false) {
        return false; // No hardware support, stay on CPU
      }

      if (hint === true) {
        return true; // Hardware decode confirmed
      }

      // No explicit hint - fall back to general hardware acceleration flag
      return capabilities.hardwareAccelerated;
    }

    // VP8/VP9: prefer the FFmpeg CPU path for GIF.
    // Rationale: FFmpeg palettegen/paletteuse is typically faster and more reliable than
    // routing VP8/VP9 through modern-gif.
    if (normalized === 'vp8' || normalized === 'vp9') {
      return false;
    }

    // Other codecs: use GPU only if generally hardware accelerated
    return capabilities.hardwareAccelerated;
  }

  private applyGifGpuPreference(
    strategy: StrategyWithConfidence,
    capabilities: ExtendedCapabilities
  ): StrategyWithConfidence {
    if (strategy.format !== 'gif') {
      return strategy;
    }

    const preferGpu = this.shouldPreferGpuForGif(strategy.codec, capabilities);

    if (preferGpu && strategy.preferredPath !== 'gpu') {
      return {
        ...strategy,
        preferredPath: 'gpu',
        fallbackPath: 'cpu',
        benchmarks: undefined,
        confidence: strategy.confidence === 'high' ? 'medium' : strategy.confidence,
        reason:
          'Hardware decode available; preferring GPU decode path for GIF (encoder resolved at runtime)',
      };
    }

    if (!preferGpu && strategy.preferredPath === 'gpu') {
      if (isAv1Codec(this.normalizeCodec(strategy.codec))) {
        return strategy;
      }

      return {
        ...strategy,
        preferredPath: 'cpu',
        fallbackPath: 'gpu',
        benchmarks: undefined,
        confidence: strategy.confidence === 'high' ? 'medium' : strategy.confidence,
        reason: 'GPU decode not available for GIF; preferring FFmpeg CPU path',
      };
    }

    return strategy;
  }

  private applyHardwareDecodePreference(params: {
    strategy: StrategyWithConfidence;
    capabilities: ExtendedCapabilities;
  }): StrategyWithConfidence {
    const { strategy, capabilities } = params;

    // Only adjust in cases where the GPU benefit is strongly tied to hardware decode.
    if (strategy.format !== 'webp') {
      return strategy;
    }
    if (strategy.preferredPath !== 'gpu' || strategy.fallbackPath !== 'cpu') {
      return strategy;
    }
    if (strategy.codec !== 'h264' && strategy.codec !== 'hevc') {
      return strategy;
    }

    const hint = this.getCodecHardwareDecodeHint(strategy.codec, capabilities);
    if (hint === false) {
      return {
        ...strategy,
        preferredPath: 'cpu',
        fallbackPath: 'gpu',
        confidence: strategy.confidence === 'high' ? 'medium' : strategy.confidence,
        reason: `${strategy.reason} (no hardware decode hint; preferring CPU)`,
      };
    }

    // If we cannot infer a per-codec hardware decode hint, avoid overstating certainty
    // in logs/reasoning. Keep the existing path choice but downgrade confidence.
    if (hint === null && strategy.confidence === 'high') {
      return {
        ...strategy,
        confidence: 'medium',
        reason: `${strategy.reason} (hardware decode hint unknown)`,
      };
    }

    return strategy;
  }

  /**
   * Get optimal strategy for codec+format combination
   *
   * @param params - Codec, format, container, capabilities, and optional duration
   * @returns Strategy with confidence scoring
   */
  getStrategy(params: {
    codec: string;
    format: ConversionFormat;
    container: ContainerFormat;
    capabilities: ExtendedCapabilities;
    durationSeconds?: number;
  }): StrategyWithConfidence {
    const { codec, format, container, capabilities, durationSeconds } = params;

    // Normalize codec string for matching
    const normalizedCodec = this.normalizeCodec(codec);
    const key = `${normalizedCodec}:${format}`;

    // Check mandatory blockers first
    const blockerResult = this.checkMandatoryBlockers(codec, format, container, capabilities);
    if (blockerResult) {
      return blockerResult;
    }

    // Session-scoped learning from StrategyHistoryService.
    // If we have enough successful signal, prefer the historically successful path.
    const history = strategyHistoryService.getHistory(codec, format);
    const recommended = strategyHistoryService.getRecommendedPath(codec, format);
    if (
      recommended &&
      recommended.confidence >= StrategyRegistryService.HISTORY_CONFIDENCE_THRESHOLD
    ) {
      const preferredPath = recommended.path;
      const fallbackPath: ConversionPath = preferredPath === 'gpu' ? 'cpu' : 'gpu';

      return this.applyRecentFailureAvoidance(
        this.applyGifGpuPreference(
          {
            codec: normalizedCodec,
            format,
            preferredPath,
            fallbackPath,
            reason: `Historical success (records=${
              recommended.basedOnRecords
            }, avg=${Math.round(recommended.avgDurationMs)}ms)`,
            confidence: 'high',
          },
          capabilities
        ),
        history
      );
    }

    // Check runtime overrides (learned from history)
    if (this.runtimeOverrides.has(key)) {
      const override = this.runtimeOverrides.get(key)!;
      logger.debug('conversion', 'Using runtime override strategy', {
        codec: normalizedCodec,
        format,
        path: override.preferredPath,
      });
      return this.applyRecentFailureAvoidance(
        this.applyGifGpuPreference(
          {
            ...override,
            confidence: 'high', // High confidence from historical success
          },
          capabilities
        ),
        history
      );
    }

    // Check predefined matrix
    if (STRATEGY_MATRIX.has(key)) {
      const strategy = STRATEGY_MATRIX.get(key)!;

      // Validate capabilities
      if (this.validateCapabilities(strategy, capabilities)) {
        const baseStrategy = this.applyHardwareDecodePreference({
          strategy: {
            ...strategy,
            confidence: 'high', // High confidence from benchmarks
          },
          capabilities,
        });

        // Apply duration-based adjustments if duration is known
        const durationAdjusted = durationSeconds
          ? this.applyDurationHeuristics(baseStrategy, durationSeconds, normalizedCodec, format)
          : baseStrategy;

        return this.applyRecentFailureAvoidance(
          this.applyGifGpuPreference(durationAdjusted, capabilities),
          history
        );
      }

      // Capabilities missing - try fallback
      logger.debug('conversion', 'Primary strategy requires missing capabilities, using fallback', {
        codec: normalizedCodec,
        format,
        preferredPath: strategy.preferredPath,
        fallbackPath: strategy.fallbackPath,
      });

      return this.applyRecentFailureAvoidance(
        {
          ...strategy,
          preferredPath: strategy.fallbackPath,
          confidence: 'medium', // Medium confidence when forced to fallback
        },
        history
      );
    }

    // No predefined strategy - use heuristic
    logger.debug('conversion', 'No predefined strategy, using heuristic', {
      codec: normalizedCodec,
      format,
    });

    return this.applyRecentFailureAvoidance(
      this.applyGifGpuPreference(
        this.applyHardwareDecodePreference({
          strategy: this.getHeuristicStrategy(normalizedCodec, format, capabilities),
          capabilities,
        }),
        capabilities
      ),
      history
    );
  }

  /**
   * Apply duration-based heuristics to strategy selection
   *
   * Adjusts path preference based on clip duration:
   * - Short clips (<5s): Prefer CPU for GIF (lower decoder overhead)
   * - Medium clips (5-15s): Use default strategy
   * - Long clips (>15s): Prefer GPU for GIF (amortize setup cost)
   *
   * @param strategy - Base strategy from matrix
   * @param durationSeconds - Video duration in seconds
   * @param codec - Normalized codec string
   * @param format - Target format
   * @returns Adjusted strategy with duration reasoning
   */
  private applyDurationHeuristics(
    strategy: StrategyWithConfidence,
    durationSeconds: number,
    codec: string,
    format: ConversionFormat
  ): StrategyWithConfidence {
    // Only apply duration heuristics for GIF conversions
    // (WebP and MP4 strategies are already optimal regardless of duration)
    if (format !== 'gif') {
      return strategy;
    }

    // Duration thresholds (conservative to avoid over-optimization)
    const SHORT_CLIP_THRESHOLD = 5; // seconds
    const LONG_CLIP_THRESHOLD = 15; // seconds

    // For H.264 GIF: short clips benefit from CPU (less WebCodecs setup overhead)
    if (isH264Codec(codec) && durationSeconds < SHORT_CLIP_THRESHOLD) {
      if (strategy.preferredPath !== 'cpu') {
        return {
          ...strategy,
          preferredPath: 'cpu',
          fallbackPath: 'gpu',
          reason: `${strategy.reason} + Short clip (${durationSeconds.toFixed(
            1
          )}s) benefits from CPU path (lower setup overhead)`,
          confidence: 'high',
        };
      }
    }

    // For complex codecs (HEVC, AV1, VP9) with long clips: prefer GPU
    if (
      (isHevcCodec(codec) || isAv1Codec(codec) || codec === 'vp9' || codec === 'vp8') &&
      durationSeconds > LONG_CLIP_THRESHOLD
    ) {
      if (strategy.preferredPath !== 'gpu') {
        return {
          ...strategy,
          preferredPath: 'gpu',
          fallbackPath: 'cpu',
          reason: `${strategy.reason} + Long clip (${durationSeconds.toFixed(
            1
          )}s) amortizes GPU setup cost`,
          confidence: 'medium',
        };
      }
    }

    return strategy;
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

    const recentForPath = recent.filter((r) => r.path === strategy.preferredPath);
    const recentFailures = recentForPath.filter((r) => !r.success).length;
    const recentSuccesses = recentForPath.filter((r) => r.success).length;

    if (
      recentFailures >= 2 &&
      recentSuccesses === 0 &&
      strategy.fallbackPath !== strategy.preferredPath
    ) {
      logger.debug('conversion', 'Avoiding path due to recent failures', {
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
        confidence: strategy.confidence === 'high' ? 'medium' : strategy.confidence,
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
    logger.debug('conversion', 'Strategy success recorded', params);
  }

  /**
   * Get decision reasoning (for dev logging)
   */
  getStrategyReasoning(params: {
    codec: string;
    format: ConversionFormat;
    container: ContainerFormat;
    capabilities: ExtendedCapabilities;
    durationSeconds?: number;
  }): StrategyReasoning {
    const { codec, format, container, capabilities } = params;
    const normalizedCodec = this.normalizeCodec(codec);
    const strategy = this.getStrategy(params);

    const decision = strategy.preferredPath;
    const codecSupport =
      decision === 'cpu'
        ? true
        : decision === 'webav'
          ? Boolean(capabilities.mp4Encode)
          : this.hasCodecSupport(normalizedCodec, capabilities);
    const containerSupport = decision === 'gpu' ? !this.isBlockedContainer(container) : true;
    const hardwareAcceleration = capabilities.hardwareAccelerated;
    const codecHardwareDecodeHint = this.getCodecHardwareDecodeHint(normalizedCodec, capabilities);
    const webcodecsDecodeSupport = capabilities.webcodecsDecode;
    const gifGpuEligible =
      format === 'gif' ? this.shouldPreferGpuForGif(normalizedCodec, capabilities) : undefined;
    const history = strategyHistoryService.getHistory(codec, format);
    const historicalSuccess = Boolean(
      history?.records.some((r) => r.success && r.path === decision)
    );
    const performanceBenchmark = strategy.benchmarks?.avgTimeSeconds
      ? strategy.benchmarks.avgTimeSeconds * 1000
      : undefined;

    const alternativesConsidered = this.getAlternativePaths(strategy.preferredPath).map((path) => ({
      path,
      rejectionReason: this.getRejectionReason(path, normalizedCodec, format, capabilities),
    }));

    return {
      decision: strategy.preferredPath,
      factors: {
        codecSupport,
        containerSupport,
        hardwareAcceleration,
        codecHardwareDecodeHint,
        webcodecsDecodeSupport,
        gifGpuEligible,
        historicalSuccess,
        performanceBenchmark,

        sharedArrayBuffer: capabilities.sharedArrayBuffer,
        crossOriginIsolated: capabilities.crossOriginIsolated,
        workerSupport: capabilities.workerSupport,
        offscreenCanvas: capabilities.offscreenCanvas,
        estimatedMemoryMB: capabilities.estimatedMemoryMB,

        canvasWebpEncode: capabilities.canvasWebpEncode,
        offscreenWebpEncode: capabilities.offscreenWebpEncode,
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
    if (container === 'avi' || container === 'wmv') {
      return {
        codec,
        format,
        preferredPath: 'cpu',
        fallbackPath: 'cpu', // No fallback
        reason: `${container.toUpperCase()} container requires FFmpeg full pipeline`,
        confidence: 'high',
      };
    }

    // AV1 without WebCodecs → Error (fail-fast)
    if (isAv1Codec(codec) && !capabilities.av1) {
      // This will be caught by pipeline selector and throw an error
      // Return GPU path anyway - it will fail with clear error message
      return {
        codec,
        format,
        preferredPath: 'gpu',
        fallbackPath: 'gpu', // No fallback
        reason: 'AV1 requires WebCodecs support (will fail if unsupported)',
        confidence: 'low',
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
    if (preferredPath === 'gpu') {
      if (!capabilities.webcodecsDecode) {
        return false;
      }

      return this.hasCodecSupport(codec, capabilities);
    }

    // WebAV path requires mp4Encode capability
    if (preferredPath === 'webav') {
      return capabilities.mp4Encode;
    }

    // CPU path always available (FFmpeg)
    return true;
  }

  /**
   * Check if codec is supported by WebCodecs
   */
  private hasCodecSupport(codec: string, capabilities: ExtendedCapabilities): boolean {
    const normalized = this.normalizeCodec(codec);

    if (isH264Codec(normalized)) return capabilities.h264;
    if (isHevcCodec(normalized)) return capabilities.hevc;
    if (isAv1Codec(normalized)) return capabilities.av1;
    if (normalized === 'vp8') return capabilities.vp8;
    if (normalized === 'vp9') return capabilities.vp9;

    // Unknown codec - for success/predictability, do not assume WebCodecs support.
    return false;
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
        preferredPath: 'cpu',
        fallbackPath: 'cpu',
        reason: 'Unknown codec - using safe FFmpeg fallback',
        confidence: 'low',
      };
    }

    // MP4 format → WebAV if available
    if (format === 'mp4' && capabilities.mp4Encode) {
      return {
        codec,
        format,
        preferredPath: 'webav',
        fallbackPath: 'cpu',
        reason: 'MP4 format uses WebAV when available',
        confidence: 'medium',
      };
    }

    // GIF format → Prefer CPU by default (GPU preference applied later when eligible)
    if (format === 'gif') {
      return {
        codec,
        format,
        preferredPath: 'cpu',
        fallbackPath: 'gpu',
        reason: 'GIF format generally faster with FFmpeg palettegen',
        confidence: 'medium',
      };
    }

    // WebP format → Prefer GPU (HW decode + libwebp)
    if (format === 'webp') {
      return {
        codec,
        format,
        preferredPath: 'gpu',
        fallbackPath: 'cpu',
        reason: 'WebP format benefits from hardware decode',
        confidence: 'medium',
      };
    }

    // Default: GPU if available, CPU fallback
    return {
      codec,
      format,
      preferredPath: 'gpu',
      fallbackPath: 'cpu',
      reason: 'Default heuristic: GPU with CPU fallback',
      confidence: 'low',
    };
  }

  /**
   * Normalize codec string for consistent matching
   */
  private normalizeCodec(codec: string): string {
    const lower = codec.toLowerCase();

    if (isH264Codec(lower)) return 'h264';
    if (isHevcCodec(lower)) return 'hevc';
    if (isAv1Codec(lower)) return 'av1';
    if (lower.includes('vp09') || lower.includes('vp9')) return 'vp9';
    if (lower.includes('vp08') || lower.includes('vp8')) return 'vp8';

    return lower;
  }

  /**
   * Check if container is blocked (forced to CPU path)
   */
  private isBlockedContainer(container: ContainerFormat): boolean {
    return container === 'avi' || container === 'wmv';
  }

  /**
   * Get alternative paths (for reasoning)
   */
  private getAlternativePaths(selectedPath: ConversionPath): ConversionPath[] {
    const allPaths: ConversionPath[] = ['gpu', 'cpu', 'webav'];
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
    if (path === 'gpu') {
      if (!capabilities.webcodecsDecode) {
        return 'WebCodecs decode is not available in this environment';
      }
      if (!this.hasCodecSupport(codec, capabilities)) {
        return `Codec ${codec} not supported by WebCodecs`;
      }
      if (format === 'gif' && !this.shouldPreferGpuForGif(codec, capabilities)) {
        const normalized = this.normalizeCodec(codec);
        if (!isAv1Codec(normalized) && !isHevcCodec(normalized)) {
          return 'GIF CPU path preferred for this codec';
        }
        return 'Hardware decode unavailable for GIF; prefer CPU';
      }
      return 'Not optimal for this codec+format combination';
    }

    if (path === 'cpu') {
      if (format === 'webp' && this.hasCodecSupport(codec, capabilities)) {
        const hint = this.getCodecHardwareDecodeHint(codec, capabilities);
        if (hint === true || capabilities.hardwareAccelerated) {
          return 'GPU path faster for WebP with hardware decode';
        }
        if (hint === false) {
          return 'GPU path benefit reduced without hardware decode';
        }
        return 'Hardware decode hint unknown; GPU path often faster for WebP when hardware decode is available';
      }
      return 'Not optimal for this codec+format combination';
    }

    if (path === 'webav') {
      if (format !== 'mp4') {
        return `WebAV only supports MP4 format, not ${format}`;
      }
      if (!capabilities.mp4Encode) {
        return 'WebAV not available in this browser';
      }
      return 'Not optimal for this codec+format combination';
    }

    return 'Unknown rejection reason';
  }
}

export const strategyRegistryService = createSingleton(
  'StrategyRegistryService',
  () => new StrategyRegistryService()
);
