// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { readFileSync } from 'node:fs';

import { ConversionMemoryLimitError } from '@services/conversion-memory-limit-error';
import { OwnedGifWriter } from '@services/gif-owned-writer';
import {
  createGifScalarQuantizer,
  GifScalarAbiError,
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
  abi_version(): number;
  input_ptr(): number;
  reserve_input(length: number): number;
  prepare_rgba(length: number, width: number, height: number, strength: number): number;
  palette_ptr(): number;
  quantize(length: number, colors: number): number;
  indices_ptr(): number;
  map_palette(length: number, colors: number): number;
  lzw_bound(pixels: number): number;
  lzw_output_ptr(): number;
  lzw_encode(pixels: number, depth: number, capacity: number): number;
  retained_layout_end(length: number): number;
  enable_retained(length: number): number;
  map_retained(length: number, colors: number): number;
  promote_retained(handle: number): number;
  retained_result_ptr(): number;
  release_retained(handle: number): number;
  retained_palette_len(handle: number): number;
  retained_palette_ptr(handle: number): number;
  same_retained_pixels(first: number, second: number): number;
  capture_global_palette(handle: number): number;
  remap_retained_global(handle: number): number;
  lzw_encode_retained(handle: number, depth: number, capacity: number): number;
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

function retainedHandle(wasm: ReturnType<typeof instantiate>, status: number): number {
  const record = new DataView(wasm.memory.buffer, wasm.retained_result_ptr(), 8);
  expect(record.getInt32(0, true)).toBe(status);
  if (status !== 0) {
    expect(record.getUint32(4, true)).toBe(0);
    return 0;
  }
  const handle = record.getUint32(4, true);
  expect(handle).toBeGreaterThan(0);
  return handle;
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
  it('compacts first-occurrence RGB, protects pending indexes, and rejects stale handles', () => {
    const wasm = instantiate();
    const first = rgba([
      [255, 0, 0, 255],
      [0, 0, 255, 255],
      [255, 0, 0, 255],
      [0, 0, 255, 255],
    ]);
    const second = rgba([
      [0, 0, 255, 255],
      [255, 0, 0, 255],
      [0, 0, 255, 255],
      [255, 0, 0, 255],
    ]);
    const length = first.length;
    expect(wasm.retained_layout_end(length)).toBe(
      wasm.input_ptr() + Math.max(length, length / 4 + wasm.lzw_bound(length / 4)) + length / 2
    );
    expect(wasm.enable_retained(length)).toBe(0);
    const map = (input: Uint8Array, palette: number[][]) => {
      expect(wasm.reserve_input(length)).toBe(0);
      new Uint8Array(wasm.memory.buffer, wasm.input_ptr(), length).set(input);
      new Uint8Array(wasm.memory.buffer, wasm.palette_ptr(), palette.length * 3).set(
        palette.flat()
      );
      return retainedHandle(wasm, wasm.map_retained(length, palette.length));
    };
    const transient = map(first, [
      [255, 0, 0],
      [0, 0, 255],
      [255, 0, 0],
    ]);
    expect(transient).toBeGreaterThan(0);
    expect(wasm.retained_palette_len(transient)).toBe(2);
    expect(new Uint8Array(wasm.memory.buffer, wasm.retained_palette_ptr(transient), 6)).toEqual(
      Uint8Array.of(255, 0, 0, 0, 0, 255)
    );
    expect(new Uint8Array(wasm.memory.buffer, wasm.input_ptr(), 4)).toEqual(
      Uint8Array.of(0, 1, 0, 1)
    );
    const pending = retainedHandle(wasm, wasm.promote_retained(transient));
    expect(pending).toBeGreaterThan(0);
    const staleStatus = wasm.promote_retained(transient);
    expect(staleStatus).toBe(-1);
    retainedHandle(wasm, staleStatus);
    expect(wasm.retained_palette_len(transient)).toBe(-1);
    expect(wasm.capture_global_palette(pending)).toBe(0);
    const next = map(second, [
      [0, 0, 255],
      [255, 0, 0],
    ]);
    const candidateBeforeCompression = new Uint8Array(
      wasm.memory.buffer,
      wasm.input_ptr(),
      4
    ).slice();
    expect(wasm.same_retained_pixels(pending, next)).toBe(0);
    const bound = wasm.lzw_bound(4);
    expect(wasm.lzw_encode_retained(pending, 2, bound + 1)).toBe(-1);
    const encodedLength = wasm.lzw_encode_retained(pending, 2, bound);
    expect(encodedLength).toBeGreaterThan(0);
    expect(new Uint8Array(wasm.memory.buffer, wasm.lzw_output_ptr(), encodedLength)).toEqual(
      referenceImageData(Uint8Array.of(0, 1, 0, 1), 2)
    );
    expect(new Uint8Array(wasm.memory.buffer, wasm.input_ptr(), 4)).toEqual(
      candidateBeforeCompression
    );
    const successor = retainedHandle(wasm, wasm.promote_retained(next));
    expect(wasm.remap_retained_global(successor)).toBe(1);
    expect(wasm.release_retained(pending)).toBe(0);
    expect(wasm.lzw_encode_retained(pending, 2, bound)).toBe(-1);
    const duplicate = map(second, [
      [0, 0, 255],
      [255, 0, 0],
    ]);
    expect(wasm.same_retained_pixels(successor, duplicate)).toBe(1);
    expect(wasm.release_retained(duplicate)).toBe(0);
    expect(wasm.release_retained(successor)).toBe(0);
  });

  it('prepares exact Bayer RGBA in its admitted arena across strengths, geometry and reuse', () => {
    const wasm = instantiate();
    expect(wasm.abi_version()).toBe(3);
    const bayer = [
      0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60,
      28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15,
      47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
    ];
    for (const [width, height, strength] of [
      [1, 1, 0],
      [8, 8, 8],
      [17, 13, 12],
      [9, 2, 255],
      [17, 13, 8],
    ]) {
      const input = new Uint8Array(width! * height! * 4);
      for (let pixel = 0; pixel < width! * height!; pixel++) {
        input.set([pixel & 255, 255 - (pixel & 255), (pixel * 17) & 255, pixel & 1], pixel * 4);
      }
      const expected = input.slice();
      for (let y = 0; y < height!; y++) {
        for (let x = 0; x < width!; x++) {
          const threshold = (((bayer[(y & 7) * 8 + (x & 7)]! - 32) * strength!) / 64) | 0;
          const offset = (y * width! + x) * 4;
          for (let channel = 0; channel < 3; channel++) {
            expected[offset + channel] = Math.max(
              0,
              Math.min(255, expected[offset + channel]! + threshold)
            );
          }
        }
      }
      const pointer = wasm.input_ptr();
      const end = pointer + input.byteLength;
      if (end > wasm.memory.buffer.byteLength) {
        wasm.memory.grow(Math.ceil((end - wasm.memory.buffer.byteLength) / 65_536));
      }
      expect(wasm.reserve_input(input.byteLength)).toBe(0);
      new Uint8Array(wasm.memory.buffer, pointer, input.byteLength).set(input);
      expect(wasm.prepare_rgba(input.byteLength, width!, height!, strength!)).toBe(0);
      expect(new Uint8Array(wasm.memory.buffer, pointer, input.byteLength)).toEqual(expected);
      expect(wasm.prepare_rgba(input.byteLength, width!, height!, strength!)).toBe(-1);
      const count = wasm.quantize(input.byteLength, 16);
      expect(count).toBeGreaterThan(0);
      const palette = Array.from({ length: count }, (_, index) =>
        Array.from(new Uint8Array(wasm.memory.buffer, wasm.palette_ptr() + index * 3, 3))
      );
      expect(palette).toEqual(reference(expected, 16));
    }
    expect(wasm.prepare_rgba(4, 1, 1, 8)).toBe(-1);
    expect(wasm.reserve_input(4)).toBe(0);
    expect(wasm.prepare_rgba(4, 2, 1, 8)).toBe(-1);
    expect(wasm.prepare_rgba(4, 1, 1, 256)).toBe(-1);
    expect(wasm.prepare_rgba(4, 0xffff_ffff, 2, 8)).toBe(-1);
  });
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
  it('emits the same complete GIF bytes as the JS-index path with deferred compression', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(wasmBytes, {
          status: 200,
          headers: { 'content-type': 'application/wasm' },
        })
    );
    const legacy = await createGifScalarQuantizer(
      () => {},
      () => {}
    );
    const retained = await createGifScalarQuantizer(
      () => {},
      () => {}
    );
    const width = 17;
    const height = 13;
    const pixels = width * height;
    expect(retained.enableRetained(pixels)).toBe(true);
    const legacyWriter = new OwnedGifWriter(4096, 1 << 20, () => {}, legacy.compress);
    const retainedWriter = new OwnedGifWriter(
      4096,
      1 << 20,
      () => {},
      () => {
        throw new Error('Retained writer must consume precompressed data');
      }
    );
    const inputs = [1, 9].map((seed) => {
      const input = new Uint8Array(pixels * 4);
      for (let pixel = 0; pixel < pixels; pixel++) {
        input.set(
          [
            (pixel * 17 + seed) & 255,
            (pixel * 31 + seed * 3) & 255,
            (pixel * 7 + seed * 5) & 255,
            255,
          ],
          pixel * 4
        );
      }
      return input;
    });
    const legacyFrames = inputs.map((input) => {
      legacy.prepare(input, width, height, 8);
      const palette = legacy.quantizePrepared(128);
      const index = legacy.mapPalette(input, palette);
      const compact: number[][] = [];
      const byColor = new Map<string, number>();
      for (let pixel = 0; pixel < index.length; pixel++) {
        const color = palette[index[pixel]!]!;
        const key = color.join(',');
        let mapped = byColor.get(key);
        if (mapped === undefined) {
          mapped = compact.length;
          compact.push(color);
          byColor.set(key, mapped);
        }
        index[pixel] = mapped;
      }
      return { index, palette: compact };
    });
    const encode = (frame: number, handle: number) => {
      const legacyFrame = legacyFrames[frame]!;
      const local = retained.retainedPalette(handle);
      expect(local).toEqual(Uint8Array.from(legacyFrame.palette.flat()));
      const depth = Math.max(2, Math.ceil(Math.log2(local.length / 3)));
      const options = { palette: legacyFrame.palette, colorDepth: depth, repeat: 0, delay: 20 };
      legacyWriter.writeFrame(legacyFrame.index, width, height, options);
      const compressed = retained.compressRetained(handle, depth);
      retainedWriter.writeCompressedFrame(compressed, pixels, width, height, {
        palette: local,
        colorDepth: depth,
        repeat: 0,
        delay: 20,
      });
      if (frame === 0) retained.captureGlobalPalette(handle);
    };
    retained.prepare(inputs[0]!, width, height, 8);
    const firstCount = retained.quantizePreparedRetained(128);
    const first = retained.promoteRetained(retained.mapRetained(inputs[0]!, firstCount));
    retained.prepare(inputs[1]!, width, height, 8);
    const nextCount = retained.quantizePreparedRetained(128);
    const transientNext = retained.mapRetained(inputs[1]!, nextCount);
    encode(0, first);
    retained.releaseRetained(first);
    const second = retained.promoteRetained(transientNext);
    encode(1, second);
    retained.releaseRetained(second);
    legacyWriter.finish();
    retainedWriter.finish();
    expect(retainedWriter.bytes()).toEqual(legacyWriter.bytes());
  });

  it('chooses whole-conversion fallback only for prospective retained capacity refusal', async () => {
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
        if (oldBytes > 0) throw new ConversionMemoryLimitError('aggregate guard refused');
      },
      () => {}
    );
    expect(quantize.enableRetained(1920 * 1080)).toBe(false);
    expect(quantize.enableRetained(3840 * 2160)).toBe(false);
    const input = rgba([[10, 20, 30, 255]]);
    expect(quantize(input, 2)).toEqual(reference(input, 2));

    const terminal = await createGifScalarQuantizer(
      (oldBytes) => {
        if (oldBytes > 0) throw new GifScalarMemoryError('actual growth failed');
      },
      () => {}
    );
    expect(() => terminal.enableRetained(1920 * 1080)).toThrow(GifScalarMemoryError);
  });

  it('retains two protected indexes while compressing a predecessor after mapping a successor', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(wasmBytes, {
          status: 200,
          headers: { 'content-type': 'application/wasm' },
        })
    );
    const quantize = await createGifScalarQuantizer(
      () => {},
      () => {}
    );
    const width = 17;
    const height = 13;
    const pixels = width * height;
    expect(quantize.enableRetained(pixels)).toBe(true);
    const makeFrame = (seed: number) => {
      const input = new Uint8Array(pixels * 4);
      for (let pixel = 0; pixel < pixels; pixel++) {
        input.set(
          [
            (pixel * 17 + seed) & 255,
            (pixel * 31 + seed * 3) & 255,
            (pixel * 7 + seed * 5) & 255,
            255,
          ],
          pixel * 4
        );
      }
      return input;
    };
    const map = (input: Uint8Array) => {
      quantize.prepare(input, width, height, 8);
      const count = quantize.quantizePreparedRetained(128);
      return quantize.mapRetained(input, count);
    };
    const first = map(makeFrame(1));
    const firstPalette = quantize.retainedPalette(first);
    expect(firstPalette.length).toBeGreaterThan(0);
    const pending = quantize.promoteRetained(first);
    expect(() => quantize.retainedPaletteLength(first)).toThrow(GifScalarAbiError);
    const second = map(makeFrame(9));
    expect(quantize.sameRetainedPixels(pending, second)).toBe(false);
    const depth = Math.max(2, Math.ceil(Math.log2(firstPalette.length / 3)));
    const predecessorData = quantize.compressRetained(pending, depth).slice();
    expect(predecessorData.length).toBeGreaterThan(2);
    const successor = quantize.promoteRetained(second);
    expect(quantize.retainedPalette(successor).length).toBeGreaterThan(0);
    quantize.captureGlobalPalette(pending);
    quantize.remapRetainedGlobal(successor);
    quantize.releaseRetained(pending);
    expect(() => quantize.compressRetained(pending, depth)).toThrow(GifScalarAbiError);
    const repeated = map(makeFrame(9));
    expect(quantize.sameRetainedPixels(successor, repeated)).toBe(true);
    quantize.releaseRetained(repeated);
    quantize.releaseRetained(successor);
  });

  it('matches complete gifenc bytes after native Bayer preparation from oversized pooled RGBA', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(wasmBytes, {
          status: 200,
          headers: { 'content-type': 'application/wasm' },
        })
    );
    const quantize = await createGifScalarQuantizer(
      () => {},
      () => {}
    );
    const owned = new OwnedGifWriter(
      4096,
      1 << 20,
      () => {},
      (indices, depth) => quantize.compress(indices, depth)
    );
    const oracle = referenceGifEncoder({ auto: true });
    const width = 17;
    const height = 13;
    const bayer = [
      0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60,
      28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15,
      47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
    ];
    for (const [frame, [colors, strength]] of [
      [64, 0],
      [128, 8],
      [256, 12],
    ].entries()) {
      const backing = new Uint8Array(width * height * 4 + 32);
      for (let pixel = 0; pixel < width * height; pixel++) {
        const offset = pixel * 4;
        backing.set(
          [
            (pixel * 17 + frame * 13) & 255,
            (pixel * 3 + frame * 29) & 255,
            (pixel * 31 + frame * 7) & 255,
            pixel & 1,
          ],
          offset
        );
      }
      backing.fill(0xa5, width * height * 4);
      const source = backing.subarray(0, width * height * 4);
      const expected = source.slice();
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const threshold = (((bayer[(y & 7) * 8 + (x & 7)]! - 32) * strength!) / 64) | 0;
          const offset = (y * width + x) * 4;
          for (let channel = 0; channel < 3; channel++) {
            expected[offset + channel] = Math.max(
              0,
              Math.min(255, expected[offset + channel]! + threshold)
            );
          }
        }
      }
      quantize.prepare(source, width, height, strength!);
      const palette = quantize.quantizePrepared(colors!);
      expect(palette).toEqual(reference(expected, colors!));
      const indices = quantize.mapPalette(source, palette);
      const oracleIndices = referenceApplyPalette(expected, palette, 'rgb565');
      expect(indices).toEqual(oracleIndices);
      const depth = Math.max(2, Math.ceil(Math.log2(palette.length)));
      const options = { palette, colorDepth: depth, repeat: 0, delay: 20 };
      owned.writeFrame(indices, width, height, options);
      oracle.writeFrame(oracleIndices, width, height, options);
      expect(backing.subarray(width * height * 4)).toEqual(new Uint8Array(32).fill(0xa5));
    }
    owned.finish();
    oracle.finish();
    expect(owned.bytes()).toEqual(oracle.bytes());
  });

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
    expect(() => quantize(null as never, 2)).toThrow(GifScalarAbiError);
    expect(() => quantize.quantizePrepared(2)).toThrow(GifScalarAbiError);
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
