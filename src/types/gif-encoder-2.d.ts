// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Type declarations for gif-encoder-2 (no upstream types).
 * Models the actual API from node_modules/gif-encoder-2/src/GIFEncoder.js.
 */
declare module 'gif-encoder-2' {
  interface GIFEncoderOut {
    getData(): Uint8Array;
  }

  class GIFEncoder {
    constructor(
      width: number,
      height: number,
      algorithm?: 'neuquant' | 'octree',
      useOptimizer?: boolean,
      totalFrames?: number,
    );

    out: GIFEncoderOut;

    start(): void;
    finish(): void;
    addFrame(input: Uint8Array | Uint8ClampedArray | { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } }): void;
    setDelay(ms: number): void;
    setQuality(quality: number): void;
    setRepeat(repeat: number): void;
    setFrameRate(fps: number): void;
    setPaletteSize(size: number): void;
    setThreshold(threshold: number): void;
    setTransparent(color: number): void;
    setDispose(code: number): void;
    createReadStream(): unknown;
  }

  export default GIFEncoder;
}
