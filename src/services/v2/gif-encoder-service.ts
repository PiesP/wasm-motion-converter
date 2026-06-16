import GIFEncoder from 'gif-encoder-2';
import { frameToImageBitmap } from './transfer-utils';
import type { ConversionProgress } from '@/types/v2-conversion-types';

export interface GifEncodeOptions {
  width: number;
  height: number;
  quality: 'low' | 'medium' | 'high';
  scale: number;
}

/**
 * Quality → palette-size mapping for the Octree quantizer.
 *
 * gif-encoder-2 controls the color palette via `setPaletteSize(size)` where
 * the actual color count = 2^(size+1):
 *   size 5 →  64 colors (low)
 *   size 6 → 128 colors (medium)
 *   size 7 → 256 colors (high)
 */
const QUALITY_PALETTE_SIZE: Record<GifEncodeOptions['quality'], number> = {
  low: 5,
  medium: 6,
  high: 7,
};

export type GifProgressCallback = (progress: ConversionProgress) => void;

/**
 * Encode an async stream of VideoFrames into a GIF Uint8Array using the
 * Octree quantization algorithm from gif-encoder-2.
 *
 * Each frame is rendered through an OffscreenCanvas to the target dimensions
 * (opts.width × opts.height × opts.scale), then the RGBA pixel data is fed
 * directly to the encoder.
 */
export async function encodeGif(
  frameStream: AsyncGenerator<VideoFrame, void, void>,
  opts: GifEncodeOptions,
  onProgress?: GifProgressCallback,
): Promise<Uint8Array> {
  const w = Math.floor(opts.width * opts.scale);
  const h = Math.floor(opts.height * opts.scale);

  // Octree algorithm with frame-reuse optimizer enabled
  const encoder = new GIFEncoder(w, h, 'octree', true);
  encoder.setDelay(100); // 100 ms → 10 fps
  encoder.setPaletteSize(QUALITY_PALETTE_SIZE[opts.quality]);
  encoder.setRepeat(0); // loop forever
  encoder.start();

  let frameIdx = 0;
  const startTime = performance.now();

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;

  for await (const frame of frameStream) {
    const bitmap = await frameToImageBitmap(frame);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();

    const imageData = ctx.getImageData(0, 0, w, h);
    encoder.addFrame(imageData.data);

    frameIdx++;
    if (onProgress && frameIdx % 5 === 0) {
      const elapsed = (performance.now() - startTime) / 1000;
      const fps = frameIdx / elapsed;
      onProgress({
        phase: 'encoding',
        progress: 50,
        fps: Math.round(fps),
        etaSeconds: null,
        memoryMB: 0,
      });
    }
    frame.close();
  }

  encoder.finish();
  // out.getData() returns a Node Buffer; in the browser Vite polyfills
  // Buffer as a Uint8Array subclass, but wrap to guarantee the type.
  const buf: Uint8Array = encoder.out.getData();
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}
