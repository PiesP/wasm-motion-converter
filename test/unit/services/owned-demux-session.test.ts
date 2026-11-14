// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it } from 'vite-plus/test';

import { verifyOwnedVideoKey } from '@services/owned-demux-session';

describe('owned demux bitstream key verification', () => {
  it('accepts MP4 and Matroska FourCC spelling for VP9 and AV1', async () => {
    const vp9 = new Uint8Array([0x82, 0x49]);
    const av1 = new Uint8Array([0x0a, 0x01, 0x08, 0x32, 0x01, 0x00]);
    await expect(verifyOwnedVideoKey('vp09', new Uint8Array(), vp9)).resolves.toBe(true);
    await expect(verifyOwnedVideoKey('VP90', new Uint8Array(), vp9)).resolves.toBe(true);
    await expect(verifyOwnedVideoKey('av01', new Uint8Array(), av1)).resolves.toBe(true);
    await expect(verifyOwnedVideoKey('AV01', new Uint8Array(), av1)).resolves.toBe(true);
    await expect(verifyOwnedVideoKey('av01',
      new Uint8Array([0x81, 0, 0, 0, 0x0a, 1, 0x08]),
      new Uint8Array([0x32, 1, 0xe0]))).resolves.toBe(true);
  });

  it('classifies length-prefixed and Annex-B AVC/HEVC pictures', async () => {
    const avcc = new Uint8Array([1, 66, 0, 10, 0xff]);
    const hvcc = new Uint8Array(22);
    hvcc[21] = 3;
    await expect(verifyOwnedVideoKey('avc1', avcc,
      new Uint8Array([0, 0, 0, 1, 0x65]))).resolves.toBe(true);
    await expect(verifyOwnedVideoKey('avc1', avcc,
      new Uint8Array([0, 0, 0, 1, 0x41]))).resolves.toBe(false);
    await expect(verifyOwnedVideoKey('hev1', hvcc,
      new Uint8Array([0, 0, 0, 1, 0x26]))).resolves.toBe(true);
    await expect(verifyOwnedVideoKey('avc1', new Uint8Array(),
      new Uint8Array([0, 0, 1, 0x67, 0, 0, 1, 0x65]))).resolves.toBe(true);
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
