// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ConversionRequest, VideoMetadata } from '@t/conversion-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  getFirstPacket: vi.fn(),
  getNextPacket: vi.fn(),
  getRotation: vi.fn(),
  getVideoTracks: vi.fn(),
}));

vi.mock('@utils/mediabunny-utils', () => ({
  createMediaBunnyInput: () => ({
    dispose: mocks.dispose,
    getVideoTracks: mocks.getVideoTracks,
  }),
}));

vi.mock('mediabunny', () => ({
  EncodedPacketSink: class {
    getFirstPacket = mocks.getFirstPacket;
    getKeyPacket = mocks.getFirstPacket;
    getNextPacket = mocks.getNextPacket;
  },
}));

import { demuxVideo } from '@services/demuxer-service';

const request: ConversionRequest = {
  inputBuffer: new ArrayBuffer(8),
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
  duration: 10,
  framerate: 30,
} as VideoMetadata;
const firstPacket = {
  byteLength: 4,
  timestamp: 0,
  toEncodedVideoChunk: vi.fn().mockReturnValue({ byteLength: 4, duration: 1_000_000, timestamp: 0 }),
};

describe('demuxVideo cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRotation.mockResolvedValue(0);
    mocks.getVideoTracks.mockResolvedValue([{ getRotation: mocks.getRotation }]);
    mocks.getFirstPacket.mockResolvedValue(firstPacket);
    mocks.getNextPacket.mockResolvedValue(null);
  });

  it('aborts a pending video-track lookup and disposes the input', async () => {
    mocks.getVideoTracks.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const result = demuxVideo(request, metadata, undefined, controller.signal);

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('aborts a pending start-packet lookup and disposes the input', async () => {
    mocks.getFirstPacket.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const result = demuxVideo(request, metadata, undefined, controller.signal);
    await vi.waitFor(() => expect(mocks.getFirstPacket).toHaveBeenCalledOnce());

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('aborts a pending rotation lookup and disposes the input', async () => {
    mocks.getRotation.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const result = demuxVideo(request, metadata, undefined, controller.signal);
    await vi.waitFor(() => expect(mocks.getRotation).toHaveBeenCalledOnce());

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.getFirstPacket).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('aborts a pending packet read and closes the lazy stream', async () => {
    mocks.getNextPacket.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const result = await demuxVideo(request, metadata, undefined, controller.signal);
    if (!(Symbol.asyncIterator in result.chunks)) {
      throw new Error('Expected streaming demux chunks');
    }
    const iterator = result.chunks[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    const next = iterator.next();
    await vi.waitFor(() => expect(mocks.getNextPacket).toHaveBeenCalledOnce());

    controller.abort();

    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
