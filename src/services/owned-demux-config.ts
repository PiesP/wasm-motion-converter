// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ContainerVideoDecoderConfig } from '@t/conversion-types';

import { copyBoundedCodecDescription } from './codec-description';
import type { OwnedDemuxTrack } from './owned-demux-session';

const primaries: Readonly<Record<number, VideoColorPrimaries | 'bt2020' | 'smpte432'>> = {
  1: 'bt709',
  5: 'bt470bg',
  6: 'smpte170m',
  9: 'bt2020',
  12: 'smpte432',
};
const transfers: Readonly<Record<number, VideoTransferCharacteristics | 'linear' | 'pq' | 'hlg'>> =
  {
    1: 'bt709',
    6: 'smpte170m',
    8: 'linear',
    13: 'iec61966-2-1',
    16: 'pq',
    18: 'hlg',
  };
const matrices: Readonly<Record<number, VideoMatrixCoefficients | 'bt2020-ncl'>> = {
  0: 'rgb',
  1: 'bt709',
  5: 'bt470bg',
  6: 'smpte170m',
  9: 'bt2020-ncl',
};
const decimal = (value: number): string => String(value).padStart(2, '0');

/** Formatting of checked decoder configuration records; container parsing stays in Rust. */
function codecString(track: OwnedDemuxTrack): string {
  if (track.codecString !== null) {
    if (!/^[a-zA-Z0-9.]{1,128}$/.test(track.codecString))
      throw new Error('Invalid owned decoder codec string');
    return track.codecString;
  }
  const bytes = track.description;
  if (track.codec === 'avc1' || track.codec === 'avc3') {
    if (bytes.length < 7 || bytes[0] !== 1) throw new Error('Invalid owned AVC configuration');
    return `avc1.${Array.from(bytes.subarray(1, 4), (v) => v.toString(16).padStart(2, '0')).join('')}`;
  }
  if (track.codec === 'hev1' || track.codec === 'hvc1') {
    if (bytes.length < 23 || bytes[0] !== 1) throw new Error('Invalid owned HEVC configuration');
    const profile = bytes[1]! & 31;
    const space = ['', 'A', 'B', 'C'][bytes[1]! >>> 6]!;
    const tier = bytes[1]! & 32 ? 'H' : 'L';
    let compatibility = 0;
    for (let i = 0; i < 32; i++)
      compatibility += ((bytes[2 + (i >>> 3)]! >>> (7 - (i & 7))) & 1) * 2 ** i;
    let end = 12;
    while (end > 6 && bytes[end - 1] === 0) end--;
    const constraints = Array.from(bytes.subarray(6, end), (v) =>
      v.toString(16).toUpperCase()
    ).join('.');
    return `hev1.${space}${profile}.${compatibility.toString(16).toUpperCase()}.${tier}${bytes[12]}${constraints ? `.${constraints}` : ''}`;
  }
  if (track.codec === 'VP80' || track.codec === 'vp08') return 'vp8';
  if (track.codec === 'VP90' || track.codec === 'vp09') {
    if (bytes.length < 12)
      throw new Error('Owned VP9 configuration requires a probed keyframe or vpcC');
    const flags = bytes[6]!;
    return `vp09.${[bytes[4]!, bytes[5]!, flags >>> 4, (flags >>> 1) & 7, bytes[7]!, bytes[8]!, bytes[9]!, flags & 1].map(decimal).join('.')}`;
  }
  if (track.codec === 'AV01' || track.codec === 'av01') {
    if (bytes.length < 4 || bytes[0] !== 0x81) throw new Error('Invalid owned AV1 configuration');
    const flags = bytes[2]!;
    const depth = flags & 64 ? (flags & 32 ? 12 : 10) : 8;
    return `av01.${bytes[1]! >>> 5}.${decimal(bytes[1]! & 31)}${flags & 128 ? 'H' : 'M'}.${decimal(depth)}`;
  }
  throw new Error(`Unsupported owned video codec ${track.codec}`);
}

export function ownedDecoderConfig(track: OwnedDemuxTrack): ContainerVideoDecoderConfig {
  for (const value of [track.width, track.height, track.displayWidth, track.displayHeight]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 0xffff_ffff)
      throw new Error('Invalid owned video geometry');
  }
  const p = primaries[track.colorPrimaries],
    t = transfers[track.colorTransfer],
    m = matrices[track.colorMatrix];
  const retainDescription =
    ['avc1', 'avc3', 'hvc1', 'hev1'].includes(track.codec) && track.description.length > 0;
  const description = retainDescription
    ? copyBoundedCodecDescription(track.description)
    : undefined;
  return {
    codec: codecString(track),
    codedWidth: track.width,
    codedHeight: track.height,
    ...(description !== undefined ? { description } : {}),
    ...(track.displayWidth !== track.width || track.displayHeight !== track.height
      ? {
          displayAspectWidth: track.displayWidth,
          displayAspectHeight: track.displayHeight,
        }
      : {}),
    // The pinned DOM declarations contain only the older SDR enum subset.
    // Preserve the current WebCodecs CICP names already emitted by the oracle;
    // this assertion is confined to the checked native configuration boundary.
    colorSpace: {
      ...(p ? { primaries: p } : {}),
      ...(t ? { transfer: t } : {}),
      ...(m ? { matrix: m } : {}),
      fullRange: track.colorFullRange === 1,
    } as VideoColorSpaceInit,
  };
}

/** Checked original-timebase conversion, preserving the existing safe-number truncation boundary. */
export function ownedTimestampUs(ticks: bigint, timescale: number): number {
  if (!Number.isSafeInteger(timescale) || timescale < 1 || timescale > 0xffff_ffff)
    throw new RangeError('Invalid owned video timebase');
  const bound = BigInt(Number.MAX_SAFE_INTEGER);
  const exact = (ticks * 1_000_000n) / BigInt(timescale);
  if (ticks < -bound || ticks > bound || exact < -bound || exact > bound)
    throw new RangeError('Owned video timestamp exceeds safe WebCodecs range');
  // The pinned reference uses an epsilon-tilted multiplier before truncation,
  // avoiding a one-microsecond underflow at boundaries such as 123/120 seconds.
  // Preserve that public boundary only after checked wide-integer admission.
  const result = Math.trunc((Number(ticks) / timescale) * (1_000_000 * (1 + Number.EPSILON)));
  if (!Number.isSafeInteger(result) || Math.abs(result - Number(exact)) > 1)
    throw new RangeError('Owned video timestamp rounding exceeds its checked bound');
  return result;
}
