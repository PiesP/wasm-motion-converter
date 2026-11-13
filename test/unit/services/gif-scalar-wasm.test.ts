// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { readFileSync } from 'node:fs';

import {
  createGifScalarQuantizer,
  GifScalarLoadError,
  GifScalarMemoryError,
} from '@services/gif-scalar-wasm';
import { quantize as referenceQuantize } from 'gifenc';
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
} {
  const module = new WebAssembly.Module(wasmBytes);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  return new WebAssembly.Instance(module, {}).exports as ReturnType<typeof instantiate>;
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
