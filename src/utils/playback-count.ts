// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Zero means infinite playback; positive values count the initial play. */
export const DEFAULT_PLAY_COUNT = 0;
export const MAX_PLAY_COUNT = 0xffff;
export const DEFAULT_CUSTOM_PLAY_COUNT = 3;

export function isPlayCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_PLAY_COUNT;
}

export function resolvePlayCount(value: unknown = DEFAULT_PLAY_COUNT): number {
  if (!isPlayCount(value)) throw new RangeError('Invalid playback count');
  return value;
}

/** No GIF application extension means one play; zero means forever. */
export function toGifRepeat(playCount: number): number | null {
  const count = resolvePlayCount(playCount);
  return count === 1 ? null : count === 0 ? 0 : count - 1;
}

export function parseCustomPlayCount(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const count = Number(value);
  return isPlayCount(count) && count >= 2 ? count : undefined;
}
