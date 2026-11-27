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

  it('rejects malformed frame geometry before calling the compressor', () => {
    const compress = vi.fn(referenceImageData);
    const owned = new OwnedGifWriter(64, 8192, () => {}, compress);
    expect(() =>
      owned.writeFrame(Uint8Array.of(0), 0, 1, {
        palette: [[0, 0, 0]],
        colorDepth: 2,
        delay: 20,
      })
    ).toThrow(RangeError);
    expect(compress).not.toHaveBeenCalled();
  });

  it('leaves a part intact when a complete new record would exhaust its final-copy budget', () => {
    const compressed = referenceImageData(Uint8Array.of(0), 2);
    const options = { palette: [[0, 0, 0]], colorDepth: 2, delay: 20 };
    const firstSize = 19 + 19 + 18 + compressed.byteLength + 1;
    const nextSize = firstSize + 18 + compressed.byteLength;
    const capacity = nextSize + 8;
    const limit = capacity + nextSize - 1;
    const writer = new OwnedGifWriter(capacity, limit, () => {}, referenceImageData);
    expect(writer.tryWritePartFrame(compressed, 1, 1, 1, options)).toBe(true);
    expect(writer.partFinalizationBytes()).toBe(capacity + firstSize);
    const first = writer.bytes();
    expect(writer.tryWritePartFrame(compressed, 1, 1, 1, { colorDepth: 2, delay: 20 })).toBe(false);
    expect(writer.bytesView()).toEqual(first);
    expect(writer.stream.buffer.byteLength).toBe(capacity);
    writer.finish();
    expect(writer.bytes()).toEqual(Uint8Array.of(...first, 0x3b));
  });

  it('accepts a projected peak equal to the target and refuses the next record before mutation', () => {
    const compressed = referenceImageData(Uint8Array.of(0), 2);
    const frame = { colorDepth: 2, delay: 20 };
    const firstFrame = { ...frame, palette: [[0, 0, 0]] };
    const recordBytes = 18 + compressed.byteLength;
    const capacity = 19 + 19 + 3 * recordBytes + 1;
    const targetPeak = capacity + 19 + 19 + 2 * recordBytes + 1;
    const assertPeak = vi.fn();
    const writer = new OwnedGifWriter(capacity, 8192, assertPeak, referenceImageData);

    expect(writer.tryWritePartFrame(compressed, 1, 1, 1, firstFrame, targetPeak)).toBe(true);
    expect(writer.tryWritePartFrame(compressed, 1, 1, 1, frame, targetPeak)).toBe(true);
    expect(writer.partFinalizationBytes()).toBe(targetPeak);
    const partBytes = writer.bytes();
    const backing = writer.stream.buffer;
    assertPeak.mockClear();

    expect(writer.tryWritePartFrame(compressed, 1, 1, 1, frame, targetPeak)).toBe(false);
    expect(assertPeak).not.toHaveBeenCalled();
    expect(writer.stream.buffer).toBe(backing);
    expect(writer.bytesView()).toEqual(partBytes);
  });

  it('allows an oversize first record within the hard limit and rolls over before adding another', () => {
    const compressed = referenceImageData(Uint8Array.of(0), 2);
    const frame = { colorDepth: 2, delay: 20 };
    const firstFrame = { ...frame, palette: [[0, 0, 0]] };
    const recordBytes = 18 + compressed.byteLength;
    const capacity = 19 + 19 + 2 * recordBytes + 1;
    const targetPeak = capacity + 19 + 19 + recordBytes;
    const writer = new OwnedGifWriter(capacity, 8192, () => {}, referenceImageData);

    expect(writer.tryWritePartFrame(compressed, 1, 1, 1, firstFrame, targetPeak)).toBe(true);
    expect(writer.partFinalizationBytes()).toBe(targetPeak + 1);
    const partBytes = writer.bytes();
    expect(writer.tryWritePartFrame(compressed, 1, 1, 1, frame, targetPeak)).toBe(false);
    writer.finish();
    expect(writer.bytes()).toEqual(Uint8Array.of(...partBytes, 0x3b));

    const hardWriter = new OwnedGifWriter(capacity, targetPeak, () => {}, referenceImageData);
    expect(hardWriter.tryWritePartFrame(compressed, 1, 1, 1, firstFrame, targetPeak)).toBe(false);
    expect(hardWriter.bytesView()).toHaveLength(0);
  });

  it.each([0, 1, 2, 3, 10, 65535])(
    'writes total playback count %i without changing frame data',
    (count) => {
      const encode = (playCount: number) => {
        const writer = new OwnedGifWriter(64, 8192, () => {}, referenceImageData, playCount);
        const palette = [
          [0, 0, 0],
          [255, 255, 255],
        ];
        writer.writeFrame(Uint8Array.of(0, 1), 2, 1, { palette, colorDepth: 2, delay: 20 });
        writer.writeFrame(Uint8Array.of(1, 0), 2, 1, { colorDepth: 2, delay: 40 });
        writer.finish();
        return writer.bytes();
      };
      const baseline = encode(0);
      const actual = encode(count);
      const extensionStart = 19;
      expect(String.fromCharCode(...baseline.subarray(22, 33))).toBe('NETSCAPE2.0');
      if (count === 1) {
        const before = baseline.subarray(0, extensionStart);
        const after = baseline.subarray(extensionStart + 19);
        expect(actual).toEqual(Uint8Array.from([...before, ...after]));
      } else {
        const expected = baseline.slice();
        const view = new DataView(expected.buffer);
        const repeat = count === 0 ? 0 : count - 1;
        view.setUint16(extensionStart + 16, repeat, true);
        expect(actual).toEqual(expected);
      }
    }
  );

  it.each([-1, 1.5, 65536, NaN, Infinity])('rejects invalid playback count %s', (count) => {
    const createWriter = () => new OwnedGifWriter(64, 8192, () => {}, referenceImageData, count);
    expect(createWriter).toThrow(RangeError);
  });
});
