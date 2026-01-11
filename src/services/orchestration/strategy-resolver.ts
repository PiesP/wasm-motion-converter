/**
 * Strategy Resolver
 *
 * Provides adaptive strategy selection for video conversion operations based on:
 * - Codec type (AV1, H.264, HEVC, VP8, VP9)
 * - Target format (GIF vs WebP)
 * - Video metadata (resolution, duration, file size)
 *
 * Strategies include codec-based routing (FFmpeg vs WebCodecs), resolution-based
 * scaling, FPS capping, and quality recommendations for optimal performance.
 *
 * This module is part of the orchestration layer and is used by path-selector
 * to make intelligent routing decisions.
 *
 * @module orchestration/strategy-resolver
 */

import type {
  ConversionFormat,
  ConversionQuality,
  ConversionScale,
  VideoMetadata,
} from '@t/conversion-types';
import {
  WARN_DURATION_SECONDS,
  WARN_FILE_SIZE_HIGH,
  WARN_RESOLUTION_PIXELS,
} from '@utils/constants';

/**
 * Conversion strategy configuration with codec routing, scaling, FPS, and quality recommendations.
 *
 * @property forceFFmpeg - If `true`, route through FFmpeg (faster for supported codecs).
 *                         If `false`, prefer WebCodecs path (required for AV1).
 * @property scaleOverride - Optional scale override (0.5 = 50%, 0.75 = 75%, 1.0 = 100%).
 *                           Applied when high resolution or large file size detected.
 * @property fpsCap - Optional FPS cap for frame extraction (e.g., 12, 15, 24).
 *                    Applied for very long GIF conversions to reduce palette generation time.
 * @property recommendedQuality - Optional quality preset recommendation (low, medium, high).
 * @property reasons - Array of human-readable reasons explaining strategy decisions.
 *                     Useful for debugging and user feedback.
 *
 * @example
 * ```ts
 * const strategy = getConversionStrategy({
 *   file: videoFile,
 *   format: 'gif',
 *   metadata: { codec: 'av1', width: 1920, height: 1080, duration: 30 }
 * });
 * // Returns: { forceFFmpeg: false, reasons: ['GIF + AV1: WebCodecs required...'] }
 * ```
 */
export type ConversionStrategy = {
  forceFFmpeg: boolean;
  scaleOverride?: ConversionScale;
  fpsCap?: number;
  recommendedQuality?: ConversionQuality;
  reasons: string[];
};

/**
 * Coerce arbitrary scale value to a supported ConversionScale option.
 *
 * @param value - Scale value to coerce (0.0 to 1.0+)
 * @returns Nearest supported scale: 0.5, 0.75, or 1.0
 *
 * @example
 * ```ts
 * coerceScale(0.4); // 0.5
 * coerceScale(0.6); // 0.75
 * coerceScale(0.8); // 1.0
 * ```
 */
const coerceScale = (value: number): ConversionScale => {
  if (value <= 0.5) return 0.5;
  if (value <= 0.75) return 0.75;
  return 1.0;
};

/**
 * Determine conversion strategy based on codec, format, and video metadata.
 *
 * Applies codec-specific routing logic, resolution-based scaling, FPS capping,
 * and quality recommendations for optimal performance and stability.
 *
 * **GIF Strategy:**
 * - AV1/unknown: WebCodecs path (FFmpeg lacks AV1 decoder)
 * - Supported codecs (H.264, HEVC, VP8, VP9): FFmpeg direct path (3x faster)
 * - Very high resolution (>1.5×1080p): Scale to 50%
 * - High resolution (>1080p): Scale to 75%
 * - Very long duration (>60s): Cap FPS to 12, reduce quality
 * - Long duration (>30s): Cap FPS to 15
 *
 * **WebP Strategy:**
 * - AV1: WebCodecs mandatory (FFmpeg lacks decoder), scale & quality adjustments
 * - Supported codecs: FFmpeg preferred (2x faster than WebCodecs)
 * - Very high resolution or very long: Scale to 50%
 * - High resolution or long duration: Scale to 75%
 *
 * @param params - Conversion parameters
 * @param params.file - Input video file
 * @param params.format - Target format (gif or webp)
 * @param params.metadata - Video metadata (codec, dimensions, duration)
 * @returns ConversionStrategy with routing decision, optional overrides, and explanation
 *
 * @example
 * ```ts
 * const strategy = getConversionStrategy({
 *   file: new File([...], 'video.mp4'),
 *   format: 'gif',
 *   metadata: { codec: 'h264', width: 1920, height: 1080, duration: 45 }
 * });
 * // Returns: {
 * //   forceFFmpeg: true,
 * //   fpsCap: 15,
 * //   reasons: ['GIF + supported codec: FFmpeg direct path...', 'GIF + long duration...']
 * // }
 * ```
 */
export function getConversionStrategy(params: {
  file: File;
  format: ConversionFormat;
  metadata?: VideoMetadata;
}): ConversionStrategy {
  const { file, format, metadata } = params;
  const strategy: ConversionStrategy = {
    forceFFmpeg: false,
    reasons: [],
  };

  if (!metadata) {
    return strategy;
  }

  const codec = metadata.codec?.toLowerCase() ?? '';
  const pixels = metadata.width * metadata.height;
  const isHighResolution = pixels > WARN_RESOLUTION_PIXELS;
  const isVeryHighResolution = pixels > WARN_RESOLUTION_PIXELS * 1.5;
  const isLong = metadata.duration > WARN_DURATION_SECONDS;
  const isVeryLong = metadata.duration > WARN_DURATION_SECONDS * 2;
  const isHugeFile = file.size > WARN_FILE_SIZE_HIGH;

  // ============================================================================
  // GIF Conversion Strategy
  // ============================================================================
  // Test results (5.8s, 700x700, medium quality):
  //   - H.264 → GIF (FFmpeg): 2.04s ⚡ (3x faster)
  //   - AV1 → GIF (WebCodecs + modern-gif): 13.94s (worker failed, main thread fallback)
  //
  // Decision logic:
  //   - AV1/unknown: WebCodecs path required (FFmpeg lacks decoder)
  //   - Supported codecs: FFmpeg direct path is 3x faster than WebCodecs hybrid
  // ============================================================================
  if (format === 'gif') {
    // Check if codec is WebCodecs-only (AV1)
    const isWebCodecsOnlyCodec =
      codec.includes('av1') || codec.includes('av01') || codec === 'unknown';

    if (isWebCodecsOnlyCodec) {
      // AV1/unknown: WebCodecs path required (FFmpeg lacks AV1 decoder)
      strategy.forceFFmpeg = false;
      strategy.reasons.push('GIF + AV1: WebCodecs required (FFmpeg.wasm 5.1.4 lacks AV1 decoder)');
    } else {
      // H.264/HEVC/VP8/VP9: FFmpeg direct path is 3x faster than WebCodecs hybrid
      strategy.forceFFmpeg = true;
      strategy.reasons.push(
        'GIF + supported codec: FFmpeg direct path (3x faster than WebCodecs hybrid)'
      );
    }

    if (isVeryHighResolution) {
      strategy.scaleOverride = coerceScale(0.5);
      strategy.reasons.push(
        'GIF + very high resolution (>1.5×1080p): scale to 50% to reduce encoding time'
      );
    } else if (isHighResolution) {
      strategy.scaleOverride = coerceScale(0.75);
      strategy.reasons.push(
        'GIF + high resolution (>1080p): scale to 75% to optimize encoding speed'
      );
    }

    if (isVeryLong) {
      strategy.fpsCap = 12;
      strategy.reasons.push(
        'GIF + very long duration (>60s): cap FPS to 12 for faster palette/encode'
      );
      strategy.recommendedQuality = 'low';
      strategy.reasons.push('GIF + very long duration (>60s): reduce quality for stability');
    } else if (isLong) {
      strategy.fpsCap = 15;
      strategy.reasons.push('GIF + long duration (>30s): moderate FPS cap to 15');
    }

    return strategy;
  }

  // ============================================================================
  // WebP Conversion Strategy
  // ============================================================================
  // Test results (5.8s, 700x700, medium quality):
  //   - H.264 → WebP (FFmpeg): 5.43s (single-pass, fast)
  //   - AV1 → WebP (WebCodecs 2-pass): 12.44s (PNG→H.264→WebP pipeline)
  //
  // Decision logic:
  //   - AV1: WebCodecs mandatory (FFmpeg lacks decoder), with scale & quality adjustments
  //   - Supported codecs: FFmpeg preferred (2x faster, simpler pipeline)
  // ============================================================================
  if (format === 'webp') {
    if (codec.includes('av1')) {
      // AV1 + WebP: WebCodecs mandatory (FFmpeg lacks decoder)
      strategy.forceFFmpeg = false;
      strategy.reasons.push('AV1 + WebP: WebCodecs required (FFmpeg.wasm 5.1.4 lacks AV1 decoder)');

      if (isVeryHighResolution || isHugeFile) {
        strategy.scaleOverride = coerceScale(0.5);
        strategy.reasons.push(
          'AV1 + WebP + large (high res or huge file): scale to 50% to reduce memory pressure'
        );
      } else if (isHighResolution || isLong) {
        strategy.scaleOverride = coerceScale(0.75);
        strategy.reasons.push(
          'AV1 + WebP + high load (resolution or duration): scale to 75% for memory efficiency'
        );
      }

      if (isVeryLong || isHugeFile) {
        strategy.recommendedQuality = 'low';
        strategy.reasons.push('AV1 + WebP + long or large: reduce quality for stability');
      } else {
        strategy.recommendedQuality = 'medium';
        strategy.reasons.push('AV1 + WebP: use medium quality for balance');
      }
    } else {
      // H.264/HEVC/VP8/VP9 + WebP: FFmpeg preferred (2x faster, simpler pipeline)
      strategy.forceFFmpeg = true;
      strategy.reasons.push(
        'WebP + supported codec: FFmpeg direct path (2x faster than WebCodecs)'
      );

      if (isVeryHighResolution || isVeryLong || isHugeFile) {
        strategy.scaleOverride = coerceScale(0.75);
        strategy.reasons.push(
          'WebP + high load (resolution, duration, or file size): scale to 75% for efficiency'
        );
      }
    }

    return strategy;
  }

  // No specific strategy for other formats; return default strategy
  return strategy;
}
