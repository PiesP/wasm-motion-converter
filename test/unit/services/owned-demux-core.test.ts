// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { readFileSync } from 'node:fs';

import {
  classifyOwnedDemuxError,
  computeOwnedPacketStats,
  OwnedDemuxAbiError,
  OwnedDemuxLoadError,
  OwnedDemuxParseError,
  OwnedDemuxResourceError,
  loadOwnedDemuxModule,
} from '@services/owned-demux-core';
import type { OwnedDemuxSession, OwnedDemuxTrack } from '@services/owned-demux-session';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('owned demux packet statistics and terminal errors', () => {
  it('keeps decode-order B-frame lookahead after the first 50 packets', async () => {
    const timestamps = Array.from({ length: 50 }, (_, index) => index);
    timestamps.push(48, 50);
    const packet = vi.fn((index: number) => ({
      ptsTicks: BigInt(timestamps[index]!),
      durationTicks: 1n,
      byteLength: 10,
    }));
    const session = { packetAsync: packet } as unknown as OwnedDemuxSession;
    const track = { packetCount: timestamps.length, timescale: 1 } as OwnedDemuxTrack;
    await expect(computeOwnedPacketStats(session, track)).resolves.toEqual({
      averagePacketRate: 1.02,
      averageBitrate: 81.6,
    });
    expect(packet).toHaveBeenCalledTimes(52);
  });

  it('uses the two-second statistics fallback without scanning the index', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(2_001);
    const packet = vi.fn();
    const session = { packetAsync: packet } as unknown as OwnedDemuxSession;
    const track = { packetCount: 1000, timescale: 1 } as OwnedDemuxTrack;
    await expect(computeOwnedPacketStats(session, track)).resolves.toBeNull();
    expect(packet).not.toHaveBeenCalled();
  });

  it('keeps ABI, bounded-resource, and malformed-input outcomes distinct', () => {
    expect(classifyOwnedDemuxError(new Error('Owned demux ABI version mismatch'))).toBeInstanceOf(
      OwnedDemuxAbiError
    );
    expect(classifyOwnedDemuxError(new Error('Owned demux parser error 3'))).toBeInstanceOf(
      OwnedDemuxResourceError
    );
    expect(classifyOwnedDemuxError(new Error('Owned demux parser error 2'))).toBeInstanceOf(
      OwnedDemuxParseError
    );
    const cancelled = new DOMException('Cancelled', 'AbortError');
    expect(classifyOwnedDemuxError(cancelled)).toBe(cancelled);
    const controller = new AbortController();
    controller.abort('stop');
    expect(classifyOwnedDemuxError('stop', controller.signal)).toMatchObject({
      name: 'AbortError',
    });
  });

  it('does not cache a failed load and reuses only a successfully compiled module', async () => {
    const bytes = Uint8Array.from(
      readFileSync(new URL('../../../src/services/owned-demux.wasm', import.meta.url))
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValue(new Response(bytes, { headers: { 'content-type': 'application/wasm' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadOwnedDemuxModule()).rejects.toBeInstanceOf(OwnedDemuxLoadError);
    const first = await loadOwnedDemuxModule();
    const second = await loadOwnedDemuxModule();
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
