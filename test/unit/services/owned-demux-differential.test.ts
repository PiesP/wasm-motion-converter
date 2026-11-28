// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ownedDecoderConfig, ownedTimestampUs } from '@services/owned-demux-config';
import {
  classifyOwnedDemuxError,
  computeOwnedPacketStats,
  OwnedDemuxParseError,
  OwnedDemuxResourceError,
} from '@services/owned-demux-core';
import { OwnedDemuxSession } from '@services/owned-demux-session';
import type { OwnedDemuxPacket } from '@services/owned-demux-session';
import { EncodedPacket } from 'mediabunny';
import { beforeAll, describe, expect, it, vi } from 'vite-plus/test';

import { ownedDemuxFixtureClock } from '../../helpers/owned-demux-fixture-clock';

type ExpectedPacket = {
  sequence?: number;
  timestampUs: number;
  durationUs: number;
  size: number;
  type: string;
  sha256: string;
};
type Fixture = {
  id: string;
  input: { size: number; sha256: string };
  config: Record<string, unknown>;
  duration: number;
  stats: { averagePacketRate: number; averageBitrate: number };
  rotation: number;
  packets: ExpectedPacket[];
  seek: Array<{ seconds: number; packet: ExpectedPacket | null }>;
};
const fixtureRoot = resolve('test/fixtures/owned-demux');
const fixtureSet = JSON.parse(readFileSync(resolve(fixtureRoot, 'oracle.json'), 'utf8')) as {
  fixtures: Fixture[];
};
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let module: WebAssembly.Module;
beforeAll(async () => {
  const bytes = readFileSync(resolve('src/services/owned-demux.wasm'));
  module = await WebAssembly.compile(bytes);
});

function normalizedConfig(session: OwnedDemuxSession): Record<string, unknown> {
  const config = ownedDecoderConfig(session.track());
  const description = config.description;
  return {
    ...config,
    description: description ? Buffer.from(description as ArrayBuffer).toString('hex') : null,
  };
}

async function normalizedPacket(
  session: OwnedDemuxSession,
  packet: OwnedDemuxPacket
): Promise<ExpectedPacket> {
  const bytes = new Uint8Array(await session.readPacket(packet));
  const scale = session.track().timescale;
  return {
    timestampUs: ownedTimestampUs(packet.ptsTicks, scale),
    durationUs: ownedTimestampUs(packet.durationTicks, scale),
    size: bytes.length,
    type: packet.key ? 'key' : 'delta',
    sha256: sha(bytes),
  };
}

describe('actual compiled owned demux versus pinned patched development oracle', () => {
  for (const fixture of fixtureSet.fixtures) {
    it(`preserves full decoder configuration, packet order and verified seeks: ${fixture.id}`, async () => {
      const bytes = Buffer.from(
        readFileSync(resolve(fixtureRoot, fixture.id + '.base64'), 'utf8'),
        'base64'
      );
      expect(bytes.length).toBe(fixture.input.size);
      expect(sha(bytes)).toBe(fixture.input.sha256);
      const clock = ownedDemuxFixtureClock(fixture.id, fixture.packets);
      const packets = fixture.packets.map(({ sequence: _sequence, ...packet }) => ({
        ...packet,
        timestampUs: clock.timestampUs(packet.timestampUs),
      }));
      expect(fixture.packets.map((packet) => packet.sequence)).toEqual(
        packets.map((_, index) => index)
      );
      const seeks = fixture.seek.map((seek) => ({
        ...seek,
        packet: clock.isTransportStream
          ? (packets
              .filter((packet) => packet.type === 'key' && packet.timestampUs <= seek.seconds * 1e6)
              .sort((a, b) => b.timestampUs - a.timestampUs)[0] ?? null)
          : seek.packet,
      }));
      const session = new OwnedDemuxSession(new Blob([bytes]), module);
      try {
        const track = await session.analyze();
        expect(normalizedConfig(session)).toEqual(fixture.config);
        expect(Number(track.durationTicks) / track.timescale).toBe(
          clock.duration(fixture.duration)
        );
        expect(track.rotation).toBe(fixture.rotation);
        expect(track.packetCount).toBe(fixture.packets.length);
        const seekBytes = fixture.packets.filter((packet) => packet.type === 'key').length * 12;
        expect(session.seekWorkspaceBytes).toBe(seekBytes);
        expect(await computeOwnedPacketStats(session, track)).toEqual({
          averagePacketRate: fixture.stats.averagePacketRate,
          averageBitrate: fixture.stats.averageBitrate,
        });
        const capacity = session.transferStats.wasmCapacityBytes;
        for (let i = 0; i < track.packetCount; i++) {
          expect(await normalizedPacket(session, await session.packetAsync(i))).toEqual(packets[i]);
        }
        for (const seek of seeks) {
          const index = await session.findVerifiedKey(seek.seconds);
          expect(
            index === null
              ? null
              : await normalizedPacket(session, await session.packetAsync(index))
          ).toEqual(seek.packet);
        }
        expect(session.transferStats.wasmCapacityBytes).toBe(capacity);
        const snapshot = await session.exportIndex();
        expect(snapshot).not.toBeNull();
        const reused = new OwnedDemuxSession(new Blob([bytes]), module);
        try {
          const importedTrack = await reused.importIndex(snapshot!);
          expect(normalizedConfig(reused)).toEqual(fixture.config);
          expect(Number(importedTrack.durationTicks) / importedTrack.timescale).toBe(
            clock.duration(fixture.duration)
          );
          expect(importedTrack.packetCount).toBe(track.packetCount);
          expect(reused.seekWorkspaceBytes).toBe(seekBytes);
          expect(reused.transferStats.rangeReads).toBe(0);
          const importedCapacity = reused.transferStats.wasmCapacityBytes;
          for (let index = 0; index < importedTrack.packetCount; index++) {
            expect(await normalizedPacket(reused, await reused.packetAsync(index))).toEqual(
              packets[index]
            );
          }
          for (const seek of seeks) {
            const index = await reused.findVerifiedKey(seek.seconds);
            expect(
              index === null
                ? null
                : await normalizedPacket(reused, await reused.packetAsync(index))
            ).toEqual(seek.packet);
          }
          expect(reused.transferStats.wasmCapacityBytes).toBe(importedCapacity);
        } finally {
          reused.release();
        }
      } finally {
        session.release();
      }
    });
  }
  it('classifies actual ABI resource and unsupported records without allocating the declared metadata body', async () => {
    const source = new Blob([new Uint8Array(8)]);
    Object.defineProperty(source, 'size', { value: 64 * 1024 * 1024 });
    vi.spyOn(source, 'slice').mockImplementation((start = 0, end = source.size) => {
      const bytes = new Uint8Array(end - start);
      if (start === 0) {
        new DataView(bytes.buffer).setUint32(0, 32 * 1024 * 1024 + 9);
        bytes.set([109, 111, 111, 118], 4);
      }
      return new Blob([bytes]);
    });
    const oversized = new OwnedDemuxSession(source, module);
    try {
      await oversized.analyze();
      throw new Error('Oversized metadata unexpectedly admitted');
    } catch (error) {
      expect(String(error)).toMatch(/parser error 3/);
      expect(classifyOwnedDemuxError(error)).toBeInstanceOf(OwnedDemuxResourceError);
      expect(oversized.transferStats.wasmCapacityBytes).toBeLessThan(4 * 1024 * 1024);
    } finally {
      oversized.release();
    }
    const unknown = new OwnedDemuxSession(new Blob([new Uint8Array(8)]), module);
    try {
      await unknown.analyze();
      throw new Error('Unknown container unexpectedly admitted');
    } catch (error) {
      expect(String(error)).toMatch(/parser error 4/);
      expect(classifyOwnedDemuxError(error)).toBeInstanceOf(OwnedDemuxParseError);
    } finally {
      unknown.release();
    }
  });
  it('preserves the actual pinned epsilon/truncation boundary across signed timebases', () => {
    for (const scale of [3, 60, 120, 1000, 12288, 90000, 1_000_000_000]) {
      for (const ticks of [-1025, -123, -1, 0, 1, 3, 123, 999, 1025, 65535]) {
        const packet = new EncodedPacket(new Uint8Array([0]), 'key', ticks / scale, 0);
        expect(ownedTimestampUs(BigInt(ticks), scale)).toBe(packet.microsecondTimestamp);
      }
    }
    expect(ownedTimestampUs(123n, 120)).toBe(1_025_000);
  });
  it('rejects unsafe timebase conversion before Number precision loss', () => {
    expect(() => ownedTimestampUs(2n ** 63n, 1)).toThrow(/safe/);
    expect(() => ownedTimestampUs(1n, 0)).toThrow(/timebase/);
    expect(ownedTimestampUs(-1n, 3)).toBe(-333333);
  });
});
