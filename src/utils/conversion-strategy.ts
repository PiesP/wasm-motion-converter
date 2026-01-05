import type {
  ConversionFormat,
  ConversionQuality,
  ConversionScale,
  VideoMetadata,
} from '../types/conversion-types';
import { WARN_DURATION_SECONDS, WARN_FILE_SIZE_HIGH, WARN_RESOLUTION_PIXELS } from './constants';

export type ConversionStrategy = {
  forceFFmpeg: boolean;
  scaleOverride?: ConversionScale;
  fpsCap?: number;
  recommendedQuality?: ConversionQuality;
  reasons: string[];
};

const coerceScale = (value: number): ConversionScale => {
  if (value <= 0.5) return 0.5;
  if (value <= 0.75) return 0.75;
  return 1.0;
};

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

  // === GIF Conversion Strategy ===
  // Test results (5.8s, 700x700, medium quality):
  //   H.264 → GIF (FFmpeg): 2.04s ⚡ (3x faster)
  //   AV1 → GIF (WebCodecs + modern-gif): 13.94s (worker failed, main thread fallback)
  //
  // Strategy: Always prefer FFmpeg direct path for codecs it supports (H.264, HEVC, VP8, VP9)
  // AV1 must use WebCodecs path (FFmpeg lacks decoder)
  if (format === 'gif') {
    // Check if codec is WebCodecs-only (AV1)
    const isWebCodecsOnlyCodec =
      codec.includes('av1') || codec.includes('av01') || codec === 'unknown';

    if (isWebCodecsOnlyCodec) {
      // AV1/unknown: WebCodecs path required
      strategy.forceFFmpeg = false;
      strategy.reasons.push('GIF + AV1: WebCodecs required (FFmpeg lacks AV1 decoder)');
    } else {
      // H.264/HEVC/VP8/VP9: FFmpeg direct path is 3x faster
      strategy.forceFFmpeg = true;
      strategy.reasons.push('GIF + supported codec: FFmpeg direct path (3x faster than hybrid)');
    }

    if (isVeryHighResolution) {
      strategy.scaleOverride = coerceScale(0.5);
      strategy.reasons.push('GIF + very high resolution: scale to 50% to reduce encoding time');
    } else if (isHighResolution) {
      strategy.scaleOverride = coerceScale(0.75);
      strategy.reasons.push('GIF + high resolution: scale to 75% to optimize encoding speed');
    }

    if (isVeryLong) {
      strategy.fpsCap = 12;
      strategy.reasons.push('GIF + very long duration: cap FPS to 12 for faster palette/encode');
      strategy.recommendedQuality = 'low';
      strategy.reasons.push('GIF + very long duration: reduce quality for stability');
    } else if (isLong) {
      strategy.fpsCap = 15;
      strategy.reasons.push('GIF + long duration: moderate FPS cap to 15');
    }

    return strategy;
  }

  // === WebP Conversion Strategy ===
  // Test results (5.8s, 700x700, medium quality):
  //   H.264 → WebP (FFmpeg): 5.43s (single-pass, fast)
  //   AV1 → WebP (WebCodecs 2-pass): 12.44s (PNG→H.264→WebP pipeline)
  //
  // Strategy: Codec-specific routing
  //   - AV1: WebCodecs mandatory (FFmpeg lacks decoder)
  //   - H.264/HEVC/VP9: FFmpeg preferred (faster, simpler pipeline)
  if (format === 'webp') {
    if (codec.includes('av1')) {
      // AV1 + WebP: WebCodecs mandatory
      strategy.forceFFmpeg = false;
      strategy.reasons.push('AV1 + WebP: WebCodecs required (FFmpeg lacks AV1 decoder)');

      if (isVeryHighResolution || isHugeFile) {
        strategy.scaleOverride = coerceScale(0.5);
        strategy.reasons.push('AV1 + WebP + large file: scale to 50% to reduce memory pressure');
      } else if (isHighResolution || isLong) {
        strategy.scaleOverride = coerceScale(0.75);
        strategy.reasons.push('AV1 + WebP + high load: scale to 75% for memory efficiency');
      }

      if (isVeryLong || isHugeFile) {
        strategy.recommendedQuality = 'low';
        strategy.reasons.push('AV1 + WebP + long/large: reduce quality for stability');
      } else {
        strategy.recommendedQuality = 'medium';
        strategy.reasons.push('AV1 + WebP: use medium quality for balance');
      }
    } else {
      // H.264/HEVC/VP8/VP9 + WebP: FFmpeg preferred (2x faster, simpler pipeline)
      strategy.forceFFmpeg = true;
      strategy.reasons.push('WebP + supported codec: FFmpeg direct path (faster than WebCodecs)');

      if (isVeryHighResolution || isVeryLong || isHugeFile) {
        strategy.scaleOverride = coerceScale(0.75);
        strategy.reasons.push('WebP + high load: scale to 75% for efficiency');
      }
    }

    return strategy;
  }

  // No specific strategy for other formats
  return strategy;
}
