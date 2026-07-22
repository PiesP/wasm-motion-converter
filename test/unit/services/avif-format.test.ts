// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { describe, expect, it } from 'vitest';
import {
  AVIF_MIME_TYPE,
  AVIF_TIMESCALE,
  avifQualityFor,
  durationToAvifTimescale,
  isAnimatedAvif,
} from '@services/avif-format';

const bytes = (text: string, length = text.length) => {
  const output = new Uint8Array(length);
  output.set(new TextEncoder().encode(text).slice(0, length));
  return output;
};

describe('avif-format', () => {
  it('defines the browser AVIF MIME type', () => {
    expect(AVIF_MIME_TYPE).toBe('image/avif');
    expect(AVIF_TIMESCALE).toBe(1000);
  });

  it('recognizes an animated AVIF ftyp box by the avis brand', () => {
    const output = bytes('\0\0\0\x18ftypavis\0\0\0\0avis');
    expect(isAnimatedAvif(output)).toBe(true);
    expect(isAnimatedAvif(bytes('\0\0\0\x18ftypavif\0\0\0\0avif'))).toBe(false);
    expect(isAnimatedAvif(bytes('avis'))).toBe(false);
  });

  it('maps quality presets to bounded libavif quality values', () => {
    expect(avifQualityFor('low')).toBe(35);
    expect(avifQualityFor('medium')).toBe(55);
    expect(avifQualityFor('high')).toBe(75);
  });

  it('converts frame durations to positive millisecond timescales', () => {
    expect(durationToAvifTimescale(16.7)).toBe(17);
    expect(durationToAvifTimescale(0)).toBe(1);
    expect(durationToAvifTimescale(Number.NaN)).toBe(1);
  });
});
