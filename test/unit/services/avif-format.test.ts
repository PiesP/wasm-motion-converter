// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { describe, expect, it } from 'vitest';
import {
  AVIF_MIME_TYPE,
  AVIF_MAX_ENCODE_PIXELS,
  AVIF_SPEED,
  AVIF_TIMESCALE,
  assertAvifEncodeResolution,
  avifQualityFor,
  durationToAvifTimescale,
  isAnimatedAvif,
  isAvifEncodeResolutionSupported,
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
    expect(AVIF_SPEED).toBe(10);
  });

  it('rejects resolutions that exceed the AVIF WASM working-set limit', () => {
    expect(isAvifEncodeResolutionSupported(1440, 810)).toBe(true);
    expect(isAvifEncodeResolutionSupported(1920, 1080)).toBe(false);
    expect(AVIF_MAX_ENCODE_PIXELS).toBe(1_200_000);
    expect(() => assertAvifEncodeResolution(1920, 1080)).toThrow(
      /AVIF WASM memory limit reached.*reduce the scale to 50%/
    );
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
