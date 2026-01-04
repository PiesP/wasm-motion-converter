declare module 'gifenc' {
  export type GifEncPalette = Array<number[]>;

  export interface GifEncoderOptions {
    initialCapacity?: number;
    auto?: boolean;
  }

  export interface GifFrameOptions {
    palette?: GifEncPalette | null;
    delay?: number;
    repeat?: number;
    transparent?: boolean;
    transparentIndex?: number;
    colorDepth?: number;
    dispose?: number;
    first?: boolean;
  }

  export interface GifEncoderInstance {
    reset(): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    readonly buffer: ArrayBuffer;
    readonly stream: unknown;
    writeHeader(): void;
    writeFrame(index: Uint8Array, width: number, height: number, opts?: GifFrameOptions): void;
  }

  export default function GIFEncoder(options?: GifEncoderOptions): GifEncoderInstance;
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: {
      format?: 'rgb565' | 'rgb444' | 'rgba4444';
      clearAlpha?: boolean;
      clearAlphaColor?: number;
      clearAlphaThreshold?: number;
      oneBitAlpha?: boolean;
      useSqrt?: boolean;
    }
  ): GifEncPalette;
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: GifEncPalette,
    format?: 'rgb565' | 'rgb444' | 'rgba4444'
  ): Uint8Array;
  export function prequantize(
    rgba: Uint8Array | Uint8ClampedArray,
    options?: {
      roundRGB?: number;
      roundAlpha?: number;
      oneBitAlpha?: number | boolean;
    }
  ): void;
}
