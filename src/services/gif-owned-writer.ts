// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
// GIF block layout and buffer growth adapted from gifenc 1.0.3 (MIT), Matt DesLauriers.

import { toGifRepeat } from '@utils/playback-count';

import { OutputLimitError } from './output-limits';

interface FrameOptions {
  palette?: number[][] | Uint8Array;
  colorDepth: number;
  delay: number;
}

function paletteLength(palette: number[][] | Uint8Array): number {
  return palette instanceof Uint8Array ? palette.length / 3 : palette.length;
}

/** Opaque full-frame GIF89a records only; timing and palette policy belong to the service. */
export class OwnedGifWriter {
  private buffer: Uint8Array<ArrayBuffer>;
  private cursor = 0;
  private sealedBytes = 0;
  private readonly segments: Blob[] | null;
  private initialized = false;
  private finished = false;
  private readonly repeat: number | null;
  readonly stream: { readonly buffer: ArrayBuffer };

  constructor(
    initialCapacity: number,
    private readonly maxOutputBytes: number,
    private readonly assertPeak: (bytes: number) => void,
    private readonly compress: (indices: Uint8Array, depth: number) => Uint8Array,
    playCount = 0,
    segmented = false
  ) {
    this.repeat = toGifRepeat(playCount);
    if (
      !Number.isSafeInteger(initialCapacity) ||
      initialCapacity < 1 ||
      initialCapacity > maxOutputBytes
    ) {
      throw new OutputLimitError('gif', 'byte', maxOutputBytes);
    }
    this.segments = segmented ? [] : null;
    this.buffer = new Uint8Array(initialCapacity);
    const owner = this;
    this.stream = {
      get buffer() {
        return owner.buffer.buffer as ArrayBuffer;
      },
    };
  }

  get retainedBytes(): number {
    return this.sealedBytes + this.buffer.byteLength;
  }

  private sealSegment(): void {
    const peakBytes = this.retainedBytes + this.cursor;
    if (peakBytes > this.maxOutputBytes) {
      throw new OutputLimitError('gif', 'byte', this.maxOutputBytes);
    }
    this.assertPeak(peakBytes);
    // Blob takes a snapshot. The same mutable staging buffer can then be reused.
    this.segments!.push(new Blob([this.buffer.subarray(0, this.cursor)]));
    this.sealedBytes += this.cursor;
    this.cursor = 0;
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
    if (this.segments) {
      if (this.cursor === this.buffer.byteLength) this.sealSegment();
    } else {
      this.reserve(1);
    }
    this.buffer[this.cursor++] = value;
  }

  private short(value: number): void {
    this.byte(value & 255);
    this.byte((value >>> 8) & 255);
  }

  private text(value: string): void {
    for (let i = 0; i < value.length; i++) this.byte(value.charCodeAt(i));
  }

  private table(palette: number[][] | Uint8Array): void {
    const count = 1 << Math.max(1, Math.ceil(Math.log2(paletteLength(palette))));
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

  private validateFrame(
    indexLength: number,
    width: number,
    height: number,
    options: FrameOptions
  ): void {
    const { palette, colorDepth, delay } = options;
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
      (!this.initialized && !palette) ||
      (palette &&
        (paletteLength(palette) < 1 ||
          paletteLength(palette) > 256 ||
          (palette instanceof Uint8Array
            ? palette.length % 3 !== 0
            : palette.some(
                (color) =>
                  color.length !== 3 ||
                  color.some(
                    (channel) => !Number.isInteger(channel) || channel < 0 || channel > 255
                  )
              ))))
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
    const { palette, colorDepth, delay } = options;
    const first = !this.initialized;
    if (first) {
      this.text('GIF89a');
      this.short(width);
      this.short(height);
      this.byte(
        0x80 |
          ((colorDepth - 1) << 4) |
          (Math.max(1, Math.ceil(Math.log2(paletteLength(palette!)))) - 1)
      );
      this.byte(0);
      this.byte(0);
      this.table(palette!);
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
    const local = !first && palette;
    this.byte(local ? 0x80 | (Math.max(1, Math.ceil(Math.log2(paletteLength(local)))) - 1) : 0);
    if (local) this.table(local);
    this.writeImageData(compressed);
  }

  private writeImageData(compressed: Uint8Array): void {
    if (!this.segments) {
      this.reserve(compressed.byteLength);
      this.buffer.set(compressed, this.cursor);
      this.cursor += compressed.byteLength;
      return;
    }
    let offset = 0;
    while (offset < compressed.byteLength) {
      if (this.cursor === this.buffer.byteLength) this.sealSegment();
      const length = Math.min(this.buffer.byteLength - this.cursor, compressed.byteLength - offset);
      this.buffer.set(compressed.subarray(offset, offset + length), this.cursor);
      offset += length;
      this.cursor += length;
    }
  }

  finish(): void {
    if (this.finished || !this.initialized) throw new RangeError('Invalid owned GIF termination');
    this.byte(0x3b);
    this.finished = true;
  }

  takeBlob(): Blob {
    if (!this.finished || !this.segments || (!this.segments.length && !this.cursor)) {
      throw new RangeError('Invalid owned GIF Blob finalization');
    }
    if (this.cursor) this.sealSegment();
    const output = new Blob(this.segments, { type: 'image/gif' });
    this.segments.length = 0;
    this.sealedBytes = 0;
    this.buffer = new Uint8Array(0);
    return output;
  }

  bytesView(): Uint8Array {
    if (this.segments) throw new RangeError('GIF writer has segmented storage');
    return this.buffer.subarray(0, this.cursor);
  }
  bytes(): Uint8Array {
    return this.bytesView().slice();
  }
}
