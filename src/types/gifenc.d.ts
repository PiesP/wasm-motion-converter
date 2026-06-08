// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Type declarations for optional gifenc package.
 *
 * gifenc is an experimental peer dependency for the gifenc-adapter.
 * These declarations prevent TypeScript errors when the package is
 * not installed (dynamic import handles the runtime case).
 */

declare module 'gifenc' {
  export interface GIFEncoder {
    writeFrame(indexed: Uint8Array, delay: number, palette?: number[][]): void;
    finish(): void;
    bytes(): Uint8Array;
  }

  export function GIFEncoder(): GIFEncoder;

  export function quantize(data: Uint8ClampedArray, maxColors: number): number[][];

  export function applyPalette(
    imageData: ImageData,
    palette: number[][],
    format?: 'rgb' | 'rgba'
  ): Uint8Array;
}
