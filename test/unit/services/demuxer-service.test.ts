// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversionRequest, VideoMetadata } from '@t/conversion-types';
import { DEMUX_MEMORY_BUDGET_BYTES, ENCODED_CHUNK_BUDGET_BYTES } from '@utils/constants';

const mocks = vi.hoisted(() => {
  const keyPacket = {
    byteLength: 4,
    duration: 1,
    timestamp: 4,
    toEncodedVideoChunk: () => ({ byteLength: 4, duration: 1_000_000, timestamp: 4_000_000 }),
  };
  const packets = [
    keyPacket,
    {
      byteLength: 4,
      duration: 1,
      timestamp: 5,
      toEncodedVideoChunk: () => ({ byteLength: 4, duration: 1_000_000, timestamp: 5_000_000 }),
    },
  ];
  return {
    getKeyPacket: vi.fn().mockResolvedValue(keyPacket),
    getFirstPacket: vi.fn().mockResolvedValue(keyPacket),
    getNextPacket: vi.fn().mockImplementation(async (packet: unknown) =>
      packet === keyPacket ? packets[1] : null
    ),
    getPacket: vi.fn().mockResolvedValue(keyPacket),
    getNextKeyPacket: vi.fn().mockResolvedValue({
      duration: 1,
      timestamp: 8,
      toEncodedVideoChunk: () => ({ byteLength: 4, duration: 1_000_000, timestamp: 8_000_000 }),
    }),
    packets,
    dispose: vi.fn(),
  };
});

vi.mock('@utils/mediabunny-utils', () => ({
  createMediaBunnyInput: () => ({
    dispose: mocks.dispose,
    getVideoTracks: vi.fn().mockResolvedValue([{ getRotation: vi.fn().mockResolvedValue(0) }]),
  }),
}));

vi.mock('mediabunny', () => ({
  EncodedPacketSink: class {
    getKeyPacket = mocks.getKeyPacket;
    getFirstPacket = mocks.getFirstPacket;
    getNextPacket = mocks.getNextPacket;
    getPacket = mocks.getPacket;
    getNextKeyPacket = mocks.getNextKeyPacket;

  },
}));

import { demuxVideo } from '@services/demuxer-service';

describe('demuxVideo trim start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const packet of mocks.packets) packet.byteLength = 4;
  });

  it('rejects an oversized packet before creating an EncodedVideoChunk', async () => {
    const packet = mocks.packets[0]!;
    packet.byteLength = DEMUX_MEMORY_BUDGET_BYTES;
    const packetSpy = vi.spyOn(packet, 'toEncodedVideoChunk');
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

    const result = await demuxVideo(request, metadata);
    const consume = async (): Promise<void> => {
      for await (const _chunk of result.chunks) {
        // Consume the lazy stream to trigger the per-packet budget check.
      }
    };

    try {
      await expect(consume()).rejects.toThrow('Demux memory limit exceeded');
      expect(packetSpy).not.toHaveBeenCalled();
      expect(mocks.dispose).toHaveBeenCalled();
    } finally {
      packetSpy.mockRestore();
    }
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
    const chunks: EncodedVideoChunk[] = [];
    for await (const chunk of result.chunks) chunks.push(chunk);

    expect(mocks.getKeyPacket).toHaveBeenCalledWith(5, { verifyKeyPackets: true });
    expect(mocks.getNextKeyPacket).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        encodedChunkBudgetBytes: ENCODED_CHUNK_BUDGET_BYTES,
        trimStartUs: 5_000_000,
        totalFrames: 2,
        sourceTotalMs: 2_000,
      })
    );
    expect(chunks).toHaveLength(2);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('estimates the selected trim range instead of the full source duration', async () => {
    const onPrepared = vi.fn();
    const request: ConversionRequest = {
      inputBuffer: new ArrayBuffer(8),
      fileName: 'short-trim.mp4',
      format: 'gif',
      quality: 'high',
      scale: 1,
      trimStart: 10,
      trimEnd: 11,
      maxMemoryMB: 512,
    };
    const metadata = {
      config: { codec: 'avc1.640028', codedWidth: 16, codedHeight: 16 },
      duration: 600,
      framerate: 60,
    } as VideoMetadata;

    const result = await demuxVideo(request, metadata, onPrepared);

    expect(onPrepared).toHaveBeenCalledWith(60);
    expect(result.totalFrames).toBe(60);
  });

  it('does not read the next packet until the consumer pulls again', async () => {
    const request: ConversionRequest = {
      inputBuffer: new ArrayBuffer(8),
      fileName: 'serial.mp4',
      format: 'gif',
      quality: 'medium',
      scale: 1,
      trimStart: 0,
      trimEnd: 0,
      maxMemoryMB: 512,
    };
    const metadata = {
      config: { codec: 'avc1.640028', codedWidth: 16, codedHeight: 16 },
      duration: 10,
      framerate: 30,
    } as VideoMetadata;
    const result = await demuxVideo(request, metadata);
    if (!(Symbol.asyncIterator in result.chunks)) {
      throw new Error('Expected streaming demux chunks');
    }
    const iterator = result.chunks[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    expect(mocks.getNextPacket).not.toHaveBeenCalled();

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    expect(mocks.getNextPacket).toHaveBeenCalledOnce();
    await iterator.return?.();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('leaves presentation-order trimEnd filtering to the decoder', async () => {
    const request: ConversionRequest = {
      inputBuffer: new ArrayBuffer(8),
      fileName: 'trimmed.mp4',
      format: 'webp',
      quality: 'medium',
      scale: 1,
      trimStart: 0,
      trimEnd: 4,
      maxMemoryMB: 512,
    };
    const metadata = {
      config: { codec: 'avc1.640028', codedWidth: 16, codedHeight: 16 },
      duration: 10,
      framerate: 30,
    } as VideoMetadata;

    const result = await demuxVideo(request, metadata);
    const chunks: EncodedVideoChunk[] = [];
    for await (const chunk of result.chunks) chunks.push(chunk);

    expect(chunks).toHaveLength(2);
    expect(result.trimEndUs).toBe(4_000_000);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
