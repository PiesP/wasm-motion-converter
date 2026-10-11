// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { globalBufferPool } from '@services/buffer-pool';
import { decodeFrames } from '@services/decoder-service';
import type { DemuxResult } from '@services/demuxer-service';
import { encodeGif } from '@services/gif-encoder-service';
import { encodeWebp } from '@services/webp-encoder-service';
import { encodeWebpOffscreen } from '@services/offscreen-webp-encoder';
import { createStreamingWebpEncoder } from '@services/parallel-webp-encoder';
import type { WebpWorkerPool, EncodeTask } from '@services/worker-pool';
import type { BaseEncoderOptions } from '@services/encoder-common';

function vp8Frame(color: number): Uint8Array<ArrayBuffer> {
  // A VP8 keyframe with an 8x8 coded canvas and a scene-specific payload byte.
  return new Uint8Array([0x10, 0, 0, 0x9d, 0x01, 0x2a, 8, 0, 8, 0, color]);
}

function simpleWebp(color: number): Uint8Array<ArrayBuffer> {
  const frame = vp8Frame(color);
  const result = new Uint8Array(20 + frame.length + (frame.length & 1));
  const view = new DataView(result.buffer);
  view.setUint32(0, 0x52494646);
  view.setUint32(4, result.length - 8, true);
  view.setUint32(8, 0x57454250);
  view.setUint32(12, 0x56503820);
  view.setUint32(16, frame.length, true);
  result.set(frame, 20);
  return result;
}

// The native codec is the platform boundary. Decoder selection, pixel copy,
// gifenc, encoder skipping and container serialization remain production code.
vi.mock('@services/wasm-webp-singleton', () => ({
  encodeRGBReuse: async (rgb: Uint8Array) => {
    return simpleWebp(rgb[0]!);
  },
}));

interface SourceFrame {
  timestamp: number;
  duration: number;
  rgb: readonly [number, number, number];
  pixels?: Uint8Array;
}

function installDecoder(frames: SourceFrame[], size = 8): DemuxResult {
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
        codedWidth: size,
        codedHeight: size,
        displayWidth: size,
        displayHeight: size,
        format: 'RGBA',
        allocationSize: () => size * size * 4,
        async copyTo(destination: Uint8Array) {
          for (let pixel = 0; pixel < size * size; pixel++) {
            const rgb = source.pixels?.subarray(pixel * 3, pixel * 3 + 3) ?? source.rgb;
            destination.set([...rgb, 255], pixel * 4);
          }
          return [{ offset: 0, stride: size * 4 }];
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
    config: { codec: 'vp09.presentation-fixture', codedWidth: size, codedHeight: size },
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

describe('source presentation boundaries (issue #285)', () => {
  describe('fixed batch cadence', () => {
    let frames: Awaited<ReturnType<typeof decodeFrames>>['frames'] = [];
    beforeEach(async () => {
      frames = (await decodeFrames(installDecoder(fourFrames(false)), {
        width: 8, height: 8, frameDecimation: 2, mode: 'batch',
      })).frames;
      expect(frames.map((frame) => frame.data[0])).toEqual([64, 192]);
    });
    afterEach(() => { for (const frame of frames) globalBufferPool.release(frame.data); });
    it('holds f0 until the original f2 boundary', () => {
      expect(frames.map((frame) => frame.duration)).toEqual([200, 200]);
    });
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

  it('retains cursor movement inside one tile through production selection', async () => {
    const size = 128;
    const before = new Uint8Array(size * size * 3);
    const after = before.slice();
    before.set([255, 255, 255], (size + 1) * 3);
    after.set([255, 255, 255], (size + 2) * 3);
    const selected: number[] = [];
    await decodeFrames(installDecoder([before, after].map((pixels, index) => ({
      timestamp: index * 100_000, duration: 100_000, rgb: [0, 0, 0], pixels,
    })), size), {
      width: size, height: size, smartFrameSkip: 'high', mode: 'stream',
      onFrameAvailable: (pixels, _duration, frameNumber) => {
        selected.push(frameNumber);
        globalBufferPool.release(pixels);
      },
    });
    expect(selected).toEqual([0, 1]);
  });

  describe.each(['gif', 'webp', 'webp-canvas', 'webp-parallel'] as const)('%s serialized presentation', (format) => {
    for (const duplicate of [false, true]) {
      describe(duplicate ? 'smart A/A/A/B removal' : 'fixed f0/f2 sampling', () => {
        let holds: number[] = [];
        beforeEach(async () => {
          const demux = installDecoder(fourFrames(duplicate));
          const opts: BaseEncoderOptions = {
            width: 8, height: 8, scale: 1, quality: 'low' as const,
            ...(duplicate ? { smartFrameSkip: 'low' as const } : { frameDecimation: 2 }),
          };
          let bytes: Uint8Array;
          if (format === 'gif') bytes = await encodeGif(demux, opts);
          else if (format === 'webp') bytes = await encodeWebp(demux, opts);
          else if (format === 'webp-canvas') {
            vi.stubGlobal('ImageData', class {
              constructor(readonly data: Uint8ClampedArray) {}
            });
            vi.stubGlobal('OffscreenCanvas', class {
              private pixels: Uint8ClampedArray = new Uint8ClampedArray(0);
              getContext() {
                return { putImageData: (image: { data: Uint8ClampedArray }) => { this.pixels = image.data; } };
              }
              async convertToBlob() {
                return new Blob([simpleWebp(this.pixels[0]!)], { type: 'image/webp' });
              }
            });
            bytes = await encodeWebpOffscreen(demux, opts);
          } else {
            const pool = {
              activeWorkers: 1,
              encode: async (task: EncodeTask) => {
                const bitstream = vp8Frame(task.rgbaData[0]!);
                globalBufferPool.release(task.rgbaData);
                return { id: task.id, bitstream };
              },
            } as unknown as WebpWorkerPool;
            const encoder = createStreamingWebpEncoder(pool, 8, 8, 'low', 4);
            try {
              const result = await decodeFrames(demux, {
                width: 8, height: 8, pixelFormat: 'rgba',
                frameDecimation: opts.frameDecimation,
                smartFrameSkip: opts.smartFrameSkip,
                onFrameAvailable: (pixels, duration, _index, handoff, timing) => encoder.submit(pixels, duration, handoff, timing),
              });
              bytes = await encoder.finish(result.presentationEndUs);
            } finally { encoder.dispose(); }
          }
          holds = format === 'gif' ? gifHolds(bytes) : webpHolds(bytes);
          expect(holds.reduce((sum, duration) => sum + duration, 0)).toBe(400);
        });
        it('retains the source scene boundary and closes at 400ms', () => {
          expect(holds).toEqual(duplicate ? [300, 100] : [200, 200]);
        });
      });
    }
  });
});
