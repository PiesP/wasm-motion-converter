// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createExactRgb565Quantizer } from '@services/gif-quantizer-experiment';
import { applyPalette, quantize } from 'gifenc';
import { describe, expect, it } from 'vite-plus/test';

type Pixel = readonly [number, number, number];

function frame(width: number, height: number, pixel: (x: number, y: number) => Pixel): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const [r, g, b] = pixel(x, y);
      rgba.set([r, g, b, 255], offset);
    }
  }
  return rgba;
}

function seededNoise(width: number, height: number, seed: number): Uint8Array {
  let state = seed >>> 0;
  const byte = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state >>> 24;
  };
  return frame(width, height, () => [byte(), byte(), byte()]);
}

const samples = [
  ['flat', frame(8, 8, () => [31, 63, 127])],
  [
    'green packing boundaries',
    frame(16, 16, (x, y) => [x * 16, (y * 16 + (x & 7)) & 255, 255 - x * 16]),
  ],
  [
    'text edges',
    frame(16, 16, (x, y) => (x === 0 || y === 0 || x === y ? [255, 255, 255] : [4, 8, 12])),
  ],
  ['gradient', frame(32, 16, (x, y) => [x * 8, y * 16, (x * 7 + y * 11) & 255])],
  [
    'rounding and equal-distance ties',
    frame(16, 16, (x, y) => [
      ((x & 3) * 64 + (y & 1)) & 255,
      ((y & 7) * 32 + (x & 1)) & 255,
      ((x + y) & 1) === 0 ? 127 : 128,
    ]),
  ],
  ['seeded noise', seededNoise(16, 16, 0x490_2026)],
  ['larger seeded noise', seededNoise(32, 32, 0x490_2027)],
] as const;

describe('exact rgb565 quantization experiment', () => {
  it.each(samples)(
    'matches locked gifenc ordered palettes and mapped indices for %s',
    (_name, rgba) => {
      const candidate = createExactRgb565Quantizer();
      for (const colors of [64, 128, 256]) {
        const expected = quantize(rgba, colors, { format: 'rgb565' });
        const actual = candidate(rgba, colors);
        expect(actual).toEqual(expected);
        expect(applyPalette(rgba, actual, 'rgb565')).toEqual(
          applyPalette(rgba, expected, 'rgb565')
        );
      }
    }
  );

  it('resets all state between distinct and repeated frames', () => {
    const candidate = createExactRgb565Quantizer();
    for (const rgba of [samples[5][1], samples[0][1], samples[3][1], samples[5][1]]) {
      expect(candidate(rgba, 64)).toEqual(quantize(rgba, 64, { format: 'rgb565' }));
    }
  });

  it('rejects non-exact views and unsupported color counts', () => {
    const candidate = createExactRgb565Quantizer();
    const rgba = frame(2, 2, () => [3, 7, 11]);
    expect(() => candidate(rgba.subarray(4), 64)).toThrow(RangeError);
    expect(() => candidate(new Uint8Array(3), 64)).toThrow(RangeError);
    expect(() => candidate(rgba, 257)).toThrow(RangeError);
    expect(candidate(rgba, 64)).toEqual(quantize(rgba, 64, { format: 'rgb565' }));
  });
});
