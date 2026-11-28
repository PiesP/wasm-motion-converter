// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

const TS_TICKS_PER_SECOND = 90_000;

/** The archived reference keeps MPEG-TS transport clocks. Compare in presentation ticks. */
export function ownedDemuxFixtureClock(
  id: string,
  packets: ReadonlyArray<{ timestampUs: number }>
) {
  const ticks = (microseconds: number) => Math.round(microseconds * (TS_TICKS_PER_SECOND / 1e6));
  const originTicks = id.endsWith('.ts')
    ? Math.min(...packets.map((packet) => ticks(packet.timestampUs)))
    : null;
  return {
    isTransportStream: originTicks !== null,
    duration: (seconds: number) =>
      originTicks === null
        ? seconds
        : (Math.round(seconds * TS_TICKS_PER_SECOND) - originTicks) / TS_TICKS_PER_SECOND,
    timestampUs: (microseconds: number) =>
      originTicks === null
        ? microseconds
        : Math.trunc(((ticks(microseconds) - originTicks) * 1e6) / TS_TICKS_PER_SECOND),
  };
}
