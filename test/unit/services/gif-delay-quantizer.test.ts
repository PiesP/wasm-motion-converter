// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createGifDelayQuantizer } from '@services/gif-encoder-service';

describe('GIF delay quantization', () => {
  it('distributes fractional centiseconds instead of accumulating frame rounding error', () => {
    const quantize = createGifDelayQuantizer();
    const encodedDelays = Array.from({ length: 45 }, () => 1_000 / 15).map(quantize);

    expect(encodedDelays.reduce((total, delay) => total + delay, 0)).toBe(300);
    expect(new Set(encodedDelays)).toEqual(new Set([6, 7]));
  });

  it('preserves an encoder minimum-delay adjustment in the cumulative total', () => {
    const quantize = createGifDelayQuantizer();
    const sourceDelays = [
      20,
      ...Array.from({ length: 44 }, () => 1_000 / 15),
      175 / 3,
    ];

    expect(sourceDelays.map(quantize).reduce((total, delay) => total + delay, 0)).toBe(301);
  });
});
