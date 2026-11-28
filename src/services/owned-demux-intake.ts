// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { MAX_FILE_SIZE, MAX_RANGE_MP4_BYTES } from '@utils/constants';

import { readOwnedRange } from './owned-demux-source-reads';

export const EXTENDED_MP4_HEADER_BYTES = 16;
const FTYP = 0x66747970;

type RangeSource = {
  readonly size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
};

export function ownedInputLimit(source: Blob | ArrayBuffer): number {
  return source instanceof Blob ? MAX_RANGE_MP4_BYTES : MAX_FILE_SIZE;
}

/** Admission check for a leading ordinary ftyp box. The core validates the container. */
export function hasExtendedMp4Prefix(bytes: Uint8Array, sourceSize: number): boolean {
  if (bytes.byteLength < EXTENDED_MP4_HEADER_BYTES) return false;
  const prefix = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = prefix.getUint32(0);
  return (
    prefix.getUint32(4) === FTYP &&
    length >= EXTENDED_MP4_HEADER_BYTES &&
    length % 4 === 0 &&
    length <= sourceSize
  );
}

export async function readExtendedMp4Prefix(
  source: RangeSource,
  signal?: AbortSignal
): Promise<boolean> {
  if (source.size <= MAX_FILE_SIZE || source.size > MAX_RANGE_MP4_BYTES) return false;
  try {
    const bytes = await readOwnedRange(source, 0, EXTENDED_MP4_HEADER_BYTES, signal);
    signal?.throwIfAborted();
    return hasExtendedMp4Prefix(new Uint8Array(bytes), source.size);
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}
