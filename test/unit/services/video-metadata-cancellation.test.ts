// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  getVideoTracks: vi.fn(),
}));

vi.mock('@utils/mediabunny-utils', () => ({
  createMediaBunnyInput: () => ({
    dispose: mocks.dispose,
    getVideoTracks: mocks.getVideoTracks,
  }),
}));
vi.mock('@utils/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { extractVideoMetadata } from '@services/video-metadata';

describe('extractVideoMetadata cancellation', () => {
  beforeEach(() => {
    mocks.dispose.mockReset();
    mocks.getVideoTracks.mockReset();
  });

  it('disposes the active MediaBunny input and rejects immediately on abort', async () => {
    mocks.getVideoTracks.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const extraction = extractVideoMetadata(new Blob(['video']), 30, controller.signal);

    controller.abort();

    expect(mocks.dispose).toHaveBeenCalledOnce();
    await expect(extraction).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('does not swallow cancellation during optional packet statistics', async () => {
    const computePacketStats = vi.fn().mockReturnValue(new Promise(() => {}));
    mocks.getVideoTracks.mockResolvedValue([
      {
        computeDuration: vi.fn().mockResolvedValue(2),
        computePacketStats,
        getDecoderConfig: vi.fn().mockResolvedValue({
          codec: 'vp09.00.10.08',
          codedHeight: 16,
          codedWidth: 16,
        }),
      },
    ]);
    const controller = new AbortController();
    const extraction = extractVideoMetadata(new Blob(['video']), 30, controller.signal);
    await vi.waitFor(() => expect(computePacketStats).toHaveBeenCalledOnce());

    controller.abort();

    await expect(extraction).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('preserves ordinary metadata extraction and disposes once', async () => {
    const track = {
      computeDuration: vi.fn().mockResolvedValue(2),
      computePacketStats: vi.fn().mockResolvedValue({
        averageBitrate: 1_000_000,
        averagePacketRate: 30,
      }),
      getDecoderConfig: vi.fn().mockResolvedValue({
        codec: 'vp09.00.10.08',
        codedHeight: 16,
        codedWidth: 16,
      }),
    };
    mocks.getVideoTracks.mockResolvedValue([track]);

    await expect(extractVideoMetadata(new Blob(['video']))).resolves.toMatchObject({
      codec: 'vp09',
      duration: 2,
      height: 16,
      width: 16,
    });
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('falls back instead of forwarding non-finite packet metadata', async () => {
    const track = {
      computeDuration: vi.fn().mockResolvedValue(Number.POSITIVE_INFINITY),
      computePacketStats: vi.fn().mockResolvedValue({
        averageBitrate: Number.POSITIVE_INFINITY,
        averagePacketRate: Number.POSITIVE_INFINITY,
      }),
      getAverageBitrate: vi.fn().mockResolvedValue(Number.POSITIVE_INFINITY),
      getBitrate: vi.fn().mockResolvedValue(Number.NaN),
      getDecoderConfig: vi.fn().mockResolvedValue({
        codec: 'vp09.00.10.08',
        codedHeight: 16,
        codedWidth: 16,
      }),
    };
    mocks.getVideoTracks.mockResolvedValue([track]);

    await expect(extractVideoMetadata(new Blob(['video']), 24)).resolves.toMatchObject({
      bitrate: 0,
      duration: 0,
      framerate: 24,
    });
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
