// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ConversionRequest, VideoMetadata } from '@t/conversion-types';
import {
  DEMUX_MEMORY_BUDGET_BYTES,
  ENCODED_CHUNK_BUDGET_BYTES,
  ENCODED_PACKET_BUDGET_BYTES,
  MAX_FILE_SIZE,
} from '@utils/constants';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  importIndex: vi.fn(),
  findVerifiedKey: vi.fn(),
  packet: vi.fn(),
  readPacket: vi.fn(),
  release: vi.fn(),
  enablePacketReadWindow: vi.fn(),
  transferStats: { wasmCapacityBytes: 8 * 1024 * 1024 },
  reconstructsPackets: false,
}));
vi.mock('@services/owned-demux-core', () => ({
  createOwnedDemuxSession: vi.fn(async () => ({
    analyze: mocks.analyze,
    importIndex: mocks.importIndex,
    findVerifiedKey: mocks.findVerifiedKey,
    packetAsync: mocks.packet,
    readPacket: mocks.readPacket,
    release: mocks.release,
    enablePacketReadWindow: mocks.enablePacketReadWindow,
    seekWorkspaceBytes: 0,
    transferStats: mocks.transferStats,
    reconstructsPackets: mocks.reconstructsPackets,
  })),
  computeOwnedPacketStats: vi.fn(async () => ({ averagePacketRate: 6, averageBitrate: 48_000 })),
  classifyOwnedDemuxError: (error: unknown) => error,
  OwnedDemuxResourceError: class extends Error {},
}));
vi.mock('@services/owned-demux-index-snapshot', () => ({
  fingerprintOwnedDemuxSource: vi.fn(async () => 'a'.repeat(64)),
}));
vi.mock('@services/owned-demux-config', () => ({
  ownedDecoderConfig: () => ({ codec: 'avc1.4d400a', codedWidth: 96, codedHeight: 64 }),
  ownedTimestampUs: (ticks: bigint, timescale: number) =>
    Math.trunc((Number(ticks) / timescale) * 1_000_000),
}));
vi.mock('@utils/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { demuxVideo } from '@services/demuxer-service';

const timestamps = [
  0, 500_000, 166_666, 333_333, 833_333, 666_666, 1_000_000, 1_500_000, 1_166_666, 1_333_333,
  1_833_333, 1_666_666,
];
const track = {
  codec: 'avc1',
  description: new Uint8Array(32),
  timescale: 1_000_000,
  durationTicks: 2_000_000n,
  rotation: 0,
  packetCount: timestamps.length,
  maxPacketBytes: 4,
};
const metadata = {
  config: { codec: 'avc1.4d400a', codedWidth: 96, codedHeight: 64 },
  duration: 2,
  framerate: 6,
} as VideoMetadata;
function request(trimStart = 0, trimEnd = 0): ConversionRequest {
  return {
    inputBuffer: new ArrayBuffer(128),
    fileName: 'bframes.mp4',
    format: 'gif',
    quality: 'medium',
    scale: 1,
    trimStart,
    trimEnd,
    maxMemoryMB: 512,
  };
}

class TestEncodedVideoChunk {
  readonly byteLength: number;
  readonly duration: number;
  readonly timestamp: number;
  readonly type: string;
  constructor(init: EncodedVideoChunkInit) {
    this.byteLength = init.data.byteLength;
    this.duration = init.duration ?? 0;
    this.timestamp = init.timestamp;
    this.type = init.type;
  }
}

describe('demuxVideo owned packet route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('EncodedVideoChunk', TestEncodedVideoChunk);
    track.maxPacketBytes = 4;
    mocks.reconstructsPackets = false;
    mocks.analyze.mockResolvedValue(track);
    mocks.importIndex.mockResolvedValue(track);
    mocks.findVerifiedKey.mockResolvedValue(6);
    mocks.packet.mockImplementation((index: number) => ({
      index,
      byteLength: 4,
      ptsTicks: BigInt(timestamps[index]!),
      durationTicks: 166_666n,
      key: index === 0 || index === 6,
    }));
    mocks.readPacket.mockResolvedValue(new ArrayBuffer(4));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the source ArrayBuffer and yields decode-order packets lazily', async () => {
    const source = request();
    const result = await demuxVideo(source, metadata);
    expect(result.inputBufferBytes).toBe(source.inputBuffer?.byteLength);
    expect(result.encodedChunkBudgetBytes).toBe(ENCODED_CHUNK_BUDGET_BYTES);
    expect(result.totalFrames).toBe(12);
    expect(mocks.readPacket).not.toHaveBeenCalled();
    if (!(Symbol.asyncIterator in result.chunks)) throw new Error('Expected lazy packet stream');
    const iterator = result.chunks[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { timestamp: 0 } });
    expect(mocks.readPacket).toHaveBeenCalledTimes(1);
    await expect(iterator.next()).resolves.toMatchObject({ value: { timestamp: 500_000 } });
    expect(mocks.readPacket).toHaveBeenCalledTimes(2);
    await iterator.return?.();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(result.totalFrames).toBe(2);
  });

  it('starts at the verified key before trim and retains future B-frame references', async () => {
    const prepared = vi.fn();
    const result = await demuxVideo(request(1.2, 1.3), metadata, prepared);
    expect(mocks.findVerifiedKey).toHaveBeenCalledWith(1.2, undefined);
    expect(prepared).toHaveBeenCalledWith(1);
    const timestampsSeen: number[] = [];
    for await (const chunk of result.chunks) timestampsSeen.push(chunk.timestamp);
    expect(timestampsSeen).toEqual(timestamps.slice(6));
    expect(timestampsSeen[1]).toBe(1_500_000);
    expect(result.trimStartUs).toBe(1_200_000);
    expect(result.trimEndUs).toBe(1_300_000);
    expect(result.totalFrames).toBe(6);
    expect(result.sourceTotalMs).toBeCloseTo(999.996);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it.each([
    [true, MAX_FILE_SIZE, false],
    [false, MAX_FILE_SIZE, true],
    [false, MAX_FILE_SIZE + 1, true],
  ] as const)(
    'checks pre-read credit with reconstruction=%s for a Blob of %i bytes',
    async (reconstructsPackets, size, gated) => {
      mocks.reconstructsPackets = reconstructsPackets;
      const inputBlob = new Blob();
      vi.spyOn(inputBlob, 'size', 'get').mockReturnValue(size);
      const result = await demuxVideo(
        { ...request(1.2, 1.3), inputBuffer: undefined, inputBlob },
        metadata
      );
      expect(typeof result.setPacketReadGate).toBe(gated ? 'function' : 'undefined');
      expect(mocks.readPacket).not.toHaveBeenCalled();
      result.dispose?.();
    }
  );

  it('offers indexed byte charges before a direct read and closes on refusal', async () => {
    const inputBlob = new Blob();
    mocks.packet.mockImplementation((index: number) => ({
      index,
      byteLength: index === 6 ? 4 : 2,
      ptsTicks: BigInt(timestamps[index]!),
      durationTicks: 166_666n,
      key: index === 6,
    }));
    const result = await demuxVideo(
      { ...request(1.2, 1.3), inputBuffer: undefined, inputBlob },
      metadata
    );
    const gate = vi
      .fn<(bytes: number) => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    result.setPacketReadGate!(gate);
    if (!(Symbol.asyncIterator in result.chunks)) throw new Error('Expected lazy packet stream');
    const iterator = result.chunks[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { byteLength: 4 } });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(gate.mock.calls).toEqual([[1028], [1026]]);
    expect(mocks.readPacket).toHaveBeenCalledOnce();
    expect(gate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.readPacket.mock.invocationCallOrder[0]!
    );
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('uses admitted compact seek workspace instead of charging every logical packet', async () => {
    mocks.analyze.mockResolvedValue({ ...track, packetCount: 100_000_000 });
    const result = await demuxVideo(request(1), metadata);
    expect(result.encodedChunkBudgetBytes).toBe(ENCODED_CHUNK_BUDGET_BYTES);
    result.dispose?.();
  });

  it('enables the window after admission on parsed and imported conversion routes', async () => {
    const parsed = await demuxVideo(request(1), metadata);
    expect(parsed.indexRoute).toBe('parsed');
    expect(mocks.enablePacketReadWindow).toHaveBeenCalledOnce();
    expect(mocks.enablePacketReadWindow.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.analyze.mock.invocationCallOrder[0]!
    );
    expect(mocks.enablePacketReadWindow.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findVerifiedKey.mock.invocationCallOrder[0]!
    );
    parsed.dispose?.();

    vi.clearAllMocks();
    mocks.importIndex.mockResolvedValue(track);
    mocks.findVerifiedKey.mockResolvedValue(6);
    const source = new Blob([new Uint8Array(128)]);
    const imported = await demuxVideo(
      {
        ...request(1),
        inputBuffer: undefined,
        inputBlob: source,
        indexSnapshot: {
          version: 1,
          generation: 1,
          sourceSize: source.size,
          fingerprint: 'a'.repeat(64),
          bytes: new ArrayBuffer(96),
        },
      },
      metadata
    );
    expect(imported.indexRoute).toBe('imported');
    expect(mocks.analyze).not.toHaveBeenCalled();
    expect(mocks.importIndex).toHaveBeenCalledOnce();
    expect(mocks.enablePacketReadWindow.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.importIndex.mock.invocationCallOrder[0]!
    );
    expect(mocks.enablePacketReadWindow.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findVerifiedKey.mock.invocationCallOrder[0]!
    );
    imported.dispose?.();
  });

  it('rejects the aggregate reserve before reading any oversized packet', async () => {
    track.maxPacketBytes = DEMUX_MEMORY_BUDGET_BYTES;
    await expect(demuxVideo(request(), metadata)).rejects.toThrow('Demux memory limit exceeded');
    expect(mocks.readPacket).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('preserves admission for the existing maximum packet size', async () => {
    track.maxPacketBytes = ENCODED_PACKET_BUDGET_BYTES - 1024;
    const result = await demuxVideo(request(), metadata);
    expect(result.encodedChunkBudgetBytes).toBeGreaterThanOrEqual(track.maxPacketBytes + 1024);
    expect(mocks.enablePacketReadWindow).toHaveBeenCalledOnce();
    result.dispose?.();
  });

  it('bounds a reused decoder description before reserving the packet stream', async () => {
    const oversized = {
      duration: 2,
      framerate: 6,
      config: {
        codec: 'avc1.4d400a',
        codedWidth: 96,
        codedHeight: 64,
        description: new Uint8Array(1024 * 1024 + 1),
      },
    };
    await expect(demuxVideo(request(), oversized)).rejects.toThrow('decoder configuration');
    expect(mocks.readPacket).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
