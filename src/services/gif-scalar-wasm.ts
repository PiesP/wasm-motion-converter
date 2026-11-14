// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

const PAGE_BYTES = 65_536;
const PRIMARY_RGBA_BYTES = 720 * 720 * 4;
const MAX_INITIAL_LINEAR_BYTES = 8 * 1024 * 1024;
const PRIMARY_LINEAR_LIMIT_BYTES = 12 * 1024 * 1024;

interface QuantizerExports {
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

export interface GifScalarQuantizer {
  (rgba: Uint8Array, colors: number): number[][];
  prepare(rgba: Uint8Array, width: number, height: number, strength: number): void;
  quantizePrepared(colors: number): number[][];
  mapPalette(rgba: Uint8Array, palette: number[][]): Uint8Array;
  /** Borrowed view: consumed before the next module operation. */
  compress(indices: Uint8Array, depth: number): Uint8Array;
}

/** One module instance belongs to one encodeGif call on either existing route. */
export async function createGifScalarQuantizer(
  assertCapacity: (oldBytes: number, newBytes: number) => void,
  setCapacity: (bytes: number) => void,
  signal?: AbortSignal
): Promise<GifScalarQuantizer> {
  // Instantiate may allocate its initial memory before its exports are visible.
  assertCapacity(0, MAX_INITIAL_LINEAR_BYTES);
  const assetUrl = new URL('./gif-scalar-quantizer.wasm', import.meta.url);
  let response: Response;
  try {
    response = await fetch(assetUrl.href, signal ? { signal } : {});
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Conversion cancelled', 'AbortError');
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
  if (signal?.aborted) throw new DOMException('Conversion cancelled', 'AbortError');
  const exports = instance.exports as unknown as Partial<QuantizerExports>;
  if (
    !(exports.memory instanceof WebAssembly.Memory) ||
    typeof exports.abi_version !== 'function' ||
    typeof exports.input_ptr !== 'function' ||
    typeof exports.reserve_input !== 'function' ||
    typeof exports.prepare_rgba !== 'function' ||
    typeof exports.palette_ptr !== 'function' ||
    typeof exports.quantize !== 'function' ||
    ['indices_ptr', 'map_palette', 'lzw_bound', 'lzw_output_ptr', 'lzw_encode'].some(
      (name) => typeof instance.exports[name] !== 'function'
    )
  ) {
    throw new GifScalarAbiError('GIF scalar WASM exports are invalid');
  }
  const wasm = exports as QuantizerExports;
  if (wasm.abi_version() !== 2) {
    throw new GifScalarAbiError('GIF scalar WASM ABI version is unsupported');
  }
  let capacity = wasm.memory.buffer.byteLength;
  if (capacity > MAX_INITIAL_LINEAR_BYTES) {
    throw new GifScalarMemoryError('GIF scalar WASM initial memory exceeds 8 MiB');
  }
  setCapacity(capacity);

  let lastInput: Uint8Array | null = null;
  let preparedInput: Uint8Array | null = null;
  let reservedLength = 0;
  const abort = (): void => {
    if (signal?.aborted) throw new DOMException('Conversion cancelled', 'AbortError');
  };
  function admit(end: number, rgbaBytes: number): void {
    abort();
    const limit = roundPage(
      PRIMARY_LINEAR_LIMIT_BYTES + Math.max(0, rgbaBytes - PRIMARY_RGBA_BYTES)
    );
    const needed = roundPage(end);
    if (!validOffset(end) || needed > limit) {
      throw new GifScalarMemoryError('GIF scalar WASM frame exceeds its linear-memory budget');
    }
    const before = wasm.memory.buffer.byteLength;
    if (before !== capacity)
      throw new GifScalarMemoryError('GIF scalar WASM memory grew outside its guard');
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
      if (capacity !== needed)
        throw new GifScalarMemoryError('GIF scalar WASM grew beyond its admitted capacity');
      setCapacity(capacity);
    }
  }
  function checkedView(pointer: number, length: number): Uint8Array {
    if (
      !validOffset(pointer) ||
      !validOffset(length) ||
      !validOffset(pointer + length) ||
      pointer + length > capacity
    ) {
      throw new GifScalarAbiError('GIF scalar WASM output extent is invalid');
    }
    if (wasm.memory.buffer.byteLength !== capacity)
      throw new GifScalarMemoryError('GIF scalar WASM memory grew during processing');
    return new Uint8Array(wasm.memory.buffer, pointer, length);
  }
  const quantizer: GifScalarQuantizer = (rgba, colors) => {
    quantizer.prepare(rgba, rgba.byteLength / 4, 1, 0);
    return quantizer.quantizePrepared(colors);
  };
  quantizer.prepare = (rgba, width, height, strength) => {
    abort();
    lastInput = null;
    preparedInput = null;

    if (
      !(rgba instanceof Uint8Array) ||
      !(rgba.buffer instanceof ArrayBuffer) ||
      rgba.byteLength === 0 ||
      (rgba.byteLength & 3) !== 0 ||
      !Number.isSafeInteger(width) ||
      width < 1 ||
      !Number.isSafeInteger(height) ||
      height < 1 ||
      !Number.isInteger(strength) ||
      strength < 0 ||
      strength > 255 ||
      width * height * 4 !== rgba.byteLength ||
      rgba.buffer === wasm.memory.buffer
    ) {
      throw new GifScalarAbiError('GIF scalar WASM requires exact nonempty RGBA geometry');
    }
    const pointer = wasm.input_ptr();
    const end = pointer + rgba.byteLength;
    if (!validOffset(pointer) || !validOffset(end) || pointer < wasm.palette_ptr() + 768) {
      throw new GifScalarAbiError('GIF scalar WASM input offset is invalid');
    }
    admit(end, rgba.byteLength);
    const reserve = wasm.reserve_input(rgba.byteLength);
    if (reserve !== 0) {
      throwStatus(reserve, 'input reservation');
    }
    // memory.grow detaches old views; construct a fresh view for every copy.
    new Uint8Array(wasm.memory.buffer, pointer, rgba.byteLength).set(rgba);
    const prepared = wasm.prepare_rgba(rgba.byteLength, width, height, strength);
    if (prepared !== 0) throwStatus(prepared, 'RGBA preparation');
    if (wasm.memory.buffer.byteLength !== capacity) {
      throw new GifScalarMemoryError('GIF scalar WASM memory grew during RGBA preparation');
    }
    reservedLength = rgba.byteLength;
    preparedInput = rgba;
    abort();
  };
  quantizer.quantizePrepared = (colors) => {
    abort();
    if (preparedInput === null || !Number.isInteger(colors) || colors < 1 || colors > 256) {
      throw new GifScalarAbiError('GIF scalar WASM requires prepared RGBA and 1–256 colors');
    }
    const count = wasm.quantize(reservedLength, colors);
    if (count < 0) {
      throwStatus(count, 'quantization');
    }
    if (!Number.isInteger(count) || count < 1 || count > colors) {
      throw new GifScalarResultError('GIF scalar WASM palette count is invalid');
    }
    if (wasm.memory.buffer.byteLength !== capacity) {
      throw new GifScalarMemoryError('GIF scalar WASM memory grew during quantization');
    }
    const pointer = wasm.input_ptr();
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
    lastInput = preparedInput;
    preparedInput = null;
    abort();
    return palette;
  };
  quantizer.mapPalette = (rgba, palette) => {
    abort();
    if (
      lastInput !== rgba ||
      rgba.byteLength !== reservedLength ||
      palette.length < 1 ||
      palette.length > 256
    ) {
      throw new GifScalarAbiError('GIF scalar WASM mapping requires its just-quantized RGBA');
    }
    const bytes = checkedView(wasm.palette_ptr(), palette.length * 3);
    for (let i = 0; i < palette.length; i++) {
      const color = palette[i]!;
      if (
        color.length !== 3 ||
        color.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)
      ) {
        throw new GifScalarAbiError('GIF scalar WASM palette is invalid');
      }
      bytes.set(color, i * 3);
    }
    lastInput = null;
    const count = wasm.map_palette(reservedLength, palette.length);
    if (count < 0) throwStatus(count, 'palette mapping');
    if (count !== reservedLength / 4)
      throw new GifScalarResultError('GIF scalar WASM index count is invalid');
    if (wasm.indices_ptr() !== wasm.input_ptr())
      throw new GifScalarAbiError('GIF scalar WASM index offset is invalid');
    const view = checkedView(wasm.indices_ptr(), count);
    if (view.some((index) => index >= palette.length))
      throw new GifScalarResultError('GIF scalar WASM palette index is invalid');
    abort();
    return view.slice();
  };
  quantizer.compress = (indices, depth) => {
    abort();
    if (
      !(indices instanceof Uint8Array) ||
      indices.length === 0 ||
      indices.length !== reservedLength / 4 ||
      !Number.isInteger(depth) ||
      depth < 2 ||
      depth > 8
    ) {
      throw new GifScalarAbiError('GIF scalar WASM compression input is invalid');
    }
    const bound = wasm.lzw_bound(indices.length);
    const pointer = wasm.lzw_output_ptr();
    if (
      !validOffset(bound) ||
      bound < 1 ||
      !validOffset(pointer) ||
      pointer !== wasm.indices_ptr() + indices.length
    ) {
      throw new GifScalarAbiError('GIF scalar WASM compression extent is invalid');
    }
    admit(pointer + bound, reservedLength);
    checkedView(wasm.indices_ptr(), indices.length).set(indices);
    lastInput = null;
    const length = wasm.lzw_encode(indices.length, depth, bound);
    if (length < 0) throwStatus(length, 'LZW compression');
    if (length < 1 || length > bound)
      throw new GifScalarResultError('GIF scalar WASM compression length is invalid');
    abort();
    return checkedView(pointer, length);
  };
  return quantizer;
}
