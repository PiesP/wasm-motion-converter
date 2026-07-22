// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { ConversionQuality } from '@t/conversion-types';

/** MIME type used for both static and animated AVIF output. */
export const AVIF_MIME_TYPE = 'image/avif';

/** Fixed media timescale used by the stateful libavif binding. */
export const AVIF_TIMESCALE = 1000;

/** Browser-safe AOM speed preset; lower values trade conversion time for size. */
export const AVIF_SPEED = 8;

/** Match the existing animated-image behavior: loop forever. */
export const AVIF_REPETITION_COUNT = -1;

/** libavif quality values used by the user-facing presets. */
const AVIF_QUALITY_MAP: Record<ConversionQuality, number> = {
  low: 35,
  medium: 55,
  high: 75,
};

/** Return the libavif quality value for a conversion preset. */
export function avifQualityFor(quality: ConversionQuality): number {
  return AVIF_QUALITY_MAP[quality];
}

/**
 * Convert a decoded frame duration to the AVIF encoder's 1000Hz timescale.
 * A positive minimum prevents zero-duration samples from producing invalid timing.
 */
export function durationToAvifTimescale(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 1;
  return Math.max(1, Math.round(durationMs));
}

/**
 * Check that an output is an AV1 image sequence (`avis` brand), not merely a
 * still-image AVIF (`avif` brand).
 */
export function isAnimatedAvif(output: Uint8Array): boolean {
  if (output.byteLength < 12) return false;

  const decoder = new TextDecoder();
  if (decoder.decode(output.slice(4, 8)) !== 'ftyp') return false;

  const majorBrand = decoder.decode(output.slice(8, 12));
  if (majorBrand === 'avis') return true;

  const boxSize = new DataView(output.buffer, output.byteOffset, output.byteLength).getUint32(0);
  const brandsEnd = boxSize >= 16 && boxSize <= output.byteLength ? boxSize : output.byteLength;
  for (let offset = 16; offset + 4 <= brandsEnd; offset += 4) {
    if (decoder.decode(output.slice(offset, offset + 4)) === 'avis') return true;
  }
  return false;
}
