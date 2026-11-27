// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// GIF block layout and buffer growth adapted from gifenc 1.0.3 (MIT), Matt DesLauriers.

import { toGifRepeat } from '@utils/playback-count';

import { OutputLimitError } from './output-limits';

type Palette = number[][] | Uint8Array;

interface FrameOptions {
  palette?: Palette;
  /** A new stream may use the conversion's global table and a local first record. */
  globalPalette?: Palette;
  colorDepth: number;
  delay: number;
}

function paletteLength(palette: Palette): number {
  return palette instanceof Uint8Array ? palette.length / 3 : palette.length;
}

function tableDepth(palette: Palette): number {
  return Math.max(1, Math.ceil(Math.log2(paletteLength(palette))));
}

function paletteIsValid(palette: Palette): boolean {
  return (
    paletteLength(palette) >= 1 &&
    paletteLength(palette) <= 256 &&
    (palette instanceof Uint8Array
      ? palette.length % 3 === 0
      : palette.every(
          (color) =>
            color.length === 3 &&
            color.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)
        ))
  );
}

/** Opaque full-frame GIF89a records only; timing and palette policy belong to the service. */
export class OwnedGifWriter {
  private buffer: Uint8Array;
  private cursor = 0;
  private initialized = false;
  private finished = false;
  private readonly repeat: number | null;
  readonly stream: { readonly buffer: ArrayBuffer };

  constructor(
    initialCapacity: number,
    private readonly maxOutputBytes: number,
    private readonly assertPeak: (bytes: number) => void,
    private readonly compress: (indices: Uint8Array, depth: number) => Uint8Array,
    playCount = 0
  ) {
    this.repeat = toGifRepeat(playCount);
    if (
      !Number.isSafeInteger(initialCapacity) ||
      initialCapacity < 1 ||
      initialCapacity > maxOutputBytes
    ) {
      throw new OutputLimitError('gif', 'byte', maxOutputBytes);
    }
    this.buffer = new Uint8Array(initialCapacity);
    const owner = this;
    this.stream = {
      get buffer() {
        return owner.buffer.buffer as ArrayBuffer;
      },
    };
  }

  private reserve(length: number): void {
    const required = this.cursor + length;
    if (!Number.isSafeInteger(required) || length < 0 || required > this.maxOutputBytes) {
      throw new OutputLimitError('gif', 'byte', this.maxOutputBytes);
    }
    const current = this.buffer.byteLength;
    if (required <= current) {
      this.assertPeak(current);
      return;
    }
    const next = this.capacityFor(required);
    if (next > this.maxOutputBytes || current + next > this.maxOutputBytes) {
      throw new OutputLimitError('gif', 'byte', this.maxOutputBytes);
    }
    this.assertPeak(current + next);
    const grown = new Uint8Array(next);
    grown.set(this.buffer.subarray(0, this.cursor));
    this.buffer = grown;
  }

  private capacityFor(required: number): number {
    const current = this.buffer.byteLength;
    return required <= current
      ? current
      : Math.max(required, Math.floor(current * (current < 1024 * 1024 ? 2 : 1.125)), 256);
  }

  private byte(value: number): void {
    this.reserve(1);
    this.buffer[this.cursor++] = value;
  }

  private short(value: number): void {
    this.byte(value & 255);
    this.byte((value >>> 8) & 255);
  }

  private text(value: string): void {
    for (let i = 0; i < value.length; i++) this.byte(value.charCodeAt(i));
  }

  private table(palette: Palette): void {
    const count = 1 << tableDepth(palette);
    for (let i = 0; i < count; i++) {
      const color = palette instanceof Uint8Array ? palette.subarray(i * 3, i * 3 + 3) : palette[i];
      this.byte(color?.[0] ?? 0);
      this.byte(color?.[1] ?? 0);
      this.byte(color?.[2] ?? 0);
    }
  }

  writeFrame(index: Uint8Array, width: number, height: number, options: FrameOptions): void {
    this.validateFrame(index.length, width, height, options);
    // The view is consumed synchronously, before another WASM operation.
    this.writeValidatedFrame(this.compress(index, options.colorDepth), width, height, options);
  }

  writeCompressedFrame(
    compressed: Uint8Array,
    pixelCount: number,
    width: number,
    height: number,
    options: FrameOptions
  ): void {
    this.validateFrame(pixelCount, width, height, options);
    this.writeValidatedFrame(compressed, width, height, options);
  }

  /** Reserve a complete record and its final copy before changing the stream. */
  tryWritePartFrame(
    compressed: Uint8Array,
    pixelCount: number,
    width: number,
    height: number,
    options: FrameOptions,
    targetPeakBytes = this.maxOutputBytes
  ): boolean {
    this.validateFrame(pixelCount, width, height, options);
    const global = this.initialized ? undefined : (options.globalPalette ?? options.palette);
    const local = this.initialized || options.globalPalette ? options.palette : undefined;
    const globalBytes = global
      ? 13 + (3 << tableDepth(global)) + (this.repeat === null ? 0 : 19)
      : 0;
    const localBytes = local ? 3 << tableDepth(local) : 0;
    // Graphic control and image descriptor, compressed blocks, and the trailer.
    const length = globalBytes + localBytes + 18 + compressed.byteLength + 1;
    const finalLength = this.cursor + length;
    const current = this.buffer.byteLength;
    const next = this.capacityFor(finalLength);
    const growthPeak = next === current ? current : current + next;
    const peak = Math.max(growthPeak, next + finalLength);
    // A fresh part can hold a single record up to the hard limit.
    if (
      !Number.isSafeInteger(peak) ||
      peak > this.maxOutputBytes ||
      (this.initialized && peak > targetPeakBytes)
    ) {
      return false;
    }
    this.assertPeak(peak);
    this.reserve(length);
    this.writeValidatedFrame(compressed, width, height, options);
    return true;
  }

  /** Live output capacity plus the exact copy reserved for finalizing a part. */
  partFinalizationBytes(): number {
    return this.buffer.byteLength + (this.initialized ? this.cursor + 1 : 0);
  }

  private validateFrame(
    indexLength: number,
    width: number,
    height: number,
    options: FrameOptions
  ): void {
    const { palette, globalPalette, colorDepth, delay } = options;
    if (
      this.finished ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 65535 ||
      height > 65535 ||
      indexLength !== width * height ||
      !Number.isInteger(colorDepth) ||
      colorDepth < 2 ||
      colorDepth > 8 ||
      !Number.isInteger(delay / 10) ||
      delay < 0 ||
      delay / 10 > 65535
    ) {
      throw new RangeError('Invalid owned GIF frame');
    }
    if (
      (!this.initialized && !palette && !globalPalette) ||
      (globalPalette && (this.initialized || !paletteIsValid(globalPalette))) ||
      (palette && !paletteIsValid(palette))
    ) {
      throw new RangeError('Invalid owned GIF palette');
    }
  }

  private writeValidatedFrame(
    compressed: Uint8Array,
    width: number,
    height: number,
    options: FrameOptions
  ): void {
    const { palette, globalPalette, colorDepth, delay } = options;
    const first = !this.initialized;
    if (first) {
      const global = globalPalette ?? palette!;
      this.text('GIF89a');
      this.short(width);
      this.short(height);
      const depth = tableDepth(global);
      const screenColorDepth = globalPalette ? Math.max(2, depth) : colorDepth;
      this.byte(0x80 | ((screenColorDepth - 1) << 4) | (depth - 1));
      this.byte(0);
      this.byte(0);
      this.table(global);
      if (this.repeat !== null) {
        this.byte(0x21);
        this.byte(0xff);
        this.byte(11);
        this.text('NETSCAPE2.0');
        this.byte(3);
        this.byte(1);
        this.short(this.repeat);
        this.byte(0);
      }
      this.initialized = true;
    }
    this.byte(0x21);
    this.byte(0xf9);
    this.byte(4);
    this.byte(0);
    this.short(delay / 10);
    this.byte(0);
    this.byte(0);
    this.byte(0x2c);
    this.short(0);
    this.short(0);
    this.short(width);
    this.short(height);
    const local = (!first || globalPalette) && palette;
    this.byte(local ? 0x80 | (tableDepth(local) - 1) : 0);
    if (local) this.table(local);
    this.reserve(compressed.byteLength);
    this.buffer.set(compressed, this.cursor);
    this.cursor += compressed.byteLength;
  }

  finish(): void {
    if (this.finished || !this.initialized) throw new RangeError('Invalid owned GIF termination');
    this.byte(0x3b);
    this.finished = true;
  }

  bytesView(): Uint8Array {
    return this.buffer.subarray(0, this.cursor);
  }
  bytes(): Uint8Array {
    return this.bytesView().slice();
  }
}
