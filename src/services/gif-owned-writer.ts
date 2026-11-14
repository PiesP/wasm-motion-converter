// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// GIF block layout adapted from gifenc 1.0.3 (MIT), Matt DesLauriers.

import { OutputLimitError } from './output-limits';

interface FrameOptions {
  palette?: number[][];
  colorDepth: number;
  repeat: number;
  delay: number;
}

/** Opaque full-frame GIF89a records only; timing and palette policy belong to the service. */
export class OwnedGifWriter {
  private buffer: Uint8Array;
  private cursor = 0;
  private initialized = false;
  private finished = false;
  readonly stream: { readonly buffer: ArrayBuffer };

  constructor(
    initialCapacity: number,
    private readonly maxOutputBytes: number,
    private readonly assertPeak: (bytes: number) => void,
    private readonly compress: (indices: Uint8Array, depth: number) => Uint8Array
  ) {
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
    const next = Math.max(required, Math.floor(current * (current < 1024 * 1024 ? 2 : 1.125)), 256);
    if (next > this.maxOutputBytes || current + next > this.maxOutputBytes) {
      throw new OutputLimitError('gif', 'byte', this.maxOutputBytes);
    }
    this.assertPeak(current + next);
    const grown = new Uint8Array(next);
    grown.set(this.buffer.subarray(0, this.cursor));
    this.buffer = grown;
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

  private table(palette: number[][]): void {
    const count = 1 << Math.max(1, Math.ceil(Math.log2(palette.length)));
    for (let i = 0; i < count; i++) {
      const color = palette[i];
      this.byte(color?.[0] ?? 0);
      this.byte(color?.[1] ?? 0);
      this.byte(color?.[2] ?? 0);
    }
  }

  writeFrame(index: Uint8Array, width: number, height: number, options: FrameOptions): void {
    const { palette, colorDepth, repeat, delay } = options;
    if (
      this.finished ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 65535 ||
      height > 65535 ||
      index.length !== width * height ||
      !Number.isInteger(colorDepth) ||
      colorDepth < 2 ||
      colorDepth > 8 ||
      !Number.isInteger(delay / 10) ||
      delay < 0 ||
      delay / 10 > 65535 ||
      repeat !== 0
    ) {
      throw new RangeError('Invalid owned GIF frame');
    }
    if (
      (!this.initialized && !palette) ||
      (palette &&
        (palette.length < 1 ||
          palette.length > 256 ||
          palette.some(
            (color) =>
              color.length !== 3 ||
              color.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)
          )))
    ) {
      throw new RangeError('Invalid owned GIF palette');
    }
    const first = !this.initialized;
    // Compression owns only a bounded frame buffer in WASM. Append its borrowed
    // view directly, before any subsequent WASM operation can overwrite it.
    const compressed = this.compress(index, colorDepth);
    if (first) {
      this.text('GIF89a');
      this.short(width);
      this.short(height);
      this.byte(
        0x80 | ((colorDepth - 1) << 4) | (Math.max(1, Math.ceil(Math.log2(palette!.length))) - 1)
      );
      this.byte(0);
      this.byte(0);
      this.table(palette!);
      this.byte(0x21);
      this.byte(0xff);
      this.byte(11);
      this.text('NETSCAPE2.0');
      this.byte(3);
      this.byte(1);
      this.short(repeat);
      this.byte(0);
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
    const local = !first && palette;
    this.byte(local ? 0x80 | (Math.max(1, Math.ceil(Math.log2(local.length))) - 1) : 0);
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
