// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { describe, expect, it } from 'vitest';
import { validateOutput } from '@services/error-recovery';

const bytes = (text: string, length = text.length) => {
  const output = new Uint8Array(length);
  output.set(new TextEncoder().encode(text).slice(0, length));
  return output;
};

describe('validateOutput', () => {
  it('accepts both GIF headers and rejects a short or invalid GIF', () => {
    expect(validateOutput(bytes('GIF89a'), 'gif')).toBe(true);
    expect(validateOutput(bytes('GIF87a'), 'gif')).toBe(true);
    expect(validateOutput(bytes('GIF89'), 'gif')).toBe(false);
    expect(validateOutput(bytes('PNGxxx'), 'gif')).toBe(false);
  });

  it('accepts a RIFF WEBP header only when all required bytes are present', () => {
    const output = bytes('RIFFxxxxWEBP', 12);
    expect(validateOutput(output, 'webp')).toBe(true);
    expect(validateOutput(bytes('RIFFxxxxWEBP', 11), 'webp')).toBe(false);
    expect(validateOutput(bytes('RIFFxxxxPNG!', 12), 'webp')).toBe(false);
    expect(validateOutput(bytes('WEBPxxxxRIFF', 12), 'webp')).toBe(false);
  });

  it('accepts an animated AVIF brand and rejects a still-image AVIF brand', () => {
    expect(validateOutput(bytes('\0\0\0\x18ftypavis\0\0\0\0avis'), 'avif')).toBe(true);
    expect(validateOutput(bytes('\0\0\0\x18ftypavif\0\0\0\0avif'), 'avif')).toBe(false);
  });
});
