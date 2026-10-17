// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { compareAnimatedOutputExact } from '../../validation/windows/output-contract.mjs';

interface FixtureFrame {
  rgba: number[];
  duration: number;
  width?: number;
  height?: number;
}

interface Fixture {
  frames: FixtureFrame[];
  loops: number;
  paletteTag?: string;
  firstRect?: { left: number; top: number; width: number; height: number };
  firstTransparent?: boolean;
  firstBlend?: boolean;
  firstCodec?: 'VP8 ' | 'VP8L';
}

const red = [255, 0, 0, 255];
const blue = [0, 0, 255, 255];
const fixtureByBytes = new Map<string, Fixture>();
let nextFixtureId = 1;
const bytesKey = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const u16 = (value: number) => [value & 255, (value >>> 8) & 255];
const u24 = (value: number) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255];
const u32 = (value: number) => [...u16(value), ...u16(value >>> 16)];
const fourcc = (name: string) => [...new TextEncoder().encode(name)];
const chunk = (name: string, payload: number[]) => [
  ...fourcc(name),
  ...u32(payload.length),
  ...payload,
  ...(payload.length & 1 ? [0] : []),
];

function encode(fixture: Fixture, format: 'gif' | 'webp' = 'gif') {
  const id = nextFixtureId++;
  const canvas = fixture.frames[0];
  if (!canvas) throw new Error('Fixture requires a first frame');
  const width = canvas.width ?? 1;
  const height = canvas.height ?? 1;
  const rect = fixture.firstRect ?? { left: 0, top: 0, width, height };
  let bytes: Uint8Array;
  if (format === 'gif') {
    const palette =
      fixture.paletteTag === 'reordered palette' ? [0, 0, 255, 255, 0, 0] : [255, 0, 0, 0, 0, 255];
    bytes = new Uint8Array([
      ...fourcc('GIF89a'),
      ...u16(width),
      ...u16(height),
      0x80,
      0,
      0,
      ...palette,
      0x21,
      0xff,
      11,
      ...fourcc('NETSCAPE2.0'),
      3,
      1,
      ...u16(fixture.loops),
      0,
      0x21,
      0xfe,
      1,
      id,
      0, // Unique comment extension before first image.
      0x21,
      0xf9,
      4,
      fixture.firstTransparent ? 1 : 0,
      10,
      0,
      0,
      0,
      0x2c,
      ...u16(rect.left),
      ...u16(rect.top),
      ...u16(rect.width),
      ...u16(rect.height),
      0,
      2,
      2,
      0x44,
      0x01,
      0,
      0x3b,
    ]);
  } else {
    const framePayload = [
      ...u24(rect.left / 2),
      ...u24(rect.top / 2),
      ...u24(rect.width - 1),
      ...u24(rect.height - 1),
      ...u24(100),
      fixture.firstBlend ? 2 : 0,
      ...chunk(fixture.firstCodec ?? 'VP8 ', [id, 0]),
    ];
    const body = [
      ...fourcc('WEBP'),
      ...chunk('VP8X', [2, 0, 0, 0, ...u24(width - 1), ...u24(height - 1)]),
      ...chunk('ANIM', [0, 0, 0, 0, ...u16(fixture.loops)]),
      ...chunk('ANMF', framePayload),
    ];
    bytes = new Uint8Array([...fourcc('RIFF'), ...u32(body.length), ...body]);
  }
  fixtureByBytes.set(bytesKey(bytes), fixture);
  return bytes;
}

function fakeBrowser() {
  const closedImages: number[] = [];
  const closedDecoders: number[] = [];
  class FakeImageDecoder {
    fixture: Fixture;
    tracks: {
      ready: Promise<void>;
      selectedTrack: { frameCount: number; repetitionCount: number };
    };

    constructor(options: { data: Uint8Array }) {
      const fixture = fixtureByBytes.get(bytesKey(options.data));
      if (!fixture) throw new Error('Unknown encoded fixture');
      this.fixture = fixture;
      this.tracks = {
        ready: Promise.resolve(),
        selectedTrack: {
          frameCount: this.fixture.frames.length,
          repetitionCount: this.fixture.loops,
        },
      };
    }

    async decode({ frameIndex }: { frameIndex: number }) {
      const frame = this.fixture.frames[frameIndex];
      if (!frame) throw new Error('Unexpected frame index');
      return {
        complete: true,
        image: {
          displayWidth: frame.width ?? 1,
          displayHeight: frame.height ?? 1,
          duration: frame.duration,
          rgba: frame.rgba,
          close: () => closedImages.push(frameIndex),
        },
      };
    }

    close() {
      closedDecoders.push(1);
    }
  }

  class FakeOffscreenCanvas {
    width: number;
    height: number;
    pixels: number[] = [];

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }

    getContext() {
      return {
        clearRect: () => {
          this.pixels = [];
        },
        drawImage: (image: { rgba: number[] }) => {
          this.pixels = image.rgba;
        },
        getImageData: () => ({ data: new Uint8ClampedArray(this.pixels) }),
      };
    }
  }

  vi.stubGlobal('ImageDecoder', FakeImageDecoder);
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  const page = {
    evaluate: async <T, A>(callback: (argument: A) => Promise<T>, argument: A) =>
      callback(argument),
  } as unknown as Page;
  return { page, closedImages, closedDecoders };
}

afterEach(() => {
  vi.unstubAllGlobals();
  fixtureByBytes.clear();
});

describe('exact animated output comparison', () => {
  it('accepts duplicate-frame merging and different encoded metadata at every presentation boundary', async () => {
    const { page, closedImages, closedDecoders } = fakeBrowser();
    const reference = encode({
      loops: 2,
      paletteTag: 'first palette',
      frames: [
        { rgba: red, duration: 100_000 },
        { rgba: red, duration: 100_000 },
        { rgba: blue, duration: 100_000 },
      ],
    });
    const candidate = encode({
      loops: 2,
      paletteTag: 'reordered palette',
      frames: [
        { rgba: red, duration: 200_000 },
        { rgba: blue, duration: 100_000 },
      ],
    });

    await expect(compareAnimatedOutputExact(page, reference, candidate, 'gif')).resolves.toEqual({
      width: 1,
      height: 1,
      durationUs: 300_000,
      repetitionCount: 2,
      referenceFrameCount: 3,
      candidateFrameCount: 2,
      comparedIntervals: 3,
      loopTransitionChecked: true,
    });
    expect(closedImages).toHaveLength(7);
    expect(closedDecoders).toHaveLength(2);
  });

  it('rejects a pixel difference even when frame timing is identical', async () => {
    const { page, closedImages, closedDecoders } = fakeBrowser();
    const reference = encode(
      {
        loops: 0,
        frames: [
          { rgba: [...red, ...red, ...red, ...red], duration: 100_000, width: 2, height: 2 },
        ],
      },
      'webp'
    );
    const candidate = encode(
      {
        loops: 0,
        frames: [
          {
            rgba: [...red, ...red, ...red, 254, 0, 0, 255],
            duration: 100_000,
            width: 2,
            height: 2,
          },
        ],
      },
      'webp'
    );

    await expect(compareAnimatedOutputExact(page, reference, candidate, 'webp')).rejects.toThrow(
      'pixels differ'
    );
    expect(closedImages).toHaveLength(2);
    expect(closedDecoders).toHaveLength(2);
  });

  it('rejects a shifted scene boundary despite equal total duration', async () => {
    const { page } = fakeBrowser();
    const reference = encode({
      loops: 0,
      frames: [
        { rgba: red, duration: 100_000 },
        { rgba: blue, duration: 100_000 },
      ],
    });
    const candidate = encode({
      loops: 0,
      frames: [
        { rgba: red, duration: 150_000 },
        { rgba: blue, duration: 50_000 },
      ],
    });

    await expect(compareAnimatedOutputExact(page, reference, candidate, 'gif')).rejects.toThrow(
      'pixels differ'
    );
  });

  it('rejects changed loop count and changed total duration', async () => {
    const { page } = fakeBrowser();
    const reference = encode({ loops: 0, frames: [{ rgba: red, duration: 100_000 }] });
    const changedLoop = encode({ loops: 1, frames: [{ rgba: red, duration: 100_000 }] });
    const changedDuration = encode({ loops: 0, frames: [{ rgba: red, duration: 110_000 }] });

    await expect(compareAnimatedOutputExact(page, reference, changedLoop, 'gif')).rejects.toThrow(
      'loop count differs'
    );
    await expect(
      compareAnimatedOutputExact(page, reference, changedDuration, 'gif')
    ).rejects.toThrow('presentation duration differs');
  });

  it('rejects transparency and oversized composited frames within the bounded harness', async () => {
    const { page } = fakeBrowser();
    const reference = encode({ loops: 0, frames: [{ rgba: red, duration: 100_000 }] });
    const transparent = encode({ loops: 0, frames: [{ rgba: [255, 0, 0, 0], duration: 100_000 }] });
    const oversized = encode({
      loops: 0,
      frames: [{ rgba: red, duration: 100_000, width: 1025, height: 1025 }],
    });

    await expect(compareAnimatedOutputExact(page, reference, transparent, 'gif')).rejects.toThrow(
      'non-opaque'
    );
    await expect(compareAnimatedOutputExact(page, reference, oversized, 'gif')).rejects.toThrow(
      'dimensions exceed'
    );
  });

  it('bounds aggregate decoded work even when each frame meets the dimension limit', async () => {
    const { page, closedDecoders } = fakeBrowser();
    const frames = Array.from({ length: 33 }, () => ({
      rgba: red,
      duration: 1_000,
      width: 1024,
      height: 1024,
    }));
    const encoded = encode({ loops: 0, frames });

    await expect(compareAnimatedOutputExact(page, encoded, encoded, 'gif')).rejects.toThrow(
      'decoded work exceeds'
    );
    expect(closedDecoders).toHaveLength(2);
  });

  it.each(['gif', 'webp'] as const)(
    'rejects a partial first %s image even when a decoder reports opaque full-canvas pixels',
    async (format) => {
      const { page, closedDecoders } = fakeBrowser();
      const full = encode(
        {
          loops: 0,
          frames: [
            { rgba: [...red, ...red, ...red, ...red], duration: 100_000, width: 2, height: 2 },
          ],
        },
        format
      );
      const partial = encode(
        {
          loops: 0,
          frames: [
            { rgba: [...red, ...red, ...red, ...red], duration: 100_000, width: 2, height: 2 },
          ],
          firstRect: { left: 0, top: 0, width: 1, height: 2 },
        },
        format
      );

      await expect(compareAnimatedOutputExact(page, full, partial, format)).rejects.toThrow(
        'loop start is unsupported'
      );
      expect(closedDecoders).toHaveLength(0);
    }
  );

  it('rejects GIF transparency and blend-dependent first WebP frames from container metadata', async () => {
    const { page } = fakeBrowser();
    const gif = encode({ loops: 0, frames: [{ rgba: red, duration: 100_000 }] });
    const transparentGif = encode({
      loops: 0,
      frames: [{ rgba: red, duration: 100_000 }],
      firstTransparent: true,
    });
    await expect(compareAnimatedOutputExact(page, gif, transparentGif, 'gif')).rejects.toThrow(
      'loop start is unsupported'
    );

    const webp = encode({ loops: 0, frames: [{ rgba: red, duration: 100_000 }] }, 'webp');
    const losslessBlend = encode(
      {
        loops: 0,
        frames: [{ rgba: red, duration: 100_000 }],
        firstCodec: 'VP8L',
      },
      'webp'
    );
    await expect(compareAnimatedOutputExact(page, webp, losslessBlend, 'webp')).rejects.toThrow(
      'loop start is unsupported'
    );
    const losslessOverwrite = encode(
      {
        loops: 0,
        frames: [{ rgba: red, duration: 100_000 }],
        firstCodec: 'VP8L',
        firstBlend: true,
      },
      'webp'
    );
    await expect(
      compareAnimatedOutputExact(page, webp, losslessOverwrite, 'webp')
    ).resolves.toMatchObject({
      loopTransitionChecked: true,
    });
  });
});
