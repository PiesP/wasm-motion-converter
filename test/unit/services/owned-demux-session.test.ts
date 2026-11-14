// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { readFileSync } from 'node:fs';

import { OwnedDemuxSession } from '@services/owned-demux-session';
import { verifyOwnedVideoKey } from '@services/owned-demux-session';
import { describe, expect, it } from 'vite-plus/test';

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
      const read = session.readPacket(packet, controller.signal);
      await vi.waitFor(() => expect(slice).toHaveBeenCalledOnce());
      controller.abort();
      await expect(read).rejects.toMatchObject({ name: 'AbortError' });
      session.release();
      pending.resolve(new ArrayBuffer(packet.byteLength));
      await Promise.resolve();
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
