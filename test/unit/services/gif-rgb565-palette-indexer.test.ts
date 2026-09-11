// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import {
  GIF_RGB565_PALETTE_CACHE_BYTES,
  GifRgb565PaletteIndexer,
} from '@services/gif-rgb565-palette-indexer';
import { applyPalette } from 'gifenc';
import { describe, expect, it } from 'vitest';

function referenceApply(
  rgba: Uint8Array | Uint8ClampedArray,
  palette: number[][]
): Uint8Array {
  // gifenc 1.0.3 reads the complete backing buffer. Give it the exact byte
  // range so offset-view cases exercise the same pixels as the indexer.
  return applyPalette(Uint8Array.from(rgba), palette, 'rgb565');
}

function createDeterministicBytes(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state >>> 24;
  };
}

describe('GifRgb565PaletteIndexer', () => {
  it('matches gifenc across deterministic frames and palette sizes', () => {
    const nextByte = createDeterministicBytes(0x5eed_cafe);
    const indexer = new GifRgb565PaletteIndexer();

    for (const paletteSize of [0, 1, 2, 64, 128, 256]) {
      const palette = Array.from({ length: paletteSize }, () => [
        nextByte(),
        nextByte(),
        nextByte(),
      ]);

      for (let frame = 0; frame < 6; frame++) {
        const rgba = new Uint8Array(257 * 4);
        for (let offset = 0; offset < rgba.byteLength; offset += 4) {
          rgba[offset] = nextByte();
          rgba[offset + 1] = nextByte();
          rgba[offset + 2] = nextByte();
          rgba[offset + 3] = nextByte();
        }

        expect(indexer.apply(rgba, palette)).toEqual(referenceApply(rgba, palette));
      }
    }
  });

  it('matches gifenc last-index wins behavior for equal distances', () => {
    const rgba = new Uint8Array([1, 0, 0, 255]);
    const palette = [
      [0, 0, 0],
      [2, 0, 0],
    ];

    const actual = new GifRgb565PaletteIndexer().apply(rgba, palette);

    expect(actual).toEqual(referenceApply(rgba, palette));
    expect(actual).toEqual(new Uint8Array([1]));
  });

  it('uses the first source RGB in each RGB565 bin independently per frame', () => {
    const palette = [
      [0, 0, 0],
      [7, 0, 0],
    ];
    const lowFirst = new Uint8Array([0, 0, 0, 255, 7, 0, 0, 255]);
    const highFirst = new Uint8Array([7, 0, 0, 255, 0, 0, 0, 255]);
    const indexer = new GifRgb565PaletteIndexer();

    const firstFrame = indexer.apply(lowFirst, palette);
    const secondFrame = indexer.apply(highFirst, palette);

    expect(firstFrame).toEqual(referenceApply(lowFirst, palette));
    expect(firstFrame).toEqual(new Uint8Array([0, 0]));
    expect(secondFrame).toEqual(referenceApply(highFirst, palette));
    expect(secondFrame).toEqual(new Uint8Array([1, 1]));
  });

  it('clears stale generation markers before the Uint16 generation wraps', () => {
    const palette = [
      [0, 0, 0],
      [7, 0, 0],
    ];
    const originalBinValue = new Uint8Array([0, 0, 0, 255]);
    const otherBinValue = new Uint8Array([8, 0, 0, 255]);
    const wrappedBinValue = new Uint8Array([7, 0, 0, 255]);
    const indexer = new GifRgb565PaletteIndexer();

    expect(indexer.apply(originalBinValue, palette)).toEqual(new Uint8Array([0]));
    for (let frame = 0; frame < 65_534; frame++) {
      indexer.apply(otherBinValue, palette);
    }

    const wrappedFrame = indexer.apply(wrappedBinValue, palette);
    expect(wrappedFrame).toEqual(referenceApply(wrappedBinValue, palette));
    expect(wrappedFrame).toEqual(new Uint8Array([1]));
  });

  it('supports palette boundaries and rejects more than 256 colors', () => {
    const rgba = new Uint8Array([12, 34, 56, 255]);
    const indexer = new GifRgb565PaletteIndexer();
    const fullPalette = Array.from({ length: 256 }, () => [12, 34, 56]);

    expect(indexer.apply(rgba, [])).toEqual(referenceApply(rgba, []));
    expect(indexer.apply(rgba, [[12, 34, 56]])).toEqual(new Uint8Array([0]));
    const fullPaletteResult = indexer.apply(rgba, fullPalette);
    expect(fullPaletteResult).toEqual(referenceApply(rgba, fullPalette));
    expect(fullPaletteResult).toEqual(new Uint8Array([255]));
    expect(() => indexer.apply(rgba, [...fullPalette, [0, 0, 0]])).toThrow(
      'applyPalette() only works with 256 colors or less'
    );
  });

  it('reads only the requested RGBA byte view and returns exact index storage', () => {
    const pixels = new Uint8Array([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
    ]);
    const backing = new Uint8Array(pixels.byteLength + 11).fill(0xa5);
    backing.set(pixels, 5);
    const offsetView = new Uint8ClampedArray(backing.buffer, 5, pixels.byteLength);
    const palette = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ];

    const actual = new GifRgb565PaletteIndexer().apply(offsetView, palette);

    expect(actual).toEqual(referenceApply(offsetView, palette));
    expect(actual.byteLength).toBe(3);
    expect(actual.buffer.byteLength).toBe(3);
  });

  it('declares the fixed generation and index table allocation', () => {
    expect(GIF_RGB565_PALETTE_CACHE_BYTES).toBe(196_608);
  });
});
