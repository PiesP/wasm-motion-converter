// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it, vi } from 'vitest';
import type { ConversionRequest, VideoMetadata } from '@t/conversion-types';

const mocks = vi.hoisted(() => {
  const keyPacket = {
    duration: 1,
    timestamp: 4,
    toEncodedVideoChunk: () => ({ byteLength: 4, duration: 1_000_000, timestamp: 4_000_000 }),
  };
  const packets = [
    keyPacket,
    {
      duration: 1,
      timestamp: 5,
      toEncodedVideoChunk: () => ({ byteLength: 4, duration: 1_000_000, timestamp: 5_000_000 }),
    },
  ];
  return {
    getKeyPacket: vi.fn().mockResolvedValue(keyPacket),
    getFirstPacket: vi.fn().mockResolvedValue(keyPacket),
    getPacket: vi.fn().mockResolvedValue(keyPacket),
    getNextKeyPacket: vi.fn().mockResolvedValue({
      duration: 1,
      timestamp: 8,
      toEncodedVideoChunk: () => ({ byteLength: 4, duration: 1_000_000, timestamp: 8_000_000 }),
    }),
    packets,
    dispose: vi.fn(),
    startPacket: undefined as unknown,
  };
});

vi.mock('@utils/mediabunny-utils', () => ({
  createMediaBunnyInput: () => ({
    dispose: mocks.dispose,
    getVideoTracks: vi.fn().mockResolvedValue([{}]),
  }),
}));

vi.mock('mediabunny', () => ({
  EncodedPacketSink: class {
    getKeyPacket = mocks.getKeyPacket;
    getFirstPacket = mocks.getFirstPacket;
    getPacket = mocks.getPacket;
    getNextKeyPacket = mocks.getNextKeyPacket;

    async *packets(startPacket: unknown) {
      mocks.startPacket = startPacket;
      yield* mocks.packets;
    }
  },
}));

import { demuxVideo } from '@services/demuxer-service';

describe('demuxVideo trim start', () => {
  it('enforces the request memory budget while retaining encoded packets', async () => {
    const request: ConversionRequest = {
      inputBuffer: new ArrayBuffer(8),
      fileName: 'packet-bomb.mp4',
      format: 'gif',
      quality: 'medium',
      scale: 1,
      trimStart: 0,
      trimEnd: 0,
      maxMemoryMB: 0,
    };
    const metadata = {
      config: { codec: 'avc1.640028', codedWidth: 16, codedHeight: 16 },
      duration: 10,
      framerate: 30,
    } as VideoMetadata;

    await expect(demuxVideo(request, metadata)).rejects.toThrow('Demux memory limit exceeded');
    expect(mocks.dispose).toHaveBeenCalled();
  });

  it('starts decoding at the key packet at or before trimStart', async () => {
    const request: ConversionRequest = {
      inputBuffer: new ArrayBuffer(8),
      fileName: 'long-gop.mp4',
      format: 'gif',
      quality: 'medium',
      scale: 1,
      trimStart: 5,
      trimEnd: 0,
      maxMemoryMB: 512,
    };
    const metadata = {
      config: { codec: 'avc1.640028', codedWidth: 16, codedHeight: 16 },
      duration: 10,
      framerate: 30,
    } as VideoMetadata;

    const result = await demuxVideo(request, metadata);

    expect(mocks.getKeyPacket).toHaveBeenCalledWith(5, { verifyKeyPackets: true });
    expect(mocks.getNextKeyPacket).not.toHaveBeenCalled();
    expect(mocks.startPacket).toEqual(expect.objectContaining({ timestamp: 4 }));
    expect(result).toEqual(expect.objectContaining({ trimStartUs: 5_000_000 }));
  });
});
