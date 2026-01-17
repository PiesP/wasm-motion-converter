import type { ConversionQuality } from '@t/conversion-types';

const SCALE_FILTERS: Record<ConversionQuality, string> = {
  high: 'lanczos',
  medium: 'bicubic',
  low: 'bilinear',
};

/**
 * Generate scale filter string for video resizing.
 * Uses quality-appropriate interpolation algorithms.
 * Returns null if no scaling needed (scale === 1.0).
 */
export const getScaleFilter = (quality: ConversionQuality, scale: number): string | null => {
  if (scale === 1.0) {
    return null;
  }

  const filter = SCALE_FILTERS[quality];
  return `scale=iw*${scale}:ih*${scale}:flags=${filter}`;
};
