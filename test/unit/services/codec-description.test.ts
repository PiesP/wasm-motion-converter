// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it } from 'vitest';
import { copyBoundedCodecDescription } from '@services/codec-description';
import { MAX_CODEC_DESCRIPTION_BYTES } from '@utils/constants';

describe('copyBoundedCodecDescription', () => {
  it('copies only the exact view range into an isolated ArrayBuffer', () => {
    const backing = new Uint8Array([0xaa, 0x01, 0xab, 0xff, 0xbb]);
    const view = new DataView(backing.buffer, 1, 3);

    const result = copyBoundedCodecDescription(view);

    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(result!)).toEqual(new Uint8Array([0x01, 0xab, 0xff]));
    expect(result).not.toBe(backing.buffer);
  });

  it('accepts an empty binary description', () => {
    expect(copyBoundedCodecDescription(new ArrayBuffer(0))?.byteLength).toBe(0);
  });

  it('rejects non-binary descriptions before copying', () => {
    expect(() => copyBoundedCodecDescription('01abff')).toThrow(
      'Video codec description must be binary data'
    );
  });

  it('rejects descriptions above the codec-specific byte ceiling', () => {
    const oversized = new ArrayBuffer(MAX_CODEC_DESCRIPTION_BYTES + 1);

    expect(() => copyBoundedCodecDescription(oversized)).toThrow(
      `Video codec description exceeds ${MAX_CODEC_DESCRIPTION_BYTES} byte limit`
    );
  });
});
