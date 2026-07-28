// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it, vi } from 'vitest';
import type { ConversionRequest, VideoMetadata } from '@t/conversion-types';

const mocks = vi.hoisted(() => {
  const keyPacket = {
    duration: 1,
    timestamp: 4,
    toEncodedVideoChunk: () => ({ duration: 1_000_000, timestamp: 4_000_000 }),
  };
  const packets = [
    keyPacket,
    {
      duration: 1,
      timestamp: 5,
      toEncodedVideoChunk: () => ({ duration: 1_000_000, timestamp: 5_000_000 }),
    },
  ];
  return {
    getKeyPacket: vi.fn().mockResolvedValue(keyPacket),
    getPacket: vi.fn().mockResolvedValue(keyPacket),
    getNextKeyPacket: vi.fn().mockResolvedValue({
      duration: 1,
      timestamp: 8,
      toEncodedVideoChunk: () => ({ duration: 1_000_000, timestamp: 8_000_000 }),
    }),
    packets,
    startPacket: undefined as unknown,
  };
});

vi.mock('@utils/mediabunny-utils', () => ({
  createMediaBunnyInput: () => ({
    dispose: vi.fn(),
    getVideoTracks: vi.fn().mockResolvedValue([{}]),
  }),
}));

vi.mock('mediabunny', () => ({
  EncodedPacketSink: class {
    getKeyPacket = mocks.getKeyPacket;
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
