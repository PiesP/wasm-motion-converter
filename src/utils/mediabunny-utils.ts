// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { ENCODED_PACKET_BUDGET_BYTES, MEDIA_BUNNY_BUFFER_BUDGET_BYTES } from '@utils/constants';
import { ALL_FORMATS, BlobSource, BufferSource, Input } from 'mediabunny';

const MAX_ENCODED_PACKET_BYTES = ENCODED_PACKET_BUDGET_BYTES - 1024;

type BoundedInput = Input & {
  _maxContiguousReadBytes: number;
  _maxEncodedPacketBytes: number;
  _maxBufferedPacketBytes: number;
};

function applyMediaBunnyMemoryLimits(input: Input): Input {
  const bounded = input as BoundedInput;
  bounded._maxContiguousReadBytes = MEDIA_BUNNY_BUFFER_BUDGET_BYTES;
  bounded._maxEncodedPacketBytes = MAX_ENCODED_PACKET_BYTES;
  bounded._maxBufferedPacketBytes = MEDIA_BUNNY_BUFFER_BUDGET_BYTES;
  return input;
}

/**
 * Creates a bounded MediaBunny Input from an ArrayBuffer or Blob/File source.
 */
export function createMediaBunnyInput(source: ArrayBuffer | Blob): Input {
  if (source instanceof ArrayBuffer) {
    return applyMediaBunnyMemoryLimits(
      new Input({
        formats: ALL_FORMATS,
        source: new BufferSource(source),
      })
    );
  }
  return applyMediaBunnyMemoryLimits(
    new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(source),
    })
  );
}
