// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  release: vi.fn(),
  stats: vi.fn(),
}));
vi.mock('@services/owned-demux-core', () => ({
  createOwnedDemuxSession: vi.fn(async () => ({
    analyze: mocks.analyze,
    release: mocks.release,
  })),
  computeOwnedPacketStats: mocks.stats,
  classifyOwnedDemuxError: (error: unknown) => error,
}));
vi.mock('@services/owned-demux-config', () => ({
  ownedDecoderConfig: () => ({
    codec: 'avc1.42c00a',
    codedWidth: 80,
    codedHeight: 48,
    colorSpace: { fullRange: false },
  }),
  ownedTimestampUs: (ticks: bigint, timescale: number) =>
    Math.trunc((Number(ticks) / timescale) * 1_000_000),
}));
vi.mock('@utils/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { extractVideoMetadata } from '@services/video-metadata';

const track = {
  width: 80,
  height: 48,
  displayWidth: 80,
  displayHeight: 48,
  rotation: 270,
  durationTicks: 2_000n,
  timescale: 1_000,
  packetCount: 12,
};

describe('extractVideoMetadata owned parser lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.analyze.mockResolvedValue(track);
    mocks.stats.mockResolvedValue({ averagePacketRate: 29.997, averageBitrate: 1_000_000.4 });
  });

  afterEach(() => vi.useRealTimers());

  it('uses owned decoder metadata and rounded packet statistics, then releases once', async () => {
    await expect(extractVideoMetadata(new Blob(['video']))).resolves.toMatchObject({
      width: 48,
      height: 80,
      codec: 'avc1',
      duration: 2,
      framerate: 30,
      bitrate: 1_000_000,
      rotation: 270,
    });
    expect(mocks.stats).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('falls back to the caller FPS when bounded statistics are unavailable', async () => {
    mocks.stats.mockResolvedValue(null);
    await expect(extractVideoMetadata(new Blob(['video']), 24)).resolves.toMatchObject({
      framerate: 24,
      bitrate: 0,
    });
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('rejects cancellation during metadata analysis and releases the parser', async () => {
    const controller = new AbortController();
    mocks.analyze.mockImplementation(
      (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Cancelled', 'AbortError')),
            {
              once: true,
            }
          );
        })
    );
    const pending = extractVideoMetadata(new Blob(['video']), 30, controller.signal);
    await vi.waitFor(() => expect(mocks.analyze).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
