// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

const PAGE_BYTES = 65_536;
const PRIMARY_RGBA_BYTES = 720 * 720 * 4;
const MAX_INITIAL_LINEAR_BYTES = 8 * 1024 * 1024;
const PRIMARY_LINEAR_LIMIT_BYTES = 12 * 1024 * 1024;

interface QuantizerExports {
  memory: WebAssembly.Memory;
  input_ptr(): number;
  reserve_input(length: number): number;
  palette_ptr(): number;
  quantize(length: number, colors: number): number;
}

export class GifScalarLoadError extends Error {}
export class GifScalarAbiError extends Error {}
export class GifScalarMemoryError extends Error {}
export class GifScalarResultError extends Error {}

function roundPage(bytes: number): number {
  return Math.ceil(bytes / PAGE_BYTES) * PAGE_BYTES;
}

function validOffset(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function throwStatus(status: number, stage: string): never {
  if (status === -1) throw new GifScalarAbiError(`GIF scalar WASM ${stage} rejected its input`);
  if (status === -2) throw new GifScalarMemoryError(`GIF scalar WASM ${stage} exceeded memory`);
  throw new GifScalarResultError(`GIF scalar WASM ${stage} failed (${status})`);
}

/** One module instance belongs to one encodeGif call on either existing route. */
export async function createGifScalarQuantizer(
  assertCapacity: (oldBytes: number, newBytes: number) => void,
  setCapacity: (bytes: number) => void,
  signal?: AbortSignal
): Promise<(rgba: Uint8Array, colors: number) => number[][]> {
  // Instantiate may allocate its initial memory before its exports are visible.
  assertCapacity(0, MAX_INITIAL_LINEAR_BYTES);
  const assetUrl = new URL('./gif-scalar-quantizer.wasm', import.meta.url);
  let response: Response;
  try {
    response = await fetch(assetUrl.href, signal ? { signal } : {});
  } catch (error) {
    throw new GifScalarLoadError('GIF scalar WASM fetch failed', { cause: error });
  }
  if (
    !response.ok ||
    response.redirected ||
    response.type === 'opaque' ||
    response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/wasm'
  ) {
    throw new GifScalarLoadError('GIF scalar WASM asset response is invalid');
  }

  let instance: WebAssembly.Instance;
  try {
    ({ instance } = await WebAssembly.instantiateStreaming(response, {}));
  } catch (error) {
    throw new GifScalarLoadError('GIF scalar WASM instantiation failed', { cause: error });
  }
  const exports = instance.exports as unknown as Partial<QuantizerExports>;
  if (
    !(exports.memory instanceof WebAssembly.Memory) ||
    typeof exports.input_ptr !== 'function' ||
    typeof exports.reserve_input !== 'function' ||
    typeof exports.palette_ptr !== 'function' ||
    typeof exports.quantize !== 'function'
  ) {
    throw new GifScalarAbiError('GIF scalar WASM exports are invalid');
  }
  const wasm = exports as QuantizerExports;
  let capacity = wasm.memory.buffer.byteLength;
  if (capacity > MAX_INITIAL_LINEAR_BYTES) {
    throw new GifScalarMemoryError('GIF scalar WASM initial memory exceeds 8 MiB');
  }
  setCapacity(capacity);

  return (rgba, colors) => {
    if (
      !(rgba instanceof Uint8Array) ||
      !(rgba.buffer instanceof ArrayBuffer) ||
      rgba.byteOffset !== 0 ||
      rgba.byteLength !== rgba.buffer.byteLength ||
      rgba.byteLength === 0 ||
      (rgba.byteLength & 3) !== 0 ||
      !Number.isInteger(colors) ||
      colors < 1 ||
      colors > 256
    ) {
      throw new GifScalarAbiError('GIF scalar WASM requires whole nonempty RGBA and 1–256 colors');
    }
    const pointer = wasm.input_ptr();
    const end = pointer + rgba.byteLength;
    if (!validOffset(pointer) || !validOffset(end) || pointer < wasm.palette_ptr() + 768) {
      throw new GifScalarAbiError('GIF scalar WASM input offset is invalid');
    }
    const limit = roundPage(
      PRIMARY_LINEAR_LIMIT_BYTES + Math.max(0, rgba.byteLength - PRIMARY_RGBA_BYTES)
    );
    const needed = roundPage(end);
    if (needed > limit) {
      throw new GifScalarMemoryError('GIF scalar WASM frame exceeds its linear-memory budget');
    }
    const before = wasm.memory.buffer.byteLength;
    if (before !== capacity) {
      throw new GifScalarMemoryError('GIF scalar WASM memory grew outside its guard');
    }
    if (needed > before) {
      assertCapacity(before, needed);
      try {
        wasm.memory.grow((needed - before) / PAGE_BYTES);
      } catch (error) {
        throw new GifScalarMemoryError('GIF scalar WASM linear-memory growth failed', {
          cause: error,
        });
      }
      capacity = wasm.memory.buffer.byteLength;
      if (capacity !== needed) {
        throw new GifScalarMemoryError('GIF scalar WASM grew beyond its admitted capacity');
      }
      setCapacity(capacity);
    }
    const reserve = wasm.reserve_input(rgba.byteLength);
    if (reserve !== 0) {
      throwStatus(reserve, 'input reservation');
    }
    // memory.grow detaches old views; construct a fresh view for every copy.
    new Uint8Array(wasm.memory.buffer, pointer, rgba.byteLength).set(rgba);
    const count = wasm.quantize(rgba.byteLength, colors);
    if (count < 0) {
      throwStatus(count, 'quantization');
    }
    if (!Number.isInteger(count) || count < 1 || count > colors) {
      throw new GifScalarResultError('GIF scalar WASM palette count is invalid');
    }
    if (wasm.memory.buffer.byteLength !== capacity) {
      throw new GifScalarMemoryError('GIF scalar WASM memory grew during quantization');
    }
    const palettePointer = wasm.palette_ptr();
    if (
      !validOffset(palettePointer) ||
      palettePointer + count * 3 > pointer ||
      palettePointer + count * 3 > capacity
    ) {
      throw new GifScalarResultError('GIF scalar WASM palette offset is invalid');
    }
    const bytes = new Uint8Array(wasm.memory.buffer, palettePointer, count * 3);
    const palette: number[][] = [];
    for (let index = 0; index < count; index++) {
      const offset = index * 3;
      palette.push([bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!]);
    }
    return palette;
  };
}
