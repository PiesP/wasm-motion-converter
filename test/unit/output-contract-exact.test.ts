// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
}

const red = [255, 0, 0, 255];
const blue = [0, 0, 255, 255];
const encode = (fixture: Fixture) => new TextEncoder().encode(JSON.stringify(fixture));

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
      this.fixture = JSON.parse(new TextDecoder().decode(options.data)) as Fixture;
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

afterEach(() => vi.unstubAllGlobals());

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
    const reference = encode({
      loops: 0,
      frames: [{ rgba: [...red, ...red, ...red, ...red], duration: 100_000, width: 2, height: 2 }],
    });
    const candidate = encode({
      loops: 0,
      frames: [
        { rgba: [...red, ...red, ...red, 254, 0, 0, 255], duration: 100_000, width: 2, height: 2 },
      ],
    });

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
});
