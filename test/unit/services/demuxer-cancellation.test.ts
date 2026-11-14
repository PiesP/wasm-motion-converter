// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ConversionRequest, VideoMetadata } from '@t/conversion-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  readPacket: vi.fn(),
  release: vi.fn(),
}));
vi.mock('@services/owned-demux-core', () => ({
  createOwnedDemuxSession: vi.fn(async (_source: Blob | ArrayBuffer, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    return {
      analyze: mocks.analyze,
      packet: () => ({
        index: 0,
        byteLength: 4,
        ptsTicks: 0n,
        durationTicks: 1_000_000n,
        key: true,
      }),
      readPacket: mocks.readPacket,
      release: mocks.release,
      transferStats: { wasmCapacityBytes: 8 * 1024 * 1024 },
    };
  }),
  computeOwnedPacketStats: vi.fn(async () => null),
  classifyOwnedDemuxError: (error: unknown) => error,
  OwnedDemuxResourceError: class extends Error {},
}));
vi.mock('@services/owned-demux-config', () => ({
  ownedDecoderConfig: () => ({ codec: 'avc1.640028', codedWidth: 16, codedHeight: 16 }),
  ownedTimestampUs: (ticks: bigint, timescale: number) =>
    Math.trunc((Number(ticks) / timescale) * 1_000_000),
}));
vi.mock('@utils/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { demuxVideo } from '@services/demuxer-service';

const request: ConversionRequest = {
  inputBuffer: new ArrayBuffer(128),
  fileName: 'abort.mp4',
  format: 'webp',
  quality: 'medium',
  scale: 1,
  trimStart: 0,
  trimEnd: 0,
  maxMemoryMB: 512,
};
const metadata = {
  config: { codec: 'avc1.640028', codedWidth: 16, codedHeight: 16 },
  duration: 1,
  framerate: 1,
} as VideoMetadata;
const track = {
  codec: 'avc1',
  description: new Uint8Array(16),
  durationTicks: 1_000_000n,
  timescale: 1_000_000,
  rotation: 0,
  packetCount: 1,
  maxPacketBytes: 4,
};

describe('demuxVideo owned parser cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'EncodedVideoChunk',
      class {
        byteLength = 4;
        duration = 1_000_000;
        timestamp = 0;
      }
    );
    mocks.analyze.mockResolvedValue(track);
    mocks.readPacket.mockResolvedValue(new ArrayBuffer(4));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('aborts pending analysis and releases the session once', async () => {
    const controller = new AbortController();
    mocks.analyze.mockImplementation(
      (signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Cancelled', 'AbortError')),
            {
              once: true,
            }
          )
        )
    );
    const pending = demuxVideo(request, metadata, undefined, controller.signal);
    await vi.waitFor(() => expect(mocks.analyze).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('aborts an active lazy packet read without publishing a chunk', async () => {
    const controller = new AbortController();
    mocks.readPacket.mockImplementation(
      (_packet: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Cancelled', 'AbortError')),
            {
              once: true,
            }
          )
        )
    );
    const result = await demuxVideo(request, metadata, undefined, controller.signal);
    if (!(Symbol.asyncIterator in result.chunks)) throw new Error('Expected lazy packet stream');
    const iterator = result.chunks[Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.waitFor(() => expect(mocks.readPacket).toHaveBeenCalledOnce());
    controller.abort();
    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
    expect(result.totalFrames).toBe(0);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('recovers with a fresh session after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(demuxVideo(request, metadata, undefined, controller.signal)).rejects.toMatchObject(
      {
        name: 'AbortError',
      }
    );
    const next = await demuxVideo(request, metadata);
    const chunks: EncodedVideoChunk[] = [];
    for await (const chunk of next.chunks) chunks.push(chunk);
    expect(chunks).toHaveLength(1);
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
