// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { extractAndNormalizeCanvasVp8 } from '@services/webp-bitstream';

function makeSimpleWebp(bitstream: number[]): Uint8Array {
  const output = new Uint8Array(20 + bitstream.length + (bitstream.length & 1));
  output.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  new DataView(output.buffer).setUint32(4, output.length - 8, true);
  output.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  output.set([0x56, 0x50, 0x38, 0x20], 12); // VP8
  new DataView(output.buffer).setUint32(16, bitstream.length, true);
  output.set(bitstream, 20);
  return output;
}

describe('extractAndNormalizeCanvasVp8', () => {
  it('sets show-frame in the frame tag without changing profile or coded width', () => {
    const input = makeSimpleWebp([0x06, 0, 0, 0x9d, 0x01, 0x2a, 0xa0, 0, 2, 0]);

    const output = extractAndNormalizeCanvasVp8(input);

    expect(output).toEqual(new Uint8Array([0x16, 0, 0, 0x9d, 0x01, 0x2a, 0xa0, 0, 2, 0]));
    expect(output.buffer).not.toBe(input.buffer);
  });

  it('rejects a frame without a keyframe tag', () => {
    const input = makeSimpleWebp([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    expect(() => extractAndNormalizeCanvasVp8(input)).toThrow('VP8 keyframe');
  });

  it('rejects corrupt RIFF sizes, padding, and a lossless codec', () => {
    const valid = makeSimpleWebp([0x10, 0, 0, 0x9d, 0x01, 0x2a, 2, 0, 2, 0, 1]);
    const badSize = new Uint8Array(valid);
    new DataView(badSize.buffer).setUint32(4, badSize.length - 9, true);
    expect(() => extractAndNormalizeCanvasVp8(badSize)).toThrow('RIFF size');
    const badPad = new Uint8Array(valid);
    badPad[badPad.length - 1] = 1;
    expect(() => extractAndNormalizeCanvasVp8(badPad)).toThrow('padding');
    const lossless = new Uint8Array(valid);
    lossless[15] = 0x4c;
    expect(() => extractAndNormalizeCanvasVp8(lossless)).toThrow('Unsupported');
  });
});
