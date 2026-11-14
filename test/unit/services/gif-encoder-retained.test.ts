// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

type FixtureFrame = { startUs: number; endUs: number; rgba: Uint8Array };
const fixture = vi.hoisted(() => ({
  frames: [] as FixtureFrame[],
  forceJsIndexes: false,
  admitted: [] as boolean[],
  mapped: 0,
}));

vi.mock('@services/decoder-service', () => ({
  decodeFrames: async (
    _demux: unknown,
    options: {
      onFrameAvailable: (
        rgba: Uint8Array,
        durationMs: number,
        frameNumber: number,
        handoff: undefined,
        presentation: { startUs: number; endUs: number }
      ) => Promise<void>;
    }
  ) => {
    for (const [index, frame] of fixture.frames.entries()) {
      await options.onFrameAvailable(
        frame.rgba.slice(),
        (frame.endUs - frame.startUs) / 1000,
        index + 1,
        undefined,
        { startUs: frame.startUs, endUs: frame.endUs }
      );
    }
    const endUs = fixture.frames.at(-1)!.endUs;
    return {
      totalInputFrames: fixture.frames.length,
      skippedByDecimation: 0,
      smartSkipped: 0,
      sourceTotalMs: endUs / 1000,
      presentationEndUs: endUs,
      consumedChunks: fixture.frames.length,
      decodedFrames: fixture.frames.length,
      selectedFrames: fixture.frames.length,
    };
  },
}));

vi.mock('@services/dynamic-decimation-controller', () => ({
  createDynamicDecimationController: () => ({
    getSkipCount: () => 0,
    shouldSkip: () => false,
  }),
}));

vi.mock('@services/gif-scalar-wasm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@services/gif-scalar-wasm')>();
  return {
    ...actual,
    createGifScalarQuantizer: async (
      ...args: Parameters<typeof actual.createGifScalarQuantizer>
    ) => {
      const quantizer = await actual.createGifScalarQuantizer(...args);
      const enable = quantizer.enableRetained;
      const map = quantizer.mapRetained;
      quantizer.enableRetained = (pixels) => {
        const admitted = fixture.forceJsIndexes ? false : enable(pixels);
        fixture.admitted.push(admitted);
        return admitted;
      };
      quantizer.mapRetained = (rgba, colors) => {
        fixture.mapped++;
        return map(rgba, colors);
      };
      return quantizer;
    },
  };
});

import { globalBufferPool } from '@services/buffer-pool';
import { encodeGif } from '@services/gif-encoder-service';

const wasmUrl = new URL('../../../src/services/gif-scalar-quantizer.wasm', import.meta.url);
const wasmBytes = readFileSync(wasmUrl);

function solid(
  width: number,
  height: number,
  color: readonly [number, number, number]
): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    rgba.set([...color, 255], pixel * 4);
  }
  return rgba;
}

function alternating(colors: readonly (readonly [number, number, number])[]): Uint8Array {
  const rgba = new Uint8Array(colors.length * 4);
  colors.forEach((color, pixel) => rgba.set([...color, 255], pixel * 4));
  return rgba;
}

function gifFrames(bytes: Uint8Array): Array<{ delayCs: number; localTable: boolean }> {
  expect(String.fromCharCode(...bytes.subarray(0, 6))).toBe('GIF89a');
  const frames: Array<{ delayCs: number; localTable: boolean }> = [];
  let offset = 13;
  const screenPacked = bytes[10]!;
  if (screenPacked & 0x80) offset += 3 * (1 << ((screenPacked & 7) + 1));
  let delayCs = 0;
  const skipBlocks = () => {
    while (true) {
      const count = bytes[offset++]!;
      if (count === 0) break;
      offset += count;
      expect(offset).toBeLessThanOrEqual(bytes.length);
    }
  };
  while (offset < bytes.length && bytes[offset] !== 0x3b) {
    if (bytes[offset] === 0x21) {
      if (bytes[offset + 1] === 0xf9) {
        expect(bytes[offset + 2]).toBe(4);
        delayCs = bytes[offset + 4]! | (bytes[offset + 5]! << 8);
        offset += 8;
      } else {
        offset += 2;
        const size = bytes[offset++]!;
        offset += size;
        skipBlocks();
      }
    } else if (bytes[offset] === 0x2c) {
      const packed = bytes[offset + 9]!;
      const localTable = (packed & 0x80) !== 0;
      offset += 10;
      if (localTable) offset += 3 * (1 << ((packed & 7) + 1));
      offset++;
      skipBlocks();
      frames.push({ delayCs, localTable });
      delayCs = 0;
    } else {
      throw new Error(`Unexpected GIF block at ${offset}`);
    }
  }
  expect(bytes[offset]).toBe(0x3b);
  return frames;
}

async function encodeFixture(
  frames: FixtureFrame[],
  width: number,
  height: number,
  quality: 'low' | 'medium' | 'high',
  forceJsIndexes: boolean
) {
  fixture.frames = frames;
  fixture.forceJsIndexes = forceJsIndexes;
  fixture.admitted = [];
  fixture.mapped = 0;
  const operations: string[] = [];
  const endUs = frames.at(-1)!.endUs;
  const output = await encodeGif(
    {
      chunks: [],
      config: { codec: 'vp09.00.10.08', codedWidth: width, codedHeight: height },
      duration: endUs / 1_000_000,
      framerate: 10,
      sourceTotalMs: endUs / 1000,
      totalFrames: frames.length,
    },
    {
      width,
      height,
      quality,
      scale: 1,
      profileOperation: (name) => operations.push(name),
    }
  );
  expect(fixture.admitted).toEqual([!forceJsIndexes]);
  expect(fixture.mapped).toBe(forceJsIndexes ? 0 : frames.length);
  expect(operations.filter((name) => name === 'gifPaletteMapping')).toHaveLength(frames.length);
  expect(operations.filter((name) => name === 'gifRetainedIndexMapping')).toHaveLength(
    forceJsIndexes ? 0 : frames.length
  );
  const parsed = gifFrames(output);
  expect(operations.filter((name) => name === 'gifRetainedFrameWrite')).toHaveLength(
    forceJsIndexes ? 0 : parsed.length
  );
  return { output, parsed };
}

afterEach(() => {
  vi.unstubAllGlobals();
  globalBufferPool.clear();
});

describe('real retained GIF service route', () => {
  const red = [255, 0, 0] as const;
  const blue = [0, 0, 255] as const;
  const green = [0, 255, 0] as const;
  const frame = (startUs: number, endUs: number, rgba: Uint8Array): FixtureFrame => ({
    startUs,
    endUs,
    rgba,
  });
  const cases = [
    {
      name: 'pending low',
      quality: 'low' as const,
      width: 2,
      height: 1,
      frames: [
        frame(0, 100_000, alternating([red, blue])),
        frame(100_000, 200_000, alternating([green, blue])),
      ],
      delays: [10, 10],
    },
    {
      name: 'pending medium',
      quality: 'medium' as const,
      width: 8,
      height: 8,
      frames: [frame(0, 100_000, solid(8, 8, red)), frame(100_000, 200_000, solid(8, 8, blue))],
      delays: [10, 10],
    },
    {
      name: 'pending high',
      quality: 'high' as const,
      width: 8,
      height: 8,
      frames: [frame(0, 100_000, solid(8, 8, red)), frame(100_000, 200_000, solid(8, 8, blue))],
      delays: [10, 10],
    },
    {
      name: 'exact duplicate',
      quality: 'low' as const,
      width: 2,
      height: 1,
      frames: [
        frame(0, 100_000, alternating([red, blue])),
        frame(100_000, 200_000, alternating([red, blue])),
      ],
      delays: [20],
    },
    {
      name: 'short terminal scene',
      quality: 'low' as const,
      width: 2,
      height: 1,
      frames: [
        frame(0, 105_000, alternating([red, blue])),
        frame(105_000, 106_000, alternating([blue, red])),
      ],
      delays: [11],
    },
    {
      name: 'deferred predecessor resolved',
      quality: 'low' as const,
      width: 2,
      height: 1,
      frames: [
        frame(0, 105_000, alternating([red, blue])),
        frame(105_000, 106_000, alternating([blue, red])),
        frame(200_000, 300_000, alternating([green, red])),
      ],
      delays: [11, 9, 10],
    },
    {
      name: 'global palette remap',
      quality: 'low' as const,
      width: 2,
      height: 1,
      frames: [
        frame(0, 100_000, alternating([red, blue])),
        frame(100_000, 200_000, alternating([blue, red])),
      ],
      delays: [10, 10],
      localTables: [false, false],
    },
    {
      name: 'viewer-safe delay split',
      quality: 'low' as const,
      width: 2,
      height: 1,
      frames: [frame(0, 4_010_000, alternating([red, blue]))],
      delays: [200, 199, 2],
    },
  ];

  for (const scenario of cases) {
    it(`matches complete JS-index bytes and timing for ${scenario.name}`, async () => {
      vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        expect(input).toBe(wasmUrl.href);
        return new Response(wasmBytes, {
          status: 200,
          headers: { 'content-type': 'application/wasm' },
        });
      });
      const retained = await encodeFixture(
        scenario.frames,
        scenario.width,
        scenario.height,
        scenario.quality,
        false
      );
      const fallback = await encodeFixture(
        scenario.frames,
        scenario.width,
        scenario.height,
        scenario.quality,
        true
      );
      expect(retained.output).toEqual(fallback.output);
      expect(retained.parsed.map((result) => result.delayCs)).toEqual(scenario.delays);
      if ('localTables' in scenario) {
        expect(retained.parsed.map((result) => result.localTable)).toEqual(scenario.localTables);
      }
    });
  }
});
