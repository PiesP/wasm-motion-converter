import type { ConversionQuality } from '@t/conversion-types';

/**
 * Generate scale filter string for video resizing.
 * Uses quality-appropriate interpolation algorithms.
 * Returns null if no scaling needed (scale === 1.0).
 */
export const getScaleFilter = (quality: ConversionQuality, scale: number): string | null => {
  if (scale === 1.0) {
    return null;
  }

  const filter = quality === 'high' ? 'lanczos' : quality === 'medium' ? 'bicubic' : 'bilinear';
  return `scale=iw*${scale}:ih*${scale}:flags=${filter}`;
};
