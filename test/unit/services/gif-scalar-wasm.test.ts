// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { readFileSync } from 'node:fs';

import {
  createGifScalarQuantizer,
  GifScalarLoadError,
  GifScalarMemoryError,
} from '@services/gif-scalar-wasm';
import {
  applyPalette as referenceApplyPalette,
  GIFEncoder as referenceGifEncoder,
  quantize as referenceQuantize,
} from 'gifenc';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const wasmPath = new URL('../../../src/services/gif-scalar-quantizer.wasm', import.meta.url);
const wasmBytes = readFileSync(wasmPath);

function rgba(colors: Array<[number, number, number, number]>): Uint8Array {
  return Uint8Array.from(colors.flat());
}

function reference(input: Uint8Array, colors: number): number[][] {
  return referenceQuantize(input, colors, { format: 'rgb565' });
}

function instantiate(): {
  memory: WebAssembly.Memory;
  input_ptr(): number;
  reserve_input(length: number): number;
  palette_ptr(): number;
  quantize(length: number, colors: number): number;
  indices_ptr(): number;
  map_palette(length: number, colors: number): number;
  lzw_bound(pixels: number): number;
  lzw_output_ptr(): number;
  lzw_encode(pixels: number, depth: number, capacity: number): number;
} {
  const module = new WebAssembly.Module(wasmBytes);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  return new WebAssembly.Instance(module, {}).exports as ReturnType<typeof instantiate>;
}

function runMapped(input: Uint8Array, palette: number[][], wasm = instantiate()): Uint8Array {
  const pointer = wasm.input_ptr();
  const end = pointer + input.byteLength;
  if (end > wasm.memory.buffer.byteLength) {
    wasm.memory.grow(Math.ceil((end - wasm.memory.buffer.byteLength) / 65_536));
  }
  expect(wasm.reserve_input(input.byteLength)).toBe(0);
  new Uint8Array(wasm.memory.buffer, pointer, input.byteLength).set(input);
  const paletteBytes = new Uint8Array(wasm.memory.buffer, wasm.palette_ptr(), palette.length * 3);
  paletteBytes.set(palette.flat());
  expect(wasm.map_palette(input.byteLength, palette.length)).toBe(input.byteLength / 4);
  return new Uint8Array(wasm.memory.buffer, wasm.indices_ptr(), input.byteLength / 4).slice();
}

function referenceImageData(indices: Uint8Array, depth: number): Uint8Array {
  const palette = Array.from({ length: 1 << depth }, (_, index) => [index, index, index]);
  const encoder = referenceGifEncoder({ auto: true });
  encoder.writeFrame(indices, indices.length, 1, {
    palette,
    colorDepth: depth,
    repeat: 0,
    delay: 20,
  });
  encoder.finish();
  // GIF89a + screen descriptor + global table + NETSCAPE + GCE + image descriptor.
  const imageDataOffset = 6 + 7 + palette.length * 3 + 19 + 8 + 10;
  return encoder.bytes().subarray(imageDataOffset, -1);
}

function runLzw(indices: Uint8Array, depth: number, wasm = instantiate()): Uint8Array {
  const inputBytes = indices.byteLength * 4;
  const minimum = wasm.input_ptr() + inputBytes;
  if (minimum > wasm.memory.buffer.byteLength) {
    wasm.memory.grow(Math.ceil((minimum - wasm.memory.buffer.byteLength) / 65_536));
  }
  expect(wasm.reserve_input(inputBytes)).toBe(0);
  new Uint8Array(wasm.memory.buffer, wasm.indices_ptr(), indices.byteLength).set(indices);
  const bound = wasm.lzw_bound(indices.byteLength);
  expect(bound).toBeGreaterThan(0);
  const end = wasm.lzw_output_ptr() + bound;
  if (end > wasm.memory.buffer.byteLength) {
    wasm.memory.grow(Math.ceil((end - wasm.memory.buffer.byteLength) / 65_536));
  }
  const length = wasm.lzw_encode(indices.byteLength, depth, bound);
  expect(length).toBeGreaterThan(0);
  expect(length).toBeLessThanOrEqual(bound);
  return new Uint8Array(wasm.memory.buffer, wasm.lzw_output_ptr(), length).slice();
}

function runCompiled(input: Uint8Array, colors: number, wasm = instantiate()): number[][] {
  const start = wasm.input_ptr();
  const required = start + input.byteLength;
  const before = wasm.memory.buffer.byteLength;
  if (required > before) wasm.memory.grow(Math.ceil((required - before) / 65_536));
  expect(wasm.reserve_input(input.byteLength)).toBe(0);
  new Uint8Array(wasm.memory.buffer, start, input.byteLength).set(input);
  const capacity = wasm.memory.buffer.byteLength;
  const count = wasm.quantize(input.byteLength, colors);
  expect(count).toBeGreaterThan(0);
  expect(wasm.memory.buffer.byteLength).toBe(capacity);
  const output = new Uint8Array(wasm.memory.buffer, wasm.palette_ptr(), count * 3);
  return Array.from({ length: count }, (_, index) =>
    Array.from(output.subarray(index * 3, index * 3 + 3))
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('compiled scalar WASM and gifenc 1.0.3', () => {
  it('maps RGB565 using the first pixel per key, the green mask, and last-index distance ties', () => {
    const palette = [
      [0, 0, 0],
      [8, 0, 0],
      [0, 8, 0],
      [8, 8, 0],
    ];
    const cases = [
      rgba([
        [0, 0, 0, 0],
        [7, 0, 0, 255],
        [0, 3, 0, 255],
        [0, 4, 0, 255],
        [8, 8, 0, 255],
      ]),
      rgba([
        [4, 4, 0, 255],
        [0, 7, 0, 255],
        [0, 0, 0, 255],
        [8, 0, 0, 255],
      ]),
    ];
    const wasm = instantiate();
    for (const input of cases) {
      expect(runMapped(input, palette, wasm)).toEqual(
        referenceApplyPalette(input, palette, 'rgb565')
      );
    }
    const firstSeven = rgba([
      [7, 0, 0, 255],
      [0, 0, 0, 255],
    ]);
    expect(runMapped(firstSeven, palette, wasm)).toEqual(
      referenceApplyPalette(firstSeven, palette, 'rgb565')
    );
    expect([...runMapped(firstSeven, palette, wasm)]).toEqual([1, 1]);
  });

  it('matches indexed pixels after the compiled quantizer and resets between repeated frames', () => {
    const wasm = instantiate();
    for (const colors of [64, 128, 256]) {
      const input = rgba(
        Array.from({ length: 129 }, (_, index) => [
          (index * 13) & 255,
          (index * 31) & 255,
          (index * 47) & 255,
          index & 255,
        ])
      );
      const palette = runCompiled(input, colors, wasm);
      // runCompiled has copied the input into the same conversion-owned module.
      const mapped = new Uint8Array(wasm.memory.buffer, wasm.indices_ptr(), input.length / 4);
      expect(wasm.map_palette(input.length, palette.length)).toBe(input.length / 4);
      expect(mapped.slice()).toEqual(referenceApplyPalette(input, palette, 'rgb565'));
      expect(
        runMapped(
          rgba([[255, 0, 0, 255]]),
          [
            [0, 0, 0],
            [255, 0, 0],
          ],
          wasm
        )
      ).toEqual(Uint8Array.of(1));
    }
  });

  it('matches gifenc LZW image blocks at code-width, dictionary-reset and 254-byte boundaries', () => {
    const sizes = [1, 2, 13, 254, 255, 256, 1023, 8192, 32768];
    const wasm = instantiate();
    for (const size of sizes) {
      let seed = size ^ 0x6ac14239;
      const indices = Uint8Array.from({ length: size }, () => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return seed & 255;
      });
      expect(runLzw(indices, 8, wasm)).toEqual(referenceImageData(indices, 8));
    }
    for (const depth of [2, 3, 4, 6, 7]) {
      const indices = Uint8Array.from({ length: 1025 }, (_, index) => index & ((1 << depth) - 1));
      expect(runLzw(indices, depth, wasm)).toEqual(referenceImageData(indices, depth));
    }
  });

  it('matches complete quantize/map/compress cycles for all presets and structured inputs', () => {
    const wasm = instantiate();
    for (const [width, height] of [
      [1, 1],
      [3, 5],
      [65, 33],
      [1920, 1080],
    ]) {
      for (const kind of width === 1920 ? ['flat'] : ['flat', 'text', 'gradient', 'noise']) {
        let seed = 0x12345678;
        const input = new Uint8Array(width! * height! * 4);
        for (let pixel = 0; pixel < input.length / 4; pixel++) {
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          const x = pixel % width!;
          const value =
            kind === 'flat'
              ? 79
              : kind === 'text'
                ? x % 5 < 2
                  ? 0
                  : 255
                : kind === 'gradient'
                  ? Math.floor((x * 255) / width!)
                  : seed & 255;
          input.set(
            [
              value,
              kind === 'noise' ? (seed >>> 8) & 255 : value,
              kind === 'noise' ? (seed >>> 16) & 255 : value,
              255,
            ],
            pixel * 4
          );
        }
        for (const colors of [64, 128, 256]) {
          const palette = runCompiled(input, colors, wasm);
          expect(palette).toEqual(reference(input, colors));
          expect(wasm.map_palette(input.length, palette.length)).toBe(input.length / 4);
          const indices = new Uint8Array(
            wasm.memory.buffer,
            wasm.indices_ptr(),
            input.length / 4
          ).slice();
          expect(indices).toEqual(referenceApplyPalette(input, palette, 'rgb565'));
          expect(wasm.map_palette(input.length, palette.length)).toBe(-1);
          expect(wasm.quantize(input.length, colors)).toBe(-1);
          expect(runLzw(indices, 8, wasm)).toEqual(referenceImageData(indices, 8));
        }
      }
    }
  });

  it('rejects invalid indices and insufficient output without crossing the admitted extent', () => {
    const wasm = instantiate();
    expect(wasm.reserve_input(16)).toBe(0);
    const indices = new Uint8Array(wasm.memory.buffer, wasm.indices_ptr(), 4);
    indices.set([0, 1, 2, 4]);
    const pointer = wasm.lzw_output_ptr();
    const output = new Uint8Array(wasm.memory.buffer, pointer, 64);
    output.fill(0xa5);
    expect(wasm.lzw_encode(4, 2, 64)).toBe(-1);
    expect([...output]).toEqual(Array.from({ length: 64 }, () => 0xa5));
    indices[3] = 3;
    expect(wasm.lzw_encode(4, 2, 1)).toBe(-2);
    expect([...output.subarray(1)]).toEqual(Array.from({ length: 63 }, () => 0xa5));
    expect(wasm.lzw_encode(4, 2, wasm.memory.buffer.byteLength)).toBe(-2);
    expect(wasm.lzw_bound(0xffff_ffff)).toBe(0);
  });

  it('rejects malformed mapping and bounded LZW requests before writing output', () => {
    const wasm = instantiate();
    expect(wasm.map_palette(4, 1)).toBe(-1);
    expect(wasm.lzw_encode(1, 2, 64)).toBe(-1);
    expect(wasm.lzw_bound(0)).toBe(0);
    const input = rgba([[255, 0, 0, 255]]);
    expect(runMapped(input, [[255, 0, 0]], wasm)).toEqual(Uint8Array.of(0));
    expect(wasm.map_palette(input.length, 257)).toBe(-1);
    expect(wasm.lzw_encode(1, 1, 64)).toBe(-1);
    expect(wasm.lzw_encode(1, 2, 0)).toBe(-1);
  });
  it('rounds positive half ties as Math.round after both bin means and merges', () => {
    const withinBin = rgba([
      [4, 4, 4, 255],
      [5, 5, 5, 0],
    ]);
    expect(reference(withinBin, 1)).toEqual([[5, 5, 5]]);
    expect(runCompiled(withinBin, 1)).toEqual([[5, 5, 5]]);

    const mergedBins = rgba([
      [127, 0, 0, 255],
      [128, 0, 0, 255],
    ]);
    expect(reference(mergedBins, 1)).toEqual([[128, 0, 0]]);
    expect(runCompiled(mergedBins, 1)).toEqual([[128, 0, 0]]);
  });

  it('matches ordered palettes across first-bin, alpha, green-mask, ties and sqrt branches', () => {
    const cases: Array<[Uint8Array, number]> = [
      [
        rgba([
          [0, 0, 0, 0],
          [0, 0, 0, 255],
        ]),
        256,
      ],
      [
        rgba([
          [0, 1, 0, 255],
          [0, 2, 0, 255],
          [0, 3, 0, 255],
        ]),
        1,
      ],
      [
        rgba([
          [4, 4, 4, 255],
          [5, 5, 5, 0],
          [6, 6, 6, 255],
          [7, 7, 7, 255],
        ]),
        2,
      ],
      [
        rgba([
          [0, 0, 0, 255],
          [8, 0, 0, 255],
          [0, 4, 0, 255],
          [8, 4, 0, 255],
        ]),
        2,
      ],
      [rgba(Array.from({ length: 128 }, (_, index) => [index * 2, index, index ^ 63, 255])), 1],
    ];
    for (const [input, colors] of cases) {
      expect(runCompiled(input, colors)).toEqual(reference(input, colors));
    }
  });

  it('matches repeated-frame and supported larger-frame input without a 720px ceiling', () => {
    const wasm = instantiate();
    const input = new Uint8Array(1920 * 1080 * 4);
    for (let index = 0; index < input.length; index += 4) {
      input[index] = (index / 4) & 255;
      input[index + 1] = 79;
      input[index + 2] = 173;
      input[index + 3] = 255;
    }
    expect(runCompiled(input, 64, wasm)).toEqual(reference(input, 64));
    const next = rgba([
      [0, 255, 0, 255],
      [255, 0, 255, 0],
      [0, 0, 0, 255],
    ]);
    expect(runCompiled(next, 2, wasm)).toEqual(reference(next, 2));
  });

  it('rejects unreserved and malformed input with distinct ABI codes', () => {
    const wasm = instantiate();
    expect(wasm.reserve_input(0)).toBe(-1);
    expect(wasm.reserve_input(3)).toBe(-1);
    expect(wasm.quantize(4, 1)).toBe(-1);
    expect(wasm.quantize(4, 0)).toBe(-1);
  });
});

describe('conversion-owned WASM glue', () => {
  it('precharges initial memory and growth, then matches the ordered palette', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(wasmBytes, {
          status: 200,
          headers: { 'content-type': 'application/wasm' },
        })
    );
    const admissions: Array<[number, number]> = [];
    const capacities: number[] = [];
    const quantize = await createGifScalarQuantizer(
      (oldBytes, newBytes) => admissions.push([oldBytes, newBytes]),
      (bytes) => capacities.push(bytes)
    );
    const input = rgba([
      [1, 2, 3, 255],
      [250, 240, 230, 255],
    ]);
    expect(quantize(input, 2)).toEqual(reference(input, 2));
    expect(admissions[0]).toEqual([0, 8 * 1024 * 1024]);
    expect(capacities[0]).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(capacities.at(-1)).toBeLessThanOrEqual(12 * 1024 * 1024);
  });

  it('fails closed on bad MIME and denied growth', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(wasmBytes, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
    );
    await expect(
      createGifScalarQuantizer(
        () => {},
        () => {}
      )
    ).rejects.toBeInstanceOf(GifScalarLoadError);
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(wasmBytes, {
          status: 200,
          headers: { 'content-type': 'application/wasm' },
        })
    );
    const quantize = await createGifScalarQuantizer(
      (oldBytes) => {
        if (oldBytes > 0) throw new GifScalarMemoryError('denied');
      },
      () => {}
    );
    const input = new Uint8Array(1920 * 1080 * 4);
    expect(() => quantize(input, 64)).toThrow(GifScalarMemoryError);
  });
});
