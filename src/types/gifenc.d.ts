// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

declare module 'gifenc' {
  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): {
    reset(): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    readonly buffer: ArrayBuffer;
    readonly stream: {
      readonly buffer: ArrayBuffer;
      writeByte(b: number): void;
      writeBytes(bytes: Uint8Array | number[], offset?: number, length?: number): void;
      writeBytesView(bytes: Uint8Array, offset?: number, length?: number): void;
    };
    writeHeader(): void;
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: {
        palette?: number[][];
        first?: boolean;
        transparent?: boolean;
        transparentIndex?: number;
        delay?: number;
        repeat?: number;
        dispose?: number;
      }
    ): void;
  };

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: {
      format?: 'rgb565' | 'rgb444' | 'rgba4444';
      oneBitAlpha?: boolean | number;
      clearAlpha?: boolean;
      clearAlphaThreshold?: number;
      clearAlphaColor?: number;
    }
  ): number[][];

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: 'rgb565' | 'rgb444' | 'rgba4444'
  ): Uint8Array;

  export function nearestColorIndex(palette: number[][], pixel: number[]): number;
  export function nearestColorIndexWithDistance(
    palette: number[][],
    pixel: number[]
  ): [number, number];
  export function nearestColor(palette: number[][], pixel: number[]): number[];
  export function prequantize(rgba: Uint8Array, maxColors: number): number[][];
  export function snapColorsToPalette(
    palette: number[][],
    knownColors: number[][],
    threshold?: number
  ): number[][];

  const GIFEncoderDefault: typeof GIFEncoder;
  export default GIFEncoderDefault;
}
