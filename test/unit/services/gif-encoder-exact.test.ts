// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface SourceFrame {
  startUs: number;
  endUs: number;
  palette: number[][];
  indices: Uint8Array;
}

const mocks = vi.hoisted(() => ({
  frames: [] as SourceFrame[],
  nextPalette: 0,
}));

vi.mock('@services/decoder-service', () => ({
  decodeFrames: vi.fn().mockImplementation(async (_demux, options) => {
    for (const [number, frame] of mocks.frames.entries()) {
      await options.onFrameAvailable(
        new Uint8Array(frame.indices.length * 4),
        (frame.endUs - frame.startUs) / 1000,
        number,
        undefined,
        { startUs: frame.startUs, endUs: frame.endUs }
      );
    }
    const endUs = mocks.frames.at(-1)?.endUs ?? 0;
    return {
      frames: [],
      outputTotalMs: endUs / 1000,
      skippedByDecimation: 0,
      smartSkipped: 0,
      sourceTotalMs: endUs / 1000,
      presentationEndUs: endUs,
      tailAccumulatedMs: 0,
      totalInputFrames: mocks.frames.length,
    };
  }),
}));

vi.mock('@services/dynamic-decimation-controller', () => ({
  createDynamicDecimationController: () => ({
    getSkipCount: () => 0,
    shouldSkip: () => false,
  }),
}));

vi.mock('gifenc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gifenc')>();
  return {
    ...actual,
    quantize: () => mocks.frames[mocks.nextPalette++]!.palette,
    applyPalette: () => mocks.frames[mocks.nextPalette - 1]!.indices.slice(),
  };
});

import { encodeGif } from '@services/gif-encoder-service';
import { GIFEncoder } from 'gifenc';

interface DecodedGifFrame {
  colors: number[];
  delayCs: number;
  hasLocalTable: boolean;
  lzwMinCodeSize: number;
  clearCodes: number;
}

function decodeLzw(data: number[], minCodeSize: number, pixelCount: number): {
  indices: number[];
  clearCodes: number;
} {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const dictionary: number[][] = [];
  let nextCode = endCode + 1;
  let codeSize = minCodeSize + 1;
  let bitOffset = 0;
  let previous: number[] | null = null;
  let clearCodes = 0;
  const indices: number[] = [];
  const reset = () => {
    dictionary.length = clearCode;
    for (let color = 0; color < clearCode; color++) dictionary[color] = [color];
    nextCode = endCode + 1;
    codeSize = minCodeSize + 1;
    previous = null;
  };
  reset();
  while (bitOffset + codeSize <= data.length * 8) {
    let code = 0;
    for (let bit = 0; bit < codeSize; bit++) {
      code |= ((data[(bitOffset + bit) >> 3]! >> ((bitOffset + bit) & 7)) & 1) << bit;
    }
    bitOffset += codeSize;
    if (code === clearCode) {
      clearCodes++;
      reset();
      continue;
    }
    if (code === endCode) break;
    const entry: number[] | undefined =
      code < nextCode
        ? dictionary[code]
        : code === nextCode && previous
          ? [...previous, previous[0]!]
          : undefined;
    if (!entry) throw new Error(`Invalid GIF LZW code ${code}`);
    indices.push(...entry);
    if (previous && nextCode < 4096) {
      dictionary[nextCode++] = [...previous, entry[0]!];
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize++;
    }
    previous = entry;
  }
  if (indices.length !== pixelCount) {
    throw new Error(`GIF LZW yielded ${indices.length} pixels, expected ${pixelCount}`);
  }
  return { indices, clearCodes };
}

function readGif(bytes: Uint8Array): { frames: DecodedGifFrame[]; globalColors: number } {
  expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe('GIF89a');
  const width = bytes[6]! | (bytes[7]! << 8);
  const height = bytes[8]! | (bytes[9]! << 8);
  const globalColors = 1 << ((bytes[10]! & 7) + 1);
  let offset = 13;
  const readTable = (count: number): number[] => {
    const colors: number[] = [];
    for (let color = 0; color < count; color++) {
      colors.push((bytes[offset++]! << 16) | (bytes[offset++]! << 8) | bytes[offset++]!);
    }
    return colors;
  };
  const globalTable = readTable(globalColors);
  const frames: DecodedGifFrame[] = [];
  let delayCs = 0;
  while (offset < bytes.length) {
    const marker = bytes[offset++]!;
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = bytes[offset++]!;
      if (label === 0xf9) {
        expect(bytes[offset++]!).toBe(4);
        offset++; // packed fields
        delayCs = bytes[offset++]! | (bytes[offset++]! << 8);
        offset += 2; // transparent index and terminator
      } else {
        while (true) {
          const length = bytes[offset++]!;
          if (length === 0) break;
          offset += length;
        }
      }
      continue;
    }
    if (marker !== 0x2c) throw new Error(`Unexpected GIF block ${marker}`);
    const left = bytes[offset++]! | (bytes[offset++]! << 8);
    const top = bytes[offset++]! | (bytes[offset++]! << 8);
    const frameWidth = bytes[offset++]! | (bytes[offset++]! << 8);
    const frameHeight = bytes[offset++]! | (bytes[offset++]! << 8);
    expect([left, top, frameWidth, frameHeight]).toEqual([0, 0, width, height]);
    const packed = bytes[offset++]!;
    const hasLocalTable = (packed & 0x80) !== 0;
    const palette = hasLocalTable ? readTable(1 << ((packed & 7) + 1)) : globalTable;
    const lzwMinCodeSize = bytes[offset++]!;
    const data: number[] = [];
    while (true) {
      const length = bytes[offset++]!;
      if (length === 0) break;
      for (let byte = 0; byte < length; byte++) data.push(bytes[offset++]!);
    }
    const decoded = decodeLzw(data, lzwMinCodeSize, width * height);
    frames.push({
      colors: decoded.indices.map((index) => palette[index]!),
      delayCs,
      hasLocalTable,
      lzwMinCodeSize,
      clearCodes: decoded.clearCodes,
    });
  }
  return { frames, globalColors };
}

async function encodeFrames(
  width: number,
  height: number,
  quality: 'low' | 'high' = 'low',
  memoryLimit?: number
) {
  return encodeGif(
    {
      chunks: [],
      config: { codec: 'vp09.00.10.08', codedWidth: width, codedHeight: height },
      duration: (mocks.frames.at(-1)?.endUs ?? 0) / 1_000_000,
      framerate: 10,
      sourceTotalMs: (mocks.frames.at(-1)?.endUs ?? 0) / 1000,
      totalFrames: mocks.frames.length,
    },
    {
      width,
      height,
      quality,
      scale: 1,
      assertAdditionalMemoryBytes: memoryLimit
        ? (bytes) => {
            if (bytes > memoryLimit) throw new Error('aggregate memory limit exceeded');
          }
        : undefined,
    }
  );
}

beforeEach(() => {
  mocks.frames = [];
  mocks.nextPalette = 0;
});

describe('GIF exact indexed representation', () => {
  it.each([64, 128, 256])('compacts a sparse %i-color table to its two used colors', async (size) => {
    const palette = Array.from({ length: size }, (_, index) => [index, 0, 255 - index]);
    const indices = Uint8Array.from({ length: 64 }, (_, pixel) => (pixel & 1 ? size - 1 : 0));
    mocks.frames = [{ startUs: 0, endUs: 100_000, palette, indices }];

    const optimizedBytes = await encodeFrames(8, 8, 'high');
    const output = readGif(optimizedBytes);
    const originalWriter = GIFEncoder({ auto: true });
    originalWriter.writeFrame(indices, 8, 8, { palette, delay: 100 });
    originalWriter.finish();
    const originalBytes = originalWriter.bytes();

    expect(output.globalColors).toBe(2);
    expect(output.frames[0]?.lzwMinCodeSize).toBe(2);
    expect(output.frames[0]?.colors).toEqual(
      Array.from(indices, (index) =>
        (palette[index]![0]! << 16) | (palette[index]![1]! << 8) | palette[index]![2]!
      )
    );
    expect(output.frames[0]?.colors).toEqual(readGif(originalBytes).frames[0]?.colors);
    expect(optimizedBytes.byteLength).toBeLessThan(originalBytes.byteLength);
  });

  it.each([2, 4, 16])('uses the necessary LZW width for %i distinct colors', async (size) => {
    const palette = Array.from({ length: size }, (_, color) => [color, 255 - color, color]);
    const indices = Uint8Array.from({ length: 64 }, (_, pixel) => pixel % size);
    mocks.frames = [{ startUs: 0, endUs: 100_000, palette, indices }];

    const output = readGif(await encodeFrames(8, 8));

    expect(output.globalColors).toBe(size);
    expect(output.frames[0]?.lzwMinCodeSize).toBe(Math.max(2, Math.log2(size)));
    expect(output.frames[0]?.colors).toEqual(
      Array.from(indices, (index) =>
        (palette[index]![0]! << 16) | (palette[index]![1]! << 8) | palette[index]![2]!
      )
    );
  });

  it('retains all 256 colors and decodes across LZW dictionary resets', async () => {
    const width = 256;
    const height = 80;
    const palette = Array.from({ length: 256 }, (_, color) => [color, color ^ 0x55, 255 - color]);
    let random = 0x12345678;
    const indices = Uint8Array.from({ length: width * height }, () => {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      return random & 255;
    });
    mocks.frames = [{ startUs: 0, endUs: 100_000, palette, indices }];

    const output = readGif(await encodeFrames(width, height, 'high'));

    expect(output.globalColors).toBe(256);
    expect(output.frames[0]?.lzwMinCodeSize).toBe(8);
    expect(output.frames[0]?.clearCodes).toBeGreaterThan(1);
    expect(output.frames[0]?.colors).toEqual(
      Array.from(indices, (index) =>
        (palette[index]![0]! << 16) | (palette[index]![1]! << 8) | palette[index]![2]!
      )
    );
  });

  it('merges adjacent frames only when every expanded RGB pixel matches', async () => {
    const red = [255, 0, 0];
    const blue = [0, 0, 255];
    mocks.frames = [
      {
        startUs: 0,
        endUs: 100_000,
        palette: [red, blue],
        indices: Uint8Array.from([0, 1]),
      },
      {
        startUs: 100_000,
        endUs: 200_000,
        palette: [blue, red, red, [4, 4, 4]],
        indices: Uint8Array.from([1, 0]),
      },
      {
        startUs: 200_000,
        endUs: 300_000,
        palette: [blue, red],
        indices: Uint8Array.from([0, 1]),
      },
    ];

    const output = readGif(await encodeFrames(2, 1));

    expect(output.frames).toHaveLength(2);
    expect(output.frames.map((frame) => frame.delayCs)).toEqual([20, 10]);
    expect(output.frames.map((frame) => frame.colors)).toEqual([
      [0xff0000, 0x0000ff],
      [0x0000ff, 0xff0000],
    ]);
  });

  it('omits a local table only when a same-depth global mapping preserves all colors', async () => {
    mocks.frames = [
      {
        startUs: 0,
        endUs: 100_000,
        palette: [[255, 0, 0], [0, 0, 255]],
        indices: Uint8Array.from([0, 1]),
      },
      {
        startUs: 100_000,
        endUs: 200_000,
        palette: [[0, 0, 255], [255, 0, 0], [9, 9, 9]],
        indices: Uint8Array.from([0, 1]),
      },
      {
        startUs: 200_000,
        endUs: 300_000,
        palette: [[0, 255, 0], [0, 0, 255]],
        indices: Uint8Array.from([0, 1]),
      },
    ];

    const output = readGif(await encodeFrames(2, 1));

    expect(output.frames.map((frame) => frame.hasLocalTable)).toEqual([false, false, true]);
    expect(output.frames.map((frame) => frame.colors)).toEqual([
      [0xff0000, 0x0000ff],
      [0x0000ff, 0xff0000],
      [0x00ff00, 0x0000ff],
    ]);
  });

  it('retains the smaller local LZW width when the global table needs more symbols', async () => {
    const palette = Array.from({ length: 8 }, (_, color) => [color * 30, 0, color]);
    mocks.frames = [
      {
        startUs: 0,
        endUs: 100_000,
        palette,
        indices: Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
      },
      {
        startUs: 100_000,
        endUs: 200_000,
        palette: [palette[7]!, palette[0]!],
        indices: Uint8Array.from([0, 1, 0, 1, 0, 1, 0, 1]),
      },
    ];

    const output = readGif(await encodeFrames(8, 1));

    expect(output.frames.map((frame) => frame.hasLocalTable)).toEqual([false, true]);
    expect(output.frames.map((frame) => frame.lzwMinCodeSize)).toEqual([3, 2]);
    expect(output.frames[1]?.colors).toEqual([
      0xd20007, 0, 0xd20007, 0, 0xd20007, 0, 0xd20007, 0,
    ]);
  });

  it('keeps a prior local table on each split when the global table lacks its colors', async () => {
    mocks.frames = [
      {
        startUs: 0,
        endUs: 100_000,
        palette: [[255, 0, 0], [0, 0, 255]],
        indices: Uint8Array.from([0, 1]),
      },
      {
        startUs: 100_000,
        endUs: 5_100_000,
        palette: [[0, 255, 0], [0, 0, 255]],
        indices: Uint8Array.from([0, 1]),
      },
    ];

    const output = readGif(await encodeFrames(2, 1));

    expect(output.frames.map((frame) => frame.hasLocalTable)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(output.frames.map((frame) => frame.delayCs)).toEqual([10, 200, 200, 100]);
    expect(output.frames.slice(1).map((frame) => frame.colors)).toEqual([
      [0x00ff00, 0x0000ff],
      [0x00ff00, 0x0000ff],
      [0x00ff00, 0x0000ff],
    ]);
  });

  it('falls back to one live index when the second index exceeds the memory guard', async () => {
    mocks.frames = [
      {
        startUs: 0,
        endUs: 100_000,
        palette: [[255, 0, 0]],
        indices: Uint8Array.from([0]),
      },
      {
        startUs: 100_000,
        endUs: 200_000,
        palette: [[0, 0, 255]],
        indices: Uint8Array.from([0]),
      },
    ];

    const output = readGif(await encodeFrames(1, 1, 'low', 20_000));

    expect(output.frames.map((frame) => frame.colors)).toEqual([[0xff0000], [0x0000ff]]);
    expect(output.frames.map((frame) => frame.delayCs)).toEqual([10, 10]);
  });
});
