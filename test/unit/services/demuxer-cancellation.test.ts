// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ConversionRequest, VideoMetadata } from '@t/conversion-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  getFirstPacket: vi.fn(),
  getVideoTracks: vi.fn(),
  nextPacket: vi.fn(),
  returnPackets: vi.fn(),
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

    packets() {
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: mocks.nextPacket,
        return: mocks.returnPackets,
      };
    }
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
  timestamp: 0,
  toEncodedVideoChunk: vi.fn(),
};

describe('demuxVideo cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVideoTracks.mockResolvedValue([{}]);
    mocks.getFirstPacket.mockResolvedValue(firstPacket);
    mocks.returnPackets.mockResolvedValue({ done: true, value: undefined });
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

  it('aborts a pending packet read and closes the lazy stream', async () => {
    mocks.nextPacket.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const result = await demuxVideo(request, metadata, undefined, controller.signal);
    const iterator = result.chunks[Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.waitFor(() => expect(mocks.nextPacket).toHaveBeenCalledOnce());

    controller.abort();

    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.returnPackets).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
