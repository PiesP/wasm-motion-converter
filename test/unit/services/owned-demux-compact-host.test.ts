// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { OwnedDemuxSession } from '@services/owned-demux-session';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const PACKET_COUNT = 700_000;

function fakeCompactWasm(
  options: {
    mode?: number;
    count?: number;
    maxPacketBytes?: number;
    liveIndexBytes?: number;
    seekWorkspaceBytes?: number;
    flags?: number;
    onWork?: () => void;
    onQueryWork?: () => void;
    queryWorkSteps?: number;
    packet?: (index: number) => { offset: number; key: boolean; pts: bigint };
  } = {}
): {
  module: WebAssembly.Module;
  calls: { packet: number; seekEnd: number; steps: number; queryEnd: number; querySteps: number };
} {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1024 });
  const view = new DataView(memory.buffer);
  const calls = { packet: 0, seekEnd: 0, steps: 0, queryEnd: 0, querySteps: 0 };
  let queriedIndex: number | null = null;
  let cachedIndex: number | null = null;
  const event = (pointer: number, tag: number): number => {
    view.setUint32(pointer, tag, true);
    return pointer;
  };
  const writePacket = (index: number): number => {
    const packet = options.packet?.(index);
    event(256, 5);
    view.setBigUint64(264, BigInt(packet?.offset ?? (index === PACKET_COUNT - 1 ? 0 : 5)), true);
    view.setUint32(272, 5, true);
    view.setUint32(276, Number(packet?.key ?? true), true);
    view.setBigInt64(280, BigInt(index === PACKET_COUNT - 1 ? 9 : 8), true);
    view.setBigInt64(288, packet?.pts ?? BigInt(index === PACKET_COUNT - 1 ? 9 : 8), true);
    view.setBigUint64(296, 1n, true);
    view.setBigUint64(304, 0n, true);
    return 256;
  };
  const exports = {
    memory,
    demux_abi_version: () => 4,
    demux_init: () => event(64, 0),
    demux_input_ptr: () => 512,
    demux_step: () => event(64, 3),
    demux_feed: () => 1,
    demux_track: () => {
      event(128, 6);
      new Uint8Array(memory.buffer, 136, 4).set([97, 118, 99, 49]);
      view.setUint32(140, 16, true);
      view.setUint32(144, 16, true);
      view.setUint32(148, 1, true);
      view.setBigUint64(152, 10n, true);
      view.setUint32(168, 16, true);
      view.setUint32(172, 16, true);
      view.setInt8(182, -1);
      return 128;
    },
    demux_description_ptr: () => 512,
    demux_codec_ptr: () => 512,
    demux_packet_count: () => options.count ?? PACKET_COUNT,
    demux_index_info: () => {
      event(192, 9);
      view.setUint32(196, options.mode ?? 1, true);
      view.setUint32(200, options.count ?? PACKET_COUNT, true);
      view.setUint32(204, options.maxPacketBytes ?? 5, true);
      view.setUint32(208, options.liveIndexBytes ?? 1024, true);
      view.setUint32(212, options.seekWorkspaceBytes ?? 0, true);
      view.setUint32(216, options.flags ?? 0, true);
      return 192;
    },
    demux_packet: (index: number) => {
      calls.packet++;
      return (options.flags ?? 0) & 2 && cachedIndex !== index ? 0 : writePacket(index);
    },
    demux_query_packet_begin: (index: number) => {
      if (queriedIndex !== null) return 0;
      queriedIndex = index;
      calls.querySteps = 0;
      return 1;
    },
    demux_query_packet_step: () => {
      if (queriedIndex === null) return 0;
      calls.querySteps++;
      if (calls.querySteps <= (options.queryWorkSteps ?? 1)) {
        event(384, 11);
        view.setUint32(388, 1, true);
        options.onQueryWork?.();
        return 384;
      }
      cachedIndex = queriedIndex;
      return writePacket(queriedIndex);
    },
    demux_query_packet_end: () => {
      calls.queryEnd++;
      queriedIndex = null;
      return 1;
    },
    demux_seek_begin: () => {
      calls.steps = 0;
      return 1;
    },
    demux_seek_step: () => {
      event(320, 10);
      calls.steps++;
      const state = calls.steps === 1 ? 1 : calls.steps <= 3 ? 2 : 3;
      view.setUint32(324, state, true);
      view.setUint32(328, calls.steps === 3 ? PACKET_COUNT - 2 : PACKET_COUNT - 1, true);
      if (state === 1) options.onWork?.();
      return 320;
    },
    demux_seek_end: () => {
      calls.seekEnd++;
      return 1;
    },
    demux_packet_begin: () => 1,
    demux_prepare_packets: () => 1,
    demux_probe_vp9: () => 1,
    demux_packet_feed: () => 1,
    demux_packet_finish: () => 512,
    demux_snapshot_begin: () => 0,
    demux_snapshot_next: () => 0,
    demux_snapshot_import_begin: () => 0,
    demux_snapshot_import_feed: () => 0,
    demux_snapshot_import_step: () => 0,
    demux_release: () => undefined,
  };
  vi.spyOn(WebAssembly, 'Instance').mockImplementation(function () {
    return { exports } as WebAssembly.Instance;
  });
  return { module: {} as WebAssembly.Module, calls };
}

const source = Uint8Array.of(0, 0, 0, 1, 0x41, 0, 0, 0, 1, 0x65);
const invalidIndexInfo: Array<[Parameters<typeof fakeCompactWasm>[0], string]> = [
  [{ mode: 2 }, 'mode'],
  [{ count: 100_000_001 }, 'count'],
  [{ maxPacketBytes: 16 * 1024 * 1024 }, 'packet size'],
  [{ liveIndexBytes: 32 * 1024 * 1024 + 1 }, 'live index'],
  [{ flags: 4 }, 'unknown flags'],
  [{ mode: 0, flags: 2 }, 'expanded asynchronous query'],
  [{ flags: 1 }, 'compact reconstruction'],
];

afterEach(() => vi.restoreAllMocks());

describe('ABI4 compact demux host', () => {
  it('retains descriptor validation and the JavaScript seek reserve for expanded indexes', async () => {
    const { module, calls } = fakeCompactWasm({ mode: 0, count: 2 });
    const session = new OwnedDemuxSession(source.buffer, module);
    try {
      await session.analyze();
      expect(calls.packet).toBe(2);
      expect(session.seekWorkspaceBytes).toBe(24);
    } finally {
      session.release();
    }
  });

  it('verifies expanded key hints in signed presentation order and breaks ties by packet index', async () => {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    const pts = [-max, max - 1n, max - 1n, max, 0n];
    const { module } = fakeCompactWasm({
      mode: 0,
      count: pts.length,
      packet: (index) => ({
        offset: index === 3 ? 0 : 5,
        key: index !== 4,
        pts: pts[index]!,
      }),
    });
    const session = new OwnedDemuxSession(source.buffer, module);
    try {
      await session.analyze();
      expect(session.seekWorkspaceBytes).toBe(4 * 12);
      await expect(session.findVerifiedKey(Number(max))).resolves.toBe(2);
      await expect(session.findVerifiedKey(0)).resolves.toBe(0);
      pts[4] = max + 1n;
      await expect(session.findVerifiedKey(0)).rejects.toThrow('timestamp out of range');
    } finally {
      session.release();
    }
  });

  it('rejects additional seek candidates beyond the validated workspace', async () => {
    let key = false;
    const { module } = fakeCompactWasm({
      mode: 0,
      count: 2,
      packet: () => ({ offset: 5, key, pts: 0n }),
    });
    const session = new OwnedDemuxSession(source.buffer, module);
    try {
      await session.analyze();
      expect(session.seekWorkspaceBytes).toBe(0);
      await expect(session.findVerifiedKey(0)).resolves.toBeNull();
      key = true;
      await expect(session.findVerifiedKey(0)).rejects.toThrow('seek key count exceeded');
    } finally {
      session.release();
    }
  });

  it('admits a 700k logical index without scanning descriptors and verifies false key hints', async () => {
    const { module, calls } = fakeCompactWasm();
    const session = new OwnedDemuxSession(source.buffer, module);
    try {
      const track = await session.analyze();
      expect(track.packetCount).toBe(PACKET_COUNT);
      expect(track.maxPacketBytes).toBe(5);
      expect(session.seekWorkspaceBytes).toBe(0);
      expect(calls.packet).toBe(0);
      await expect(session.exportIndex()).resolves.toBeNull();
      await expect(session.findVerifiedKey(9)).resolves.toBe(PACKET_COUNT - 2);
      expect(calls.packet).toBe(4);
      expect(calls.seekEnd).toBe(1);
      expect(calls.steps).toBe(3);
    } finally {
      session.release();
    }
  });

  it.each(invalidIndexInfo)(
    'rejects malformed compact index information: %s (%s)',
    async (options) => {
      const { module } = fakeCompactWasm(options);
      const session = new OwnedDemuxSession(source.buffer, module);
      await expect(session.analyze()).rejects.toThrow();
      expect(() => session.track()).toThrow('unavailable');
    }
  );

  it('clears the seek lease after active cancellation and permits a later seek', async () => {
    const controller = new AbortController();
    const { module, calls } = fakeCompactWasm({ onWork: () => controller.abort() });
    const session = new OwnedDemuxSession(source.buffer, module);
    try {
      await session.analyze();
      await expect(session.findVerifiedKey(9, controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(calls.seekEnd).toBe(1);
      await expect(session.findVerifiedKey(9)).resolves.toBe(PACKET_COUNT - 2);
      expect(calls.seekEnd).toBe(2);
    } finally {
      session.release();
    }
  });

  it('rejects a late compact candidate read without publishing a stale key', async () => {
    const { module, calls } = fakeCompactWasm();
    const blob = new Blob([source]);
    const pending = Promise.withResolvers<ArrayBuffer>();
    const pendingRange = new Blob();
    vi.spyOn(pendingRange, 'arrayBuffer').mockReturnValue(pending.promise);
    const originalSlice = blob.slice.bind(blob);
    let reads = 0;
    vi.spyOn(blob, 'slice').mockImplementation((start, end) => {
      if (++reads === 1) return pendingRange;
      return originalSlice(start, end);
    });
    const session = new OwnedDemuxSession(blob, module);
    const controller = new AbortController();
    try {
      await session.analyze();
      const seek = session.findVerifiedKey(9, controller.signal);
      await vi.waitFor(() => expect(reads).toBe(1));
      controller.abort();
      await expect(seek).rejects.toMatchObject({ name: 'AbortError' });
      expect(calls.seekEnd).toBe(1);
      pending.resolve(source.slice(0, 5).buffer);
      await Promise.resolve();
      await expect(session.findVerifiedKey(9)).resolves.toBe(PACKET_COUNT - 2);
      expect(calls.seekEnd).toBe(2);
    } finally {
      session.release();
    }
  });

  it('queries compact CTTS in bounded steps and revalidates a native descriptor before a read', async () => {
    const { module, calls } = fakeCompactWasm({ flags: 2, queryWorkSteps: 3 });
    const session = new OwnedDemuxSession(source.buffer, module);
    try {
      await session.analyze();
      expect(() => session.packet(PACKET_COUNT - 1)).toThrow('asynchronous query');
      const packet = await session.packetAsync(PACKET_COUNT - 1);
      expect(calls.querySteps).toBe(4);
      expect(calls.queryEnd).toBe(1);
      expect(packet.ptsTicks).toBe(9n);
      expect(new Uint8Array(await session.readPacket(packet))).toEqual(source.slice(0, 5));
      expect(calls.querySteps).toBe(4);
      const forged = { ...packet, offset: 5n };
      await expect(session.readPacket(forged)).rejects.toThrow('descriptor invalid');
      expect(new Uint8Array(await session.readPacket(packet))).toEqual(source.slice(0, 5));
    } finally {
      session.release();
    }
  });

  it('ends an aborted compact CTTS query and allows a later packet and seek', async () => {
    const controller = new AbortController();
    const { module, calls } = fakeCompactWasm({
      flags: 2,
      onQueryWork: () => controller.abort(),
    });
    const session = new OwnedDemuxSession(source.buffer, module);
    try {
      await session.analyze();
      await expect(session.packetAsync(PACKET_COUNT - 1, controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(calls.queryEnd).toBe(1);
      const packet = await session.packetAsync(PACKET_COUNT - 1);
      expect(packet.key).toBe(true);
      await expect(session.findVerifiedKey(9)).resolves.toBe(PACKET_COUNT - 2);
      expect(calls.queryEnd).toBeGreaterThan(2);
      expect(calls.seekEnd).toBe(1);
    } finally {
      session.release();
    }
  });

  it('reserves the read lease before an asynchronous source read and rejects concurrent lookup', async () => {
    const { module } = fakeCompactWasm({ flags: 2, queryWorkSteps: 0 });
    const blob = new Blob([source]);
    const pending = Promise.withResolvers<ArrayBuffer>();
    const pendingRange = new Blob();
    vi.spyOn(pendingRange, 'arrayBuffer').mockReturnValue(pending.promise);
    const originalSlice = blob.slice.bind(blob);
    vi.spyOn(blob, 'slice').mockImplementation((start, end) =>
      start === 0 && end === 5 ? pendingRange : originalSlice(start, end)
    );
    const session = new OwnedDemuxSession(blob, module);
    try {
      await session.analyze();
      const packet = await session.packetAsync(PACKET_COUNT - 1);
      const read = session.readPacket(packet);
      await expect(session.packetAsync(PACKET_COUNT - 2)).rejects.toThrow('lease invalid');
      await expect(session.exportIndex()).rejects.toThrow('lease invalid');
      pending.resolve(source.slice(0, 5).buffer);
      expect(new Uint8Array(await read)).toEqual(source.slice(0, 5));
      expect((await session.packetAsync(PACKET_COUNT - 2)).index).toBe(PACKET_COUNT - 2);
    } finally {
      session.release();
    }
  });
});
