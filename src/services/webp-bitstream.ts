// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { VP8_FOURCC, VP8X_FOURCC } from '@utils/constants';

const RIFF_MAGIC = 0x52494646;
const WEBP_MAGIC = 0x57454250;

/** Validate an opaque, full-canvas VP8 keyframe before placing it in ANMF. */
export function validateVp8Frame(frame: Uint8Array, width: number, height: number): void {
  if (
    frame.length < 10 ||
    (frame[0]! & 1) !== 0 ||
    frame[3] !== 0x9d ||
    frame[4] !== 0x01 ||
    frame[5] !== 0x2a
  ) {
    throw new Error('WebP frame is not a VP8 keyframe');
  }
  const codedWidth = (frame[6]! | (frame[7]! << 8)) & 0x3fff;
  const codedHeight = (frame[8]! | (frame[9]! << 8)) & 0x3fff;
  if (codedWidth !== width || codedHeight !== height) {
    throw new Error(
      `WebP VP8 dimensions ${codedWidth}x${codedHeight} do not match ${width}x${height}`
    );
  }
}

/** Return a borrowed VP8 payload only from a complete, opaque WebP container. */
export function extractVp8Chunk(webp: Uint8Array): Uint8Array {
  if (webp.length < 30) throw new Error('WebP container is too small');
  const view = new DataView(webp.buffer, webp.byteOffset, webp.byteLength);
  if (view.getUint32(0, false) !== RIFF_MAGIC || view.getUint32(8, false) !== WEBP_MAGIC) {
    throw new Error('Invalid RIFF/WEBP header');
  }
  if (view.getUint32(4, true) + 8 !== webp.length) throw new Error('Invalid WebP RIFF size');
  let offset = 12;
  let extended = false;
  let vp8: Uint8Array | null = null;
  let vp8xWidth: number | null = null;
  let vp8xHeight: number | null = null;
  while (offset < webp.length) {
    if (offset + 8 > webp.length) throw new Error('Truncated WebP chunk header');
    const fourCC = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size;
    const paddedEnd = end + (size & 1);
    if (!Number.isSafeInteger(paddedEnd) || paddedEnd > webp.length) {
      throw new Error('WebP chunk exceeds RIFF bounds');
    }
    if (size & 1 && webp[end] !== 0) throw new Error('Invalid WebP chunk padding');
    if (fourCC === VP8X_FOURCC) {
      if (offset !== 12 || size !== 10 || extended) throw new Error('Invalid WebP VP8X chunk');
      extended = true;
      const flags = webp[offset + 8]!;
      if (
        flags !== 0 ||
        webp[offset + 9] !== 0 ||
        webp[offset + 10] !== 0 ||
        webp[offset + 11] !== 0
      )
        throw new Error('WebP VP8X has unsupported features');
      vp8xWidth = 1 + webp[offset + 12]! + (webp[offset + 13]! << 8) + (webp[offset + 14]! << 16);
      vp8xHeight = 1 + webp[offset + 15]! + (webp[offset + 16]! << 8) + (webp[offset + 17]! << 16);
    } else if (fourCC === VP8_FOURCC) {
      if (vp8) throw new Error('Duplicate WebP VP8 chunk');
      vp8 = webp.subarray(offset + 8, end);
    } else {
      // Metadata and alpha cannot be preserved by this opaque VP8-only muxer.
      throw new Error('Unsupported WebP chunk or codec');
    }
    offset = paddedEnd;
  }
  if (!vp8) throw new Error('WebP container has no VP8 chunk');
  if (!extended && view.getUint32(12, false) !== VP8_FOURCC) {
    throw new Error('Invalid simple WebP chunk order');
  }
  const codedWidth = (vp8[6]! | (vp8[7]! << 8)) & 0x3fff;
  const codedHeight = (vp8[8]! | (vp8[9]! << 8)) & 0x3fff;
  validateVp8Frame(vp8, vp8xWidth ?? codedWidth, vp8xHeight ?? codedHeight);
  return vp8;
}

/** Canvas WebP can clear the VP8 display bit; restore it for ANMF playback. */
export function extractAndNormalizeCanvasVp8(webp: Uint8Array): Uint8Array {
  const frame = new Uint8Array(extractVp8Chunk(webp));
  frame[0] = frame[0]! | 0x10;
  return frame;
}
