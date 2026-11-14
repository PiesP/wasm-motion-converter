// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** A bounded content check complementing the main owner's exact Blob identity. */
import { readOwnedRange } from './owned-demux-source-reads';

const EDGE_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 500 * 1024 * 1024;

export async function fingerprintOwnedDemuxSource(
  source: Blob | ArrayBuffer,
  signal?: AbortSignal
): Promise<string> {
  const rangeSource = source instanceof Blob
    ? source
    : {
        size: source.byteLength,
        slice: (start: number, end: number) => ({ arrayBuffer: async () => source.slice(start, end) }),
      };
  if (rangeSource.size < 8 || rangeSource.size > MAX_SOURCE_BYTES)
    throw new Error('Owned demux fingerprint source size invalid');
  const headLength = Math.min(EDGE_BYTES, rangeSource.size);
  const tailLength = Math.min(EDGE_BYTES, rangeSource.size - headLength);
  const head = new Uint8Array(await readOwnedRange(rangeSource, 0, headLength, signal));
  const tail = tailLength > 0
    ? new Uint8Array(await readOwnedRange(rangeSource, rangeSource.size - tailLength, rangeSource.size, signal))
    : new Uint8Array();
  signal?.throwIfAborted();
  if (head.length !== headLength || tail.length !== tailLength)
    throw new Error('Owned demux fingerprint read truncated');
  const data = new Uint8Array(8 + headLength + tailLength);
  new DataView(data.buffer).setBigUint64(0, BigInt(rangeSource.size), true);
  data.set(head, 8);
  data.set(tail, 8 + headLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  signal?.throwIfAborted();
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
