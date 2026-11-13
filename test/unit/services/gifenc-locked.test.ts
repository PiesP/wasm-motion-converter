// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { applyPalette, quantize } from 'gifenc';
import { describe, expect, it } from 'vite-plus/test';

function rgba(...colors: Array<readonly [number, number, number]>): Uint8Array {
  return Uint8Array.from(colors.flatMap(([r, g, b]) => [r, g, b, 255]));
}

describe('locked gifenc 1.0.3 rgb565 behavior', () => {
  it('retains the installed green packing mask and f64 rounding', () => {
    expect(quantize(rgba([0, 0, 0], [0, 7, 0]), 2, { format: 'rgb565' })).toEqual([
      [0, 4, 0],
    ]);
    expect(quantize(rgba([0, 0, 0], [0, 8, 0]), 2, { format: 'rgb565' })).toEqual([
      [0, 0, 0],
      [0, 8, 0],
    ]);
    expect(quantize(rgba([0, 0, 0], [1, 1, 1]), 1, { format: 'rgb565' })).toEqual([
      [1, 1, 1],
    ]);
  });

  it('retains ordered palette entries and first-pixel packed-key caching', () => {
    const pixels = rgba([255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]);
    const palette = quantize(pixels, 4, { format: 'rgb565' });
    expect(palette).toEqual([
      [0, 0, 255],
      [0, 255, 0],
      [255, 0, 0],
      [255, 255, 255],
    ]);
    expect([...applyPalette(pixels, palette, 'rgb565')]).toEqual([2, 1, 0, 3]);

    const tiePalette = [
      [0, 0, 0],
      [0, 7, 0],
    ];
    expect([...applyPalette(rgba([0, 0, 0], [0, 7, 0]), tiePalette, 'rgb565')]).toEqual([
      0, 0,
    ]);
    expect([...applyPalette(rgba([0, 7, 0], [0, 0, 0]), tiePalette, 'rgb565')]).toEqual([
      1, 1,
    ]);
  });
});
