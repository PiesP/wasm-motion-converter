// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import {
  buildConversionMemoryPlan,
  resolveMemoryPressureDecimation,
  serializeConversionInputs,
} from '@hooks/conversion-handlers/conversion-planning';
import { globalBufferPool } from '@services/buffer-pool';
import { buildConversionRequest } from '@services/conversion-worker/build-conversion-request';
import { decodeFrames } from '@services/decoder-service';
import type { DemuxResult } from '@services/demuxer-service';
import { type BaseEncoderOptions, resolveCadencePolicy } from '@services/encoder-common';
import { encodeGif } from '@services/gif-encoder-service';
import { encodeWebpOffscreen } from '@services/offscreen-webp-encoder';
import { createStreamingWebpEncoder } from '@services/parallel-webp-encoder';
import { encodeWebp } from '@services/webp-encoder-service';
import type { EncodeTask, WebpWorkerPool } from '@services/worker-pool';
import type { ConversionSettings, VideoMetadata } from '@t/conversion-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

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

function installDecoder(frames: SourceFrame[], size = 8, sourceFps = 10): DemuxResult {
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
    close() {
      this.state = 'closed';
    }
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
    duration: (frames.at(-1)!.timestamp + frames.at(-1)!.duration) / 1_000_000,
    framerate: sourceFps,
    sourceTotalMs: (frames.at(-1)!.timestamp + frames.at(-1)!.duration) / 1000,
    totalFrames: frames.length,
    dispose: () => {
      for (const close of closed) expect(close).toHaveBeenCalledOnce();
    },
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
    while (bytes[offset]) {
      const count = bytes[offset++]!;
      offset += count;
    }
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

describe('source presentation boundaries (issues #285 and #287)', () => {
  it.each([2, 3, 4])(
    'admits overdue VFR scenes through decodeFrames at automatic ratio %i',
    async (ratio) => {
      const source = [colorA, colorB, [32, 32, 32] as const].map((rgb, index) => ({
        timestamp: index * 1_000_000,
        duration: 1_000_000,
        rgb,
      }));
      const selected: number[] = [];
      const result = await decodeFrames(installDecoder(source, 8, 30 * ratio), {
        width: 8,
        height: 8,
        frameDecimation: ratio,
        onFrameAvailable: (pixels, _duration, _frameNumber, _handoff, presentation) => {
          selected.push(presentation.startUs);
          globalBufferPool.release(pixels);
        },
      });
      expect(selected).toEqual([0, 1_000_000, 2_000_000]);
      expect(result.selectedFrames).toBe(3);
    }
  );

  it('applies an explicit source-frame gap after an overdue VFR boundary', async () => {
    const source = [colorA, colorB, [32, 32, 32] as const].map((rgb, index) => ({
      timestamp: index * 1_000_000,
      duration: 1_000_000,
      rgb,
    }));
    const selected: number[] = [];
    await decodeFrames(installDecoder(source, 8, 60), {
      width: 8,
      height: 8,
      frameDecimation: 2,
      minimumSourceFrameGap: 2,
      onFrameAvailable: (pixels, _duration, _frameNumber, _handoff, presentation) => {
        selected.push(presentation.startUs);
        globalBufferPool.release(pixels);
      },
    });
    expect(selected).toEqual([0, 2_000_000]);
  });

  it.each(['gif', 'webp'] as const)(
    'serializes all three due VFR scenes through the %s encoder',
    async (format) => {
      const source = [colorA, colorB, [32, 32, 32] as const].map((rgb, index) => ({
        timestamp: index * 1_000_000,
        duration: 1_000_000,
        rgb,
      }));
      const demux = installDecoder(source, 8, 60);
      let selectedFrames = -1;
      const opts: BaseEncoderOptions = {
        width: 8,
        height: 8,
        scale: 1,
        quality: 'high',
        frameDecimation: 2,
        smartFrameSkip: 'off',
        onEncodingComplete: (counts) => {
          selectedFrames = counts.selectedFrames ?? -1;
        },
      };
      const bytes = format === 'gif' ? await encodeGif(demux, opts) : await encodeWebp(demux, opts);
      expect(format === 'gif' ? gifHolds(bytes) : webpHolds(bytes)).toEqual([1000, 1000, 1000]);
      expect(selectedFrames).toBe(3);
    }
  );

  it('keeps the critical 21-fps fractional restriction through planning, wire options, and real decode admission', async () => {
    const settings: ConversionSettings = {
      format: 'gif',
      quality: 'high',
      scale: 1,
      trimStart: 0,
      trimEnd: 0,
      smartFrameSkip: 'off',
    };
    const metadata: VideoMetadata = {
      bitrate: 1_000_000,
      codec: 'vp9',
      config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
      duration: 1,
      framerate: 21,
      width: 8,
      height: 8,
    };
    const plan = buildConversionMemoryPlan(metadata, settings)!;
    const pressureRatio = resolveMemoryPressureDecimation(plan, 'critical');
    const { serializedOptions } = serializeConversionInputs(metadata, pressureRatio, settings);
    const request = buildConversionRequest(new ArrayBuffer(0), serializedOptions);
    const cadence = resolveCadencePolicy(
      metadata.framerate,
      20,
      request.forceDecimation,
      request.memoryPressureCadenceRatio
    );
    const source = Array.from({ length: 21 }, (_, index) => ({
      timestamp: Math.round((index * 1_000_000) / 21),
      duration: Math.round(((index + 1) * 1_000_000) / 21) - Math.round((index * 1_000_000) / 21),
      rgb: [index, index, index] as [number, number, number],
    }));
    const admit = async (
      policy: ReturnType<typeof resolveCadencePolicy>,
      smartFrameSkip: ConversionSettings['smartFrameSkip'] = 'off'
    ) => {
      const selected: number[] = [];
      const result = await decodeFrames(installDecoder(source, 8, 21), {
        width: 8,
        height: 8,
        frameDecimation: policy.frameDecimation,
        minimumSourceFrameGap: policy.minimumSourceFrameGap,
        pressureCadenceRatio: policy.pressureCadenceRatio,
        smartFrameSkip,
        onFrameAvailable: (pixels, _duration, frameNumber) => {
          selected.push(frameNumber);
          globalBufferPool.release(pixels);
        },
      });
      expect(result.selectedFrames).toBe(selected.length);
      return selected;
    };
    const normal = await admit(resolveCadencePolicy(21, 20));
    const selected = await admit(cadence);
    expect(pressureRatio).toBe(1.4);
    expect(request.memoryPressureCadenceRatio).toBe(1.4);
    expect(cadence).toEqual({
      frameDecimation: 21 / 20,
      minimumSourceFrameGap: 1,
      pressureCadenceRatio: 1.4,
    });
    expect(normal).toHaveLength(20);
    expect(selected).toHaveLength(15);
    expect(selected.length).toBeLessThanOrEqual(normal.length);
    for (const smartFrameSkip of ['low', 'adaptive'] as const) {
      const normalApproximate = await admit(resolveCadencePolicy(21, 20), smartFrameSkip);
      const criticalApproximate = await admit(cadence, smartFrameSkip);
      expect(criticalApproximate.length).toBeLessThanOrEqual(normalApproximate.length);
    }
  });

  it('keeps critical VFR admission within the normal timestamp grid', async () => {
    const pts = [0, 100_000, 140_000, 201_000, 270_000];
    const source = pts.map((timestamp, index) => ({
      timestamp,
      duration: (pts[index + 1] ?? 300_000) - timestamp,
      rgb: [index * 40, index * 40, index * 40] as [number, number, number],
    }));
    const admit = async (pressureCadenceRatio?: number) => {
      const policy = resolveCadencePolicy(30, 20, undefined, pressureCadenceRatio);
      const selected: number[] = [];
      await decodeFrames(installDecoder(source, 8, 30), {
        width: 8,
        height: 8,
        ...policy,
        onFrameAvailable: (pixels, _duration, frameNumber) => {
          selected.push(frameNumber);
          globalBufferPool.release(pixels);
        },
      });
      return selected;
    };
    const normal = await admit();
    const critical = await admit(2);
    expect(normal).toEqual([0, 1, 3, 4]);
    expect(critical.every((frameNumber) => normal.includes(frameNumber))).toBe(true);
    expect(critical.length).toBeLessThanOrEqual(normal.length);
  });

  it('keeps normal smart-skip history independent of critical pressure rejection', async () => {
    const source = Array.from({ length: 21 }, (_, index) => {
      const value = index < 4 ? 0 : index === 4 ? 10 : index === 5 ? 7 : 14;
      return {
        timestamp: Math.round((index * 1_000_000) / 21),
        duration: Math.round(((index + 1) * 1_000_000) / 21) - Math.round((index * 1_000_000) / 21),
        rgb: [value, value, value] as [number, number, number],
      };
    });
    const admit = async (pressureCadenceRatio?: number) => {
      const policy = resolveCadencePolicy(21, 20, undefined, pressureCadenceRatio);
      const selected: number[] = [];
      await decodeFrames(installDecoder(source, 8, 21), {
        width: 8,
        height: 8,
        smartFrameSkip: 'high',
        ...policy,
        onFrameAvailable: (pixels, _duration, frameNumber) => {
          selected.push(frameNumber);
          globalBufferPool.release(pixels);
        },
      });
      return selected;
    };
    const normal = await admit();
    const critical = await admit(1.4);
    expect(normal).toContain(4);
    expect(normal).not.toContain(5);
    expect(critical.every((frameNumber) => normal.includes(frameNumber))).toBe(true);
    expect(critical.length).toBeLessThanOrEqual(normal.length);
  });
  describe('fixed streaming cadence', () => {
    const frameStarts: number[] = [];
    let presentationEndUs = 0;
    beforeEach(async () => {
      const intensities: number[] = [];
      const result = await decodeFrames(installDecoder(fourFrames(false)), {
        width: 8,
        height: 8,
        frameDecimation: 2,
        onFrameAvailable: (pixels, _duration, _frameNumber, _handoff, presentation) => {
          intensities.push(pixels[0]!);
          frameStarts.push(presentation.startUs);
          globalBufferPool.release(pixels);
        },
      });
      presentationEndUs = result.presentationEndUs;
      expect(intensities).toEqual([64, 192]);
    });
    it('holds f0 until the original f2 boundary', () => {
      expect(frameStarts).toEqual([0, 200_000]);
      expect(presentationEndUs - frameStarts[1]!).toBe(200_000);
    });
  });

  it('keeps primary-color changes before short-clip noise calibration', async () => {
    const colors = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ] as const;
    const selected: number[][] = [];
    await decodeFrames(
      installDecoder(
        colors.map((rgb, index) => ({
          timestamp: index * 100_000,
          duration: 100_000,
          rgb,
        }))
      ),
      {
        width: 8,
        height: 8,
        smartFrameSkip: 'low',
        onFrameAvailable: (pixels) => {
          selected.push([...pixels.subarray(0, 3)]);
          globalBufferPool.release(pixels);
        },
      }
    );
    expect(selected).toEqual(colors);
  });

  it('retains cursor movement inside one tile through production selection', async () => {
    const size = 128;
    const before = new Uint8Array(size * size * 3);
    const after = before.slice();
    before.set([255, 255, 255], (size + 1) * 3);
    after.set([255, 255, 255], (size + 2) * 3);
    const selected: number[] = [];
    await decodeFrames(
      installDecoder(
        [before, after].map((pixels, index) => ({
          timestamp: index * 100_000,
          duration: 100_000,
          rgb: [0, 0, 0],
          pixels,
        })),
        size
      ),
      {
        width: size,
        height: size,
        smartFrameSkip: 'high',
        onFrameAvailable: (pixels, _duration, frameNumber) => {
          selected.push(frameNumber);
          globalBufferPool.release(pixels);
        },
      }
    );
    expect(selected).toEqual([0, 1]);
  });

  describe.each(['gif', 'webp', 'webp-canvas', 'webp-parallel'] as const)(
    '%s serialized presentation',
    (format) => {
      for (const duplicate of [false, true]) {
        describe(duplicate ? 'smart A/A/A/B removal' : 'fixed f0/f2 sampling', () => {
          let holds: number[] = [];
          beforeEach(async () => {
            const demux = installDecoder(fourFrames(duplicate));
            const opts: BaseEncoderOptions = {
              width: 8,
              height: 8,
              scale: 1,
              quality: 'low' as const,
              ...(duplicate ? { smartFrameSkip: 'low' as const } : { frameDecimation: 2 }),
            };
            let bytes: Uint8Array;
            if (format === 'gif') bytes = await encodeGif(demux, opts);
            else if (format === 'webp') bytes = await encodeWebp(demux, opts);
            else if (format === 'webp-canvas') {
              vi.stubGlobal(
                'ImageData',
                class {
                  constructor(readonly data: Uint8ClampedArray) {}
                }
              );
              vi.stubGlobal(
                'OffscreenCanvas',
                class {
                  private pixels: Uint8ClampedArray = new Uint8ClampedArray(0);
                  getContext() {
                    return {
                      putImageData: (image: { data: Uint8ClampedArray }) => {
                        this.pixels = image.data;
                      },
                    };
                  }
                  async convertToBlob() {
                    return new Blob([simpleWebp(this.pixels[0]!)], { type: 'image/webp' });
                  }
                }
              );
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
                  width: 8,
                  height: 8,
                  pixelFormat: 'rgba',
                  frameDecimation: opts.frameDecimation,
                  smartFrameSkip: opts.smartFrameSkip,
                  onFrameAvailable: (pixels, duration, _index, handoff, timing) =>
                    encoder.submit(pixels, duration, handoff, timing),
                });
                bytes = await encoder.finish(result.presentationEndUs);
              } finally {
                encoder.dispose();
              }
            }
            holds = format === 'gif' ? gifHolds(bytes) : webpHolds(bytes);
            expect(holds.reduce((sum, duration) => sum + duration, 0)).toBe(400);
          });
          it('retains the source scene boundary and closes at 400ms', () => {
            expect(holds).toEqual(duplicate ? [300, 100] : [200, 200]);
          });
        });
      }
    }
  );
});
