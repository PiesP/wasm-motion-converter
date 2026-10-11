// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { extractCanvasWebp, extractVp8Chunk } from '@services/webp-bitstream';

function makeIccWebp(profile: number[]): Uint8Array {
  const frame = [0x06, 0, 0, 0x9d, 0x01, 0x2a, 2, 0, 2, 0];
  const output = new Uint8Array(12 + 18 + 8 + profile.length + (profile.length & 1) + 8 + frame.length);
  const view = new DataView(output.buffer);
  output.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, output.length - 8, true);
  output.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 8);
  view.setUint32(16, 10, true);
  output[20] = 0x20;
  output[24] = 1;
  output[27] = 1;
  output.set([0x49, 0x43, 0x43, 0x50], 30);
  view.setUint32(34, profile.length, true);
  output.set(profile, 38);
  const vp8Offset = 38 + profile.length + (profile.length & 1);
  output.set([0x56, 0x50, 0x38, 0x20], vp8Offset);
  view.setUint32(vp8Offset + 4, frame.length, true);
  output.set(frame, vp8Offset + 8);
  return output;
}

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

describe('extractCanvasWebp', () => {
  it('preserves a Canvas ICC profile while keeping the WASM parser strict', () => {
    const input = makeIccWebp([1, 2, 3]);
    const parsed = extractCanvasWebp(input);
    expect(parsed.bitstream[0]).toBe(0x16);
    expect(parsed.iccProfile).toEqual(new Uint8Array([1, 2, 3]));
    expect(() => extractVp8Chunk(input)).toThrow('unsupported features');
    const missingFlag = new Uint8Array(input);
    missingFlag[20] = 0;
    expect(() => extractCanvasWebp(missingFlag)).toThrow('ICCP');
    const wrongOrder = new Uint8Array(input);
    wrongOrder.set([0x56, 0x50, 0x38, 0x20], 30);
    expect(() => extractCanvasWebp(wrongOrder)).toThrow();
  });
  it('sets show-frame in the frame tag without changing profile or coded width', () => {
    const input = makeSimpleWebp([0x06, 0, 0, 0x9d, 0x01, 0x2a, 0xa0, 0, 2, 0]);

    const output = extractCanvasWebp(input).bitstream;

    expect(output).toEqual(new Uint8Array([0x16, 0, 0, 0x9d, 0x01, 0x2a, 0xa0, 0, 2, 0]));
    expect(output.buffer).not.toBe(input.buffer);
  });

  it('rejects a frame without a keyframe tag', () => {
    const input = makeSimpleWebp([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    expect(() => extractCanvasWebp(input)).toThrow('VP8 keyframe');
  });

  it('rejects corrupt RIFF sizes, padding, and a lossless codec', () => {
    const valid = makeSimpleWebp([0x10, 0, 0, 0x9d, 0x01, 0x2a, 2, 0, 2, 0, 1]);
    const badSize = new Uint8Array(valid);
    new DataView(badSize.buffer).setUint32(4, badSize.length - 9, true);
    expect(() => extractCanvasWebp(badSize)).toThrow('RIFF size');
    const badPad = new Uint8Array(valid);
    badPad[badPad.length - 1] = 1;
    expect(() => extractCanvasWebp(badPad)).toThrow('padding');
    const lossless = new Uint8Array(valid);
    lossless[15] = 0x4c;
    expect(() => extractCanvasWebp(lossless)).toThrow('Unsupported');
  });
});
