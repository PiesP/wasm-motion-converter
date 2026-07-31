// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { extractAndNormalizeCanvasVp8 } from '@services/webp-bitstream';

function makeSimpleWebp(bitstream: number[]): Uint8Array {
  const output = new Uint8Array(20 + bitstream.length);
  output.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  output.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  output.set([0x56, 0x50, 0x38, 0x20], 12); // VP8
  new DataView(output.buffer).setUint32(16, bitstream.length, true);
  output.set(bitstream, 20);
  return output;
}

describe('extractAndNormalizeCanvasVp8', () => {
  it('sets show-frame in the frame tag without changing profile or coded width', () => {
    const input = makeSimpleWebp([0x06, 0, 0, 0x9d, 0x01, 0x2a, 0xa0, 0]);

    const output = extractAndNormalizeCanvasVp8(input);

    expect(output).toEqual(new Uint8Array([0x16, 0, 0, 0x9d, 0x01, 0x2a, 0xa0, 0]));
    expect(output.buffer).not.toBe(input.buffer);
  });

  it('returns the extracted frame unchanged when no keyframe tag is present', () => {
    const input = makeSimpleWebp([1, 2, 3, 4]);

    expect(extractAndNormalizeCanvasVp8(input)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});
