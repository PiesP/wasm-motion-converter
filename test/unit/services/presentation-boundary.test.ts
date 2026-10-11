// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, describe, expect, it, vi } from 'vitest';
import { globalBufferPool } from '@services/buffer-pool';
import { decodeFrames } from '@services/decoder-service';
import type { DemuxResult } from '@services/demuxer-service';
import { encodeGif } from '@services/gif-encoder-service';
import { encodeWebp } from '@services/webp-encoder-service';

// The native codec is the platform boundary. Decoder selection, pixel copy,
// gifenc, encoder skipping and container serialization remain production code.
vi.mock('@services/wasm-webp-singleton', () => ({
  encodeRGBReuse: async (rgb: Uint8Array) => {
    const result = new Uint8Array(28);
    const view = new DataView(result.buffer);
    view.setUint32(0, 0x52494646);
    view.setUint32(4, 20, true);
    view.setUint32(8, 0x57454250);
    view.setUint32(12, 0x56503820);
    view.setUint32(16, 8, true);
    result[20] = rgb[0]!;
    return result;
  },
}));

interface SourceFrame {
  timestamp: number;
  duration: number;
  rgb: readonly [number, number, number];
}

function installDecoder(frames: SourceFrame[]): DemuxResult {
  const closed: Array<ReturnType<typeof vi.fn>> = [];
  class FixtureDecoder {
    static async isConfigSupported(config: VideoDecoderConfig) {
      return { config, supported: true };
    }
    state = 'configured';
    decodeQueueSize = 0;
    private index = 0;
    constructor(private readonly init: VideoDecoderInit) {}
    configure() {}
    close() { this.state = 'closed'; }
    reset() {}
    async flush() {}
    decode() {
      const source = frames[this.index++]!;
      const close = vi.fn();
      closed.push(close);
      this.init.output({
        ...source,
        codedWidth: 8,
        codedHeight: 8,
        displayWidth: 8,
        displayHeight: 8,
        format: 'RGBA',
        allocationSize: () => 8 * 8 * 4,
        async copyTo(destination: Uint8Array) {
          for (let offset = 0; offset < 8 * 8 * 4; offset += 4) {
            destination.set([...source.rgb, 255], offset);
          }
          return [{ offset: 0, stride: 32 }];
        },
        close,
      } as unknown as VideoFrame);
    }
  }
  vi.stubGlobal('VideoDecoder', FixtureDecoder);
  return {
    chunks: frames.map((frame) => ({
      timestamp: frame.timestamp,
      duration: frame.duration,
      byteLength: 1,
      type: 'key' as const,
      copyTo: vi.fn(),
    })),
    config: { codec: 'vp09.presentation-fixture', codedWidth: 8, codedHeight: 8 },
    duration: 0.4,
    framerate: 10,
    sourceTotalMs: 400,
    totalFrames: frames.length,
    dispose: () => { for (const close of closed) expect(close).toHaveBeenCalledOnce(); },
  };
}

const colorA = [64, 64, 64] as const;
const colorB = [192, 192, 192] as const;
function fourFrames(duplicate: boolean): SourceFrame[] {
  return Array.from({ length: 4 }, (_, index) => ({
    timestamp: index * 100_000,
    duration: 100_000,
    rgb: duplicate && index < 3 ? colorA : index < 2 ? colorA : colorB,
  }));
}

// Parse block boundaries rather than searching compressed bytes for signatures.
function gifHolds(bytes: Uint8Array): number[] {
  let offset = 13;
  if (bytes[10]! & 0x80) offset += 3 * (1 << ((bytes[10]! & 7) + 1));
  const holds: number[] = [];
  const subBlocks = () => {
    while (bytes[offset]) { const count = bytes[offset++]!; offset += count; }
    offset++;
  };
  while (offset < bytes.length) {
    const type = bytes[offset++];
    if (type === 0x3b) break;
    if (type === 0x21) {
      const label = bytes[offset++];
      if (label === 0xf9) {
        expect(bytes[offset]).toBe(4);
        holds.push((bytes[offset + 2]! | (bytes[offset + 3]! << 8)) * 10);
      }
      subBlocks();
    } else {
      expect(type).toBe(0x2c);
      const packed = bytes[offset + 8]!;
      offset += 9;
      if (packed & 0x80) offset += 3 * (1 << ((packed & 7) + 1));
      offset++; // LZW initial code size.
      subBlocks();
    }
  }
  return holds;
}

function webpHolds(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const holds: number[] = [];
  for (let offset = 12; offset < bytes.length;) {
    const size = view.getUint32(offset + 4, true);
    if (view.getUint32(offset) === 0x414e4d46) {
      holds.push(bytes[offset + 20]! | (bytes[offset + 21]! << 8) | (bytes[offset + 22]! << 16));
    }
    offset += 8 + size + (size & 1);
  }
  return holds;
}

afterEach(() => {
  vi.unstubAllGlobals();
  globalBufferPool.clear();
});

describe('source presentation boundaries (issue #285 baseline defects)', () => {
  // These expected failures freeze the independent source-derived requirements.
  // Remove .fails as each production path is corrected; do not change the oracle.
  it.fails('holds batch f0 until the original f2 boundary under fixed 2:1 sampling', async () => {
    const output = await decodeFrames(installDecoder(fourFrames(false)), {
      width: 8, height: 8, frameDecimation: 2, mode: 'batch',
    });
    try {
      expect(output.frames.map((frame) => frame.data[0])).toEqual([64, 192]);
      expect(output.frames.map((frame) => frame.duration)).toEqual([200, 200]);
    } finally {
      for (const frame of output.frames) globalBufferPool.release(frame.data);
    }
  });

  it('keeps primary-color changes before short-clip noise calibration', async () => {
    const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255]] as const;
    const selected: number[][] = [];
    await decodeFrames(installDecoder(colors.map((rgb, index) => ({
      timestamp: index * 100_000, duration: 100_000, rgb,
    }))), {
      width: 8, height: 8, smartFrameSkip: 'low', mode: 'stream',
      onFrameAvailable: (pixels) => {
        selected.push([...pixels.subarray(0, 3)]);
        globalBufferPool.release(pixels);
      },
    });
    expect(selected).toEqual(colors);
  });

  for (const format of ['gif', 'webp'] as const) {
    it.fails(`${format}: fixed f0/f2 begin at 0/200ms and close at 400ms`, async () => {
      const demux = installDecoder(fourFrames(false));
      const opts = { width: 8, height: 8, scale: 1, quality: 'low' as const, frameDecimation: 2 };
      const bytes = format === 'gif' ? await encodeGif(demux, opts) : await encodeWebp(demux, opts);
      expect(format === 'gif' ? gifHolds(bytes) : webpHolds(bytes)).toEqual([200, 200]);
    });

    it.fails(`${format}: smart removal of A/A/A/B holds A for 300ms and B for 100ms`, async () => {
      const demux = installDecoder(fourFrames(true));
      const opts = { width: 8, height: 8, scale: 1, quality: 'low' as const, smartFrameSkip: 'low' as const };
      const bytes = format === 'gif' ? await encodeGif(demux, opts) : await encodeWebp(demux, opts);
      expect(format === 'gif' ? gifHolds(bytes) : webpHolds(bytes)).toEqual([300, 100]);
    });
  }
});
