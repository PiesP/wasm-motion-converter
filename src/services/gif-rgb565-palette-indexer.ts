// SPDX-License-Identifier: MIT
// Copyright (c) 2017 Matt DesLauriers
// Copyright (c) 2026 PiesP

/** Fixed cache storage retained by one RGB565 palette indexer. */
export const GIF_RGB565_PALETTE_CACHE_BYTES =
  65_536 * (Uint16Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT);

/**
 * Maps RGBA pixels to a GIF palette while reusing the RGB565 lookup storage.
 *
 * RGB565 packing and nearest-color tie behavior follow gifenc 1.0.3's
 * MIT-licensed applyPalette implementation. Cache entries remain frame-local:
 * the first source RGB observed for a bin determines that bin's index for the
 * current frame, matching gifenc even when later pixels share the packed key.
 */
export class GifRgb565PaletteIndexer {
  private readonly generations = new Uint16Array(65_536);
  private readonly indices = new Uint8Array(65_536);
  private generation = 0;

  apply(rgba: Uint8Array | Uint8ClampedArray, palette: number[][]): Uint8Array {
    if (palette.length > 256) {
      throw new Error('applyPalette() only works with 256 colors or less');
    }
    if (rgba.byteLength % 4 !== 0) {
      throw new RangeError('RGB565 palette input must contain complete RGBA pixels');
    }

    const frameGeneration = this.nextGeneration();
    const indexed = new Uint8Array(rgba.byteLength / 4);

    for (let sourceOffset = 0, pixelIndex = 0; sourceOffset < rgba.byteLength; ) {
      const r = rgba[sourceOffset++]!;
      const g = rgba[sourceOffset++]!;
      const b = rgba[sourceOffset++]!;
      sourceOffset++;

      const key = ((r << 8) & 0xf800) | ((g << 2) & 0x03e0) | (b >> 3);
      if (this.generations[key] !== frameGeneration) {
        this.indices[key] = nearestPaletteIndex(r, g, b, palette);
        this.generations[key] = frameGeneration;
      }
      indexed[pixelIndex++] = this.indices[key]!;
    }

    return indexed;
  }

  private nextGeneration(): number {
    if (this.generation === 0xffff) {
      // Generation zero is reserved for unused entries. Clear before reusing
      // generation one so a stale entry cannot become visible after wraparound.
      this.generations.fill(0);
      this.generation = 1;
      return this.generation;
    }

    this.generation++;
    return this.generation;
  }
}

function nearestPaletteIndex(r: number, g: number, b: number, palette: number[][]): number {
  let nearestIndex = 0;
  let nearestDistance = 1e100;

  for (let index = 0; index < palette.length; index++) {
    const color = palette[index]!;
    const redDistance = color[0]! - r;
    let distance = redDistance * redDistance;
    if (distance > nearestDistance) continue;

    const greenDistance = color[1]! - g;
    distance += greenDistance * greenDistance;
    if (distance > nearestDistance) continue;

    const blueDistance = color[2]! - b;
    distance += blueDistance * blueDistance;
    if (distance > nearestDistance) continue;

    nearestDistance = distance;
    nearestIndex = index;
  }

  return nearestIndex;
}
