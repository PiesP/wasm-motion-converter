// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { OwnedGifWriter } from '@services/gif-owned-writer';
import { GIFEncoder } from 'gifenc';
import { describe, expect, it, vi } from 'vite-plus/test';

function referenceImageData(indices: Uint8Array, depth: number): Uint8Array {
  const palette = Array.from({ length: 1 << depth }, (_, index) => [index, index, index]);
  const reference = GIFEncoder({ auto: true });
  reference.writeFrame(indices, indices.byteLength, 1, {
    palette,
    colorDepth: depth,
    repeat: 0,
    delay: 20,
  });
  reference.finish();
  return reference.bytes().subarray(6 + 7 + palette.length * 3 + 19 + 8 + 10, -1);
}

describe('owned GIF89a writer', () => {
  it('matches gifenc bytes for global and local palettes, delay, repeat and termination', () => {
    const firstPalette = [
      [255, 0, 0],
      [0, 0, 255],
    ];
    const secondPalette = [
      [0, 255, 0],
      [0, 0, 255],
    ];
    const frames = [
      {
        indices: Uint8Array.from([0, 1, 0, 1]),
        options: { palette: firstPalette, colorDepth: 2, repeat: 0, delay: 20 },
      },
      {
        indices: Uint8Array.from([1, 0, 1, 0]),
        options: { palette: secondPalette, colorDepth: 2, repeat: 0, delay: 2000 },
      },
      { indices: Uint8Array.from([0, 0, 1, 1]), options: { colorDepth: 2, repeat: 0, delay: 40 } },
    ];
    const owned = new OwnedGifWriter(64, 8192, () => {}, referenceImageData);
    const reference = GIFEncoder({ auto: true });
    for (const { indices, options } of frames) {
      owned.writeFrame(indices, 2, 2, options);
      reference.writeFrame(indices, 2, 2, options);
    }
    owned.finish();
    reference.finish();
    expect(owned.bytes()).toEqual(reference.bytes());
    expect(owned.bytesView()).toEqual(reference.bytes());
  });

  it('rejects malformed frame geometry and repeat before calling the compressor', () => {
    const compress = vi.fn(referenceImageData);
    const owned = new OwnedGifWriter(64, 8192, () => {}, compress);
    expect(() =>
      owned.writeFrame(Uint8Array.of(0), 0, 1, {
        palette: [[0, 0, 0]],
        colorDepth: 2,
        repeat: 0,
        delay: 20,
      })
    ).toThrow(RangeError);
    expect(() =>
      owned.writeFrame(Uint8Array.of(0), 1, 1, {
        palette: [[0, 0, 0]],
        colorDepth: 2,
        repeat: 1,
        delay: 20,
      })
    ).toThrow(RangeError);
    expect(compress).not.toHaveBeenCalled();
  });
});
