// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { readFileSync } from 'node:fs';

import { OwnedDemuxSession } from '@services/owned-demux-session';
import { verifyOwnedVideoKey } from '@services/owned-demux-session';
import { ownedReadCreditStats, readOwnedRange } from '@services/owned-demux-source-reads';
import { describe, expect, it, vi } from 'vite-plus/test';

async function fixtureSession(
  id = 'avc-baseline.mp4',
  appendFree = false
): Promise<{
  session: OwnedDemuxSession;
  source: Blob;
  bytes: Uint8Array;
}> {
  const module = await WebAssembly.compile(
    Uint8Array.from(
      readFileSync(new URL('../../../src/services/owned-demux.wasm', import.meta.url))
    )
  );
  const base64 = readFileSync(
    new URL(`../../fixtures/owned-demux/${id}.base64`, import.meta.url),
    'utf8'
  );
  let bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
  if (appendFree) {
    const free = new Uint8Array(100_000);
    new DataView(free.buffer).setUint32(0, free.length);
    free.set([0x66, 0x72, 0x65, 0x65], 4);
    const extended = new Uint8Array(bytes.length + free.length);
    extended.set(bytes);
    extended.set(free, bytes.length);
    bytes = extended;
  }
  const source = new Blob([bytes]);
  return { session: new OwnedDemuxSession(source, module), source, bytes };
}

describe('conversion owned packet source window', () => {
  it('uses one clipped Blob read for adjacent packets and returns independent exact bytes', async () => {
    const { session, source, bytes } = await fixtureSession();
    try {
      await session.analyze();
      const first = session.packet(0);
      const second = session.packet(1);
      expect(second.offset).toBe(first.offset + BigInt(first.byteLength));
      const slice = vi.spyOn(source, 'slice');
      const arrayBuffer = vi.spyOn(Blob.prototype, 'arrayBuffer');
      session.enablePacketReadWindow();
      const firstData = await session.readPacket(first);
      const secondData = await session.readPacket(second);
      expect(slice).toHaveBeenCalledOnce();
      expect(arrayBuffer).toHaveBeenCalledOnce();
      expect(slice).toHaveBeenCalledWith(Number(first.offset), source.size);
      expect(new Uint8Array(firstData)).toEqual(
        bytes.slice(Number(first.offset), Number(first.offset) + first.byteLength)
      );
      expect(new Uint8Array(secondData)).toEqual(
        bytes.slice(Number(second.offset), Number(second.offset) + second.byteLength)
      );
      expect(session.transferStats.packetReadBytes).toBe(first.byteLength + second.byteLength);
      expect(ownedReadCreditStats().liveBytes).toBe(source.size - Number(first.offset));
      session.release();
      expect(ownedReadCreditStats().liveBytes).toBe(0);
      expect(new Uint8Array(firstData)).toEqual(
        bytes.slice(Number(first.offset), Number(first.offset) + first.byteLength)
      );
    } finally {
      session.release();
      vi.restoreAllMocks();
    }
  });

  it('validates a VP9 key from a four-byte credit-owned read of its indexed extent', async () => {
    const { session, source } = await fixtureSession('vp9.webm');
    try {
      await session.analyze();
      session.enablePacketReadWindow();
      const packet = await session.packetAsync(0);
      const expectedStart = Number(packet.offset);
      const slice = source.slice.bind(source);
      const creditAtSlice: number[] = [];
      const readRange = vi.spyOn(source, 'slice').mockImplementation((start, end) => {
        creditAtSlice.push(ownedReadCreditStats().liveBytes);
        return slice(start, end);
      });
      const before = session.transferStats;
      await expect(session.verifyVisibleVp9Key(packet)).resolves.toBe(true);
      expect(readRange).toHaveBeenCalledExactlyOnceWith(expectedStart, expectedStart + 4);
      expect(creditAtSlice).toEqual([4]);
      expect(session.transferStats.sourceReadBytes - before.sourceReadBytes).toBe(4);
      expect(session.transferStats.packetReadBytes).toBe(before.packetReadBytes);
      expect(ownedReadCreditStats().liveBytes).toBe(0);

      await expect(
        session.verifyVisibleVp9Key({ ...packet, offset: packet.offset + 1n })
      ).rejects.toThrow('packet descriptor invalid');
      expect(readRange).toHaveBeenCalledOnce();
    } finally {
      session.release();
      vi.restoreAllMocks();
    }
  });

  it.each([
    [0x80, 0x49, 0x83, 0x42], // hidden key
    [0x86, 0x49, 0x83, 0x42], // visible delta
    [0x88, 0x49, 0x83, 0x42], // show existing
    [0x92, 0x49, 0x83, 0x42], // profile 2
    [0x82, 0x49, 0x83, 0x41], // wrong sync code
  ])('refuses an unsafe VP9 key prefix (%i, %i, %i, %i)', async (...prefix) => {
    const { session, source } = await fixtureSession('vp9.webm');
    try {
      await session.analyze();
      const packet = await session.packetAsync(0);
      vi.spyOn(source, 'slice').mockReturnValue(new Blob([new Uint8Array(prefix)]));
      await expect(session.verifyVisibleVp9Key(packet)).resolves.toBe(false);
    } finally {
      session.release();
      vi.restoreAllMocks();
    }
  });

  it('keeps metadata-style sessions on exact reads until conversion admission', async () => {
    const { session, source } = await fixtureSession();
    try {
      await session.analyze();
      const packet = session.packet(0);
      const slice = vi.spyOn(source, 'slice');
      await session.readPacket(packet);
      await session.readPacket(packet);
      expect(slice).toHaveBeenCalledTimes(2);
      expect(slice).toHaveBeenCalledWith(
        Number(packet.offset),
        Number(packet.offset) + packet.byteLength
      );
    } finally {
      session.release();
      vi.restoreAllMocks();
    }
  });

  it('evicts before a distant miss and large exact read, preserving prior packet bytes', async () => {
    const { session, source, bytes } = await fixtureSession('avc-baseline.mp4', true);
    try {
      await session.analyze();
      session.enablePacketReadWindow();
      const packet = session.packet(0);
      const original = await session.readPacket(packet);
      const internal = session as unknown as {
        readOrdinaryPacket(start: number, length: number): Promise<ArrayBuffer>;
      };
      const originalSlice = source.slice.bind(source);
      const creditAtSlice: number[] = [];
      const slice = vi.spyOn(source, 'slice').mockImplementation((start, end, contentType) => {
        creditAtSlice.push(ownedReadCreditStats().liveBytes);
        return originalSlice(start, end, contentType);
      });
      const far = await internal.readOrdinaryPacket(0, 16);
      expect(new Uint8Array(far)).toEqual(bytes.slice(0, 16));
      expect(slice).toHaveBeenCalledWith(0, 64 * 1024);
      expect(creditAtSlice[0]).toBe(64 * 1024);
      expect(ownedReadCreditStats().liveBytes).toBe(64 * 1024);
      const large = await internal.readOrdinaryPacket(0, 64 * 1024 + 1);
      expect(new Uint8Array(large)).toEqual(bytes.slice(0, 64 * 1024 + 1));
      expect(slice).toHaveBeenCalledWith(0, 64 * 1024 + 1);
      expect(creditAtSlice[1]).toBe(64 * 1024 + 1);
      expect(ownedReadCreditStats().liveBytes).toBe(0);
      expect(new Uint8Array(original)).toEqual(
        bytes.slice(Number(packet.offset), Number(packet.offset) + packet.byteLength)
      );
    } finally {
      session.release();
      vi.restoreAllMocks();
    }
  });

  it('chooses the exact read before I/O when window credit is unavailable', async () => {
    const { session, source } = await fixtureSession();
    const delayed = Promise.withResolvers<ArrayBuffer>();
    const heldSource = { slice: vi.fn(() => ({ arrayBuffer: () => delayed.promise })) };
    try {
      await session.analyze();
      session.enablePacketReadWindow();
      const packet = session.packet(0);
      const held = readOwnedRange(heldSource, 0, 16 * 1024 * 1024);
      await vi.waitFor(() => expect(heldSource.slice).toHaveBeenCalledOnce());
      const slice = vi.spyOn(source, 'slice');
      const read = session.readPacket(packet);
      await vi.waitFor(() => expect(ownedReadCreditStats().waiters).toBe(1));
      expect(slice).not.toHaveBeenCalled();
      delayed.resolve(new ArrayBuffer(0));
      await held;
      await expect(read).resolves.toHaveProperty('byteLength', packet.byteLength);
      expect(slice).toHaveBeenCalledOnce();
      expect(slice).toHaveBeenCalledWith(
        Number(packet.offset),
        Number(packet.offset) + packet.byteLength
      );
      expect(ownedReadCreditStats().liveBytes).toBe(0);
    } finally {
      session.release();
      vi.restoreAllMocks();
    }
  });

  it('treats a short started window read as terminal without an exact retry', async () => {
    const { session, source } = await fixtureSession();
    try {
      await session.analyze();
      session.enablePacketReadWindow();
      const slice = vi.spyOn(source, 'slice').mockReturnValue({
        arrayBuffer: async () => new ArrayBuffer(0),
      } as Blob);
      await expect(session.readPacket(session.packet(0))).rejects.toThrow('truncated read');
      expect(slice).toHaveBeenCalledOnce();
      expect(ownedReadCreditStats().liveBytes).toBe(0);
    } finally {
      session.release();
      vi.restoreAllMocks();
    }
  });

  it('does not retry a failed started window read', async () => {
    const { session, source } = await fixtureSession();
    try {
      await session.analyze();
      session.enablePacketReadWindow();
      const slice = vi.spyOn(source, 'slice').mockReturnValue({
        arrayBuffer: async () => Promise.reject(new Error('source failed')),
      } as Blob);
      await expect(session.readPacket(session.packet(0))).rejects.toThrow('source failed');
      expect(slice).toHaveBeenCalledOnce();
      expect(ownedReadCreditStats().liveBytes).toBe(0);
    } finally {
      session.release();
      vi.restoreAllMocks();
    }
  });

  it('rejects a late window read after release without publishing stale bytes', async () => {
    const { session, source } = await fixtureSession();
    const delayed = Promise.withResolvers<ArrayBuffer>();
    let read: Promise<ArrayBuffer> | undefined;
    try {
      await session.analyze();
      session.enablePacketReadWindow();
      const packet = session.packet(0);
      const range = new Blob();
      vi.spyOn(range, 'arrayBuffer').mockReturnValue(delayed.promise);
      const slice = vi.spyOn(source, 'slice').mockReturnValue(range);
      read = session.readPacket(packet);
      await vi.waitFor(() => expect(slice).toHaveBeenCalledOnce());
      session.release();
      expect(ownedReadCreditStats().liveBytes).toBe(source.size - Number(packet.offset));
      delayed.resolve(new ArrayBuffer(source.size - Number(packet.offset)));
      await expect(read).rejects.toThrow('read invalidated');
      expect(session.transferStats.packetReadBytes).toBe(0);
      expect(ownedReadCreditStats()).toEqual({ liveBytes: 0, retiredBytes: 0, waiters: 0 });
    } finally {
      session.release();
      // A failed assertion must not strand realm read credit for later tests.
      delayed.resolve(new ArrayBuffer(0));
      await read?.catch(() => undefined);
      vi.restoreAllMocks();
    }
  });

  it('keeps reconstructed TS packets on their existing exact range path', async () => {
    const { session, source } = await fixtureSession('avc.ts');
    try {
      const track = await session.analyze();
      session.enablePacketReadWindow();
      const packet = Array.from({ length: track.packetCount }, (_, index) =>
        session.packet(index)
      ).find((item) => item.sourceEnd !== null);
      expect(packet).toBeDefined();
      const slice = vi.spyOn(source, 'slice');
      await expect(session.readPacket(packet!)).resolves.toHaveProperty(
        'byteLength',
        packet!.byteLength
      );
      expect(slice).toHaveBeenCalled();
      expect(ownedReadCreditStats().liveBytes).toBe(0);
    } finally {
      session.release();
      vi.restoreAllMocks();
    }
  });
});

describe('owned demux bitstream key verification', () => {
  it('accepts MP4 and Matroska FourCC spelling for VP9 and AV1', async () => {
    const vp9 = new Uint8Array([0x82, 0x49]);
    const av1 = new Uint8Array([0x0a, 0x01, 0x08, 0x32, 0x01, 0x00]);
    await expect(verifyOwnedVideoKey('vp09', new Uint8Array(), vp9)).resolves.toBe(true);
    await expect(verifyOwnedVideoKey('VP90', new Uint8Array(), vp9)).resolves.toBe(true);
    await expect(verifyOwnedVideoKey('av01', new Uint8Array(), av1)).resolves.toBe(true);
    await expect(verifyOwnedVideoKey('AV01', new Uint8Array(), av1)).resolves.toBe(true);
    await expect(
      verifyOwnedVideoKey(
        'av01',
        new Uint8Array([0x81, 0, 0, 0, 0x0a, 1, 0x08]),
        new Uint8Array([0x32, 1, 0xe0])
      )
    ).resolves.toBe(true);
  });

  it('classifies length-prefixed and Annex-B AVC/HEVC pictures', async () => {
    const avcc = new Uint8Array([1, 66, 0, 10, 0xff]);
    const hvcc = new Uint8Array(22);
    hvcc[21] = 3;
    await expect(
      verifyOwnedVideoKey('avc1', avcc, new Uint8Array([0, 0, 0, 1, 0x65]))
    ).resolves.toBe(true);
    await expect(
      verifyOwnedVideoKey('avc1', avcc, new Uint8Array([0, 0, 0, 1, 0x41]))
    ).resolves.toBe(false);
    await expect(
      verifyOwnedVideoKey('hev1', hvcc, new Uint8Array([0, 0, 0, 1, 0x26]))
    ).resolves.toBe(true);
    await expect(
      verifyOwnedVideoKey('avc1', new Uint8Array(), new Uint8Array([0, 0, 1, 0x67, 0, 0, 1, 0x65]))
    ).resolves.toBe(true);
  });

  it('yields during long Annex-B scans so cancellation can preempt classification', async () => {
    const bytes = new Uint8Array(1024 * 1024);
    for (let at = 0; at < bytes.length; at += 4) bytes.set([0, 0, 1, 6], at);
    const controller = new AbortController();
    const pending = verifyOwnedVideoKey('avc1', new Uint8Array(), bytes, controller.signal);
    setTimeout(() => controller.abort(), 0);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('owned demux late range reads', () => {
  it('settles an aborted analysis before its Blob read resolves and recovers', async () => {
    const module = await WebAssembly.compile(
      Uint8Array.from(
        readFileSync(new URL('../../../src/services/owned-demux.wasm', import.meta.url))
      )
    );
    const source = new Blob([new Uint8Array(8)]);
    const pending = Promise.withResolvers<ArrayBuffer>();
    const range = new Blob();
    vi.spyOn(range, 'arrayBuffer').mockReturnValue(pending.promise);
    const slice = vi.spyOn(source, 'slice').mockReturnValue(range);
    const session = new OwnedDemuxSession(source, module);
    const controller = new AbortController();
    const analysis = session.analyze(controller.signal);
    await vi.waitFor(() => expect(slice).toHaveBeenCalledOnce());
    controller.abort();
    await expect(analysis).rejects.toMatchObject({ name: 'AbortError' });
    pending.resolve(new ArrayBuffer(8));
    await Promise.resolve();
    expect(session.transferStats.inputCopiedToWasmBytes).toBe(0);

    const base64 = readFileSync(
      new URL('../../fixtures/owned-demux/avc-baseline.mp4.base64', import.meta.url),
      'utf8'
    );
    const recovered = new OwnedDemuxSession(
      new Blob([Uint8Array.from(Buffer.from(base64, 'base64'))]),
      module
    );
    try {
      await expect(recovered.analyze()).resolves.toMatchObject({ codec: 'avc1', packetCount: 12 });
    } finally {
      recovered.release();
    }
  });

  it('rejects an aborted packet read before a delayed Blob completes', async () => {
    const module = await WebAssembly.compile(
      Uint8Array.from(
        readFileSync(new URL('../../../src/services/owned-demux.wasm', import.meta.url))
      )
    );
    const base64 = readFileSync(
      new URL('../../fixtures/owned-demux/avc-baseline.mp4.base64', import.meta.url),
      'utf8'
    );
    const source = new Blob([Uint8Array.from(Buffer.from(base64, 'base64'))]);
    const session = new OwnedDemuxSession(source, module);
    try {
      await session.analyze();
      const pending = Promise.withResolvers<ArrayBuffer>();
      const range = new Blob();
      vi.spyOn(range, 'arrayBuffer').mockReturnValue(pending.promise);
      const slice = vi.spyOn(source, 'slice').mockReturnValue(range);
      const controller = new AbortController();
      const packet = session.packet(0);
      session.enablePacketReadWindow();
      const read = session.readPacket(packet, controller.signal);
      await vi.waitFor(() => expect(slice).toHaveBeenCalledOnce());
      controller.abort();
      await expect(read).rejects.toMatchObject({ name: 'AbortError' });
      session.release();
      expect(ownedReadCreditStats().retiredBytes).toBe(source.size - Number(packet.offset));
      pending.resolve(new ArrayBuffer(packet.byteLength));
      await vi.waitFor(() => expect(ownedReadCreditStats().liveBytes).toBe(0));
      expect(session.transferStats.packetReadBytes).toBe(0);
    } finally {
      session.release();
    }
  });
});

describe('owned demux verified key boundaries', () => {
  it('does not choose a future key within a fractional source tick', async () => {
    const module = await WebAssembly.compile(
      Uint8Array.from(
        readFileSync(new URL('../../../src/services/owned-demux.wasm', import.meta.url))
      )
    );
    const base64 = readFileSync(
      new URL('../../fixtures/owned-demux/avc-bframes.mp4.base64', import.meta.url),
      'utf8'
    );
    const session = new OwnedDemuxSession(
      new Blob([Uint8Array.from(Buffer.from(base64, 'base64'))]),
      module
    );
    try {
      const track = await session.analyze();
      const before = 1 - 0.25 / track.timescale;
      const after = 1 + 0.25 / track.timescale;
      await expect(session.findVerifiedKey(before)).resolves.toBe(0);
      await expect(session.findVerifiedKey(1)).resolves.toBe(6);
      await expect(session.findVerifiedKey(after)).resolves.toBe(6);
    } finally {
      session.release();
    }
  });
});
