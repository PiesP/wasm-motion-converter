import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import type { ConversionProgress } from '@/types/v2-conversion-types';
import { frameToImageBitmap } from './transfer-utils';

export interface GifEncodeOptions {
  width: number;
  height: number;
  quality: 'low' | 'medium' | 'high';
  scale: number;
}

const QUALITY_COLORS: Record<GifEncodeOptions['quality'], number> = {
  low: 64,
  medium: 128,
  high: 256,
};

export type GifProgressCallback = (progress: ConversionProgress) => void;

/**
 * Encode an async stream of VideoFrames into a GIF Uint8Array using gifenc.
 *
 * gifenc uses PNN (pairwise nearest neighbor) quantization. A single global
 * palette is computed from the first frame and reused across all frames for
 * speed. Each frame is rendered via OffscreenCanvas, quantized, palette-mapped,
 * and written to the GIF stream.
 */
export async function encodeGif(
  frameStream: AsyncGenerator<VideoFrame, void, void>,
  opts: GifEncodeOptions,
  onProgress?: GifProgressCallback
): Promise<Uint8Array> {
  const w = Math.floor(opts.width * opts.scale);
  const h = Math.floor(opts.height * opts.scale);
  const maxColors = QUALITY_COLORS[opts.quality];

  const encoder = GIFEncoder({ auto: true });
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;

  let frameIdx = 0;
  const startTime = performance.now();

  // ponytail: single global palette from first frame. Per-frame palettes
  // look better but double encode time. Add if quality complaints arise.
  let globalPalette: number[][] | null = null;

  for await (const frame of frameStream) {
    const bitmap = await frameToImageBitmap(frame);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();

    const imageData = ctx.getImageData(0, 0, w, h);
    const rgba = new Uint8Array(imageData.data);

    const delayMs = Math.max(10, Math.round((frame.duration ?? 33_333) / 1000)); // µs → ms

    if (!globalPalette) {
      // First frame: quantize → get global palette
      globalPalette = quantize(rgba, maxColors, { format: 'rgb565' });
      const indexed = applyPalette(rgba, globalPalette, 'rgb565');

      encoder.writeFrame(indexed, w, h, {
        palette: globalPalette,
        repeat: 0, // loop forever
        delay: delayMs,
      });
    } else {
      // Subsequent frames: reuse global palette
      const indexed = applyPalette(rgba, globalPalette, 'rgb565');
      // palette omitted → uses global color table from first frame
      encoder.writeFrame(indexed, w, h, {
        delay: delayMs,
      });
    }

    frameIdx++;
    if (onProgress && frameIdx % 5 === 0) {
      const elapsed = (performance.now() - startTime) / 1000;
      onProgress({
        phase: 'encoding',
        progress: 50,
        fps: Math.round(frameIdx / elapsed),
        etaSeconds: null,
        memoryMB: 0,
      });
    }
    frame.close();
  }

  encoder.finish();
  return encoder.bytes();
}
