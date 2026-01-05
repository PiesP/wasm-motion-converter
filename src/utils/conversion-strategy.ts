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

  // GIF optimization strategy:
  // - Direct FFmpeg path is 3x faster for H.264/standard codecs
  // - WebCodecs + FFmpeg encoding adds overhead
  // - But WebCodecs-only codecs (AV1) MUST use WebCodecs path
  // Therefore: Set forceFFmpeg=true for GIF by default, but allow WebCodecs for AV1
  if (format === 'gif') {
    // Note: AV1 + GIF will use WebCodecs in conversion-service despite forceFFmpeg=true
    // because requiresWebCodecs() check takes priority over format preference
    strategy.forceFFmpeg = true;
    strategy.reasons.push(
      'GIF: prefer direct FFmpeg encoding for 3x performance (unless codec is WebCodecs-only)'
    );

    if (isVeryHighResolution) {
      strategy.scaleOverride = coerceScale(0.5);
      strategy.reasons.push('GIF + very high resolution: scale to 50% to reduce encoding time');
    } else if (isHighResolution) {
      strategy.scaleOverride = coerceScale(0.75);
      strategy.reasons.push('GIF + high resolution: scale to 75% to optimize encoding speed');
    }

    if (isVeryLong) {
      // Cap FPS to keep palette generation and encoding fast/stable for very long videos
      strategy.fpsCap = 12;
      strategy.reasons.push('GIF + very long duration: cap FPS to 12 for faster palette/encode');
      strategy.recommendedQuality = 'low';
      strategy.reasons.push('GIF + very long duration: reduce quality for stability');
    } else if (isLong) {
      // Moderate FPS cap for long videos
      strategy.fpsCap = 15;
      strategy.reasons.push('GIF + long duration: moderate FPS cap to 15');
    }

    return strategy;
  }

  // WebP optimization strategy:
  // AV1 codec: WebCodecs is the ONLY option (FFmpeg lacks AV1 decoder)
  // Other codecs: WebCodecs preferred for speed, FFmpeg as fallback
  if (format === 'webp') {
    if (codec.includes('av1')) {
      // AV1 + WebP: WebCodecs is mandatory, apply conservative settings
      strategy.reasons.push('AV1 + WebP: must use WebCodecs (FFmpeg lacks AV1 decoder)');

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
      // Non-AV1 WebP: WebCodecs preferred unless resource constraints
      strategy.reasons.push('WebP: prefer WebCodecs for GPU acceleration');

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
