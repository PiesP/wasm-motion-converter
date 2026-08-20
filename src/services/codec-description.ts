// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { MAX_CODEC_DESCRIPTION_BYTES } from '@utils/constants';

function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
  return typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer;
}

export function isBoundedCodecDescription(
  description: unknown
): description is ArrayBuffer | undefined {
  return (
    description === undefined ||
    (description instanceof ArrayBuffer && description.byteLength <= MAX_CODEC_DESCRIPTION_BYTES)
  );
}

/**
 * Copy codec-private bytes into an isolated, size-bounded ArrayBuffer.
 *
 * Media parsers may return a view into a much larger container allocation, so
 * preserve only the exact view range before retaining or cloning it.
 */
export function copyBoundedCodecDescription(description: unknown): ArrayBuffer | undefined {
  if (description === undefined) return undefined;

  let bytes: Uint8Array;
  if (ArrayBuffer.isView(description)) {
    bytes = new Uint8Array(description.buffer, description.byteOffset, description.byteLength);
  } else if (description instanceof ArrayBuffer || isSharedArrayBuffer(description)) {
    bytes = new Uint8Array(description);
  } else {
    throw new Error('Video codec description must be binary data');
  }

  if (bytes.byteLength > MAX_CODEC_DESCRIPTION_BYTES) {
    throw new Error(`Video codec description exceeds ${MAX_CODEC_DESCRIPTION_BYTES} byte limit`);
  }

  return bytes.slice().buffer;
}
