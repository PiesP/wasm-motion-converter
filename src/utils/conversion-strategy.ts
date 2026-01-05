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

  // GIF: avoid WebCodecs overhead for very long/high-res inputs; prefer FFmpeg directly
  if (format === 'gif' && (isVeryLong || isVeryHighResolution || isHugeFile)) {
    strategy.forceFFmpeg = true;
    strategy.reasons.push('GIF high load - preferring direct FFmpeg path');

    if (isVeryHighResolution) {
      strategy.scaleOverride = coerceScale(0.5);
      strategy.reasons.push('Scaling to 50% for very high resolution GIF');
    } else if (isHighResolution) {
      strategy.scaleOverride = coerceScale(0.75);
      strategy.reasons.push('Scaling to 75% for high resolution GIF');
    }

    if (isLong || isVeryLong) {
      // Cap FPS to keep palette and encode faster/stable
      strategy.fpsCap = 12;
      strategy.reasons.push('Capping GIF FPS to 12 for long duration');
      strategy.recommendedQuality = 'low';
    }
  }

  // AV1 → WebP: be conservative to reduce stalls during FFmpeg encode fallback
  if (format === 'webp' && codec.includes('av1')) {
    if (!strategy.scaleOverride && (isHighResolution || isLong || isHugeFile)) {
      strategy.scaleOverride = coerceScale(0.75);
      strategy.reasons.push('AV1 WebP: scaling to 75% to reduce encode load');
    }

    if (!strategy.recommendedQuality || strategy.recommendedQuality === 'high') {
      strategy.recommendedQuality = 'medium';
      strategy.reasons.push('AV1 WebP: lowering quality to improve stability');
    }
  }

  // WebP/AVIF: keep WebCodecs preferred unless codec forces FFmpeg; no extra strategy here

  return strategy;
}
