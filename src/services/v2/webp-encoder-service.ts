import type { WebPAnimationFrame, WebPConfig } from 'wasm-webp';
import { encodeAnimation } from 'wasm-webp';
import type { ConversionProgress } from '@/types/v2-conversion-types';
import { frameToImageBitmap } from './transfer-utils';

export interface WebpEncodeOptions {
  width: number;
  height: number;
  quality: 'low' | 'medium' | 'high';
  scale: number;
}

/**
 * Quality → WebP quality value mapping.
 *
 * wasm-webp's encodeAnimation accepts quality in the range 0–100
 * via the per-frame WebPConfig.quality field.
 */
const QUALITY_MAP: Record<WebpEncodeOptions['quality'], number> = {
  low: 50,
  medium: 75,
  high: 95,
};

export type WebpProgressCallback = (progress: ConversionProgress) => void;

/**
 * Encode an async stream of {@link VideoFrame}s into an animated WebP
 * {@link Uint8Array} using the wasm-webp library's `encodeAnimation()`.
 *
 * Each frame is rendered through an {@link OffscreenCanvas} to the target
 * dimensions (`opts.width × opts.height × opts.scale`), then the RGB pixel
 * data is extracted and fed to the WebP animation encoder. Alpha is stripped
 * to produce smaller output (matching GIF-like behavior).
 *
 * @returns The encoded animated WebP bytes.
 */
export async function encodeWebp(
  frameStream: AsyncGenerator<VideoFrame, void, void>,
  opts: WebpEncodeOptions,
  onProgress?: WebpProgressCallback
): Promise<Uint8Array> {
  const w = Math.floor(opts.width * opts.scale);
  const h = Math.floor(opts.height * opts.scale);

  const quality = QUALITY_MAP[opts.quality];
  const webpConfig: WebPConfig = { lossless: 0, quality };

  const frames: WebPAnimationFrame[] = [];
  let frameIdx = 0;
  const startTime = performance.now();

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;

  for await (const frame of frameStream) {
    // Convert VideoFrame → ImageBitmap → draw to target-sized canvas
    const bitmap = await frameToImageBitmap(frame);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();

    const imageData = ctx.getImageData(0, 0, w, h);

    // Strip alpha channel: RGBA (4 bytes/pixel) → RGB (3 bytes/pixel)
    const pixelCount = w * h;
    const rgbData = new Uint8Array(pixelCount * 3);
    const src = imageData.data;
    for (let i = 0; i < pixelCount; i++) {
      const srcIdx = i * 4;
      const dstIdx = i * 3;
      rgbData[dstIdx] = src[srcIdx]!; // R
      rgbData[dstIdx + 1] = src[srcIdx + 1]!; // G
      rgbData[dstIdx + 2] = src[srcIdx + 2]!; // B
    }

    // VideoFrame.duration is in microseconds; WebP frame duration is in
    // milliseconds. Guard against 0 or null duration with a fallback.
    const rawDuration = frame.duration as number | null;
    const durationMs =
      rawDuration != null && rawDuration > 0 ? Math.max(1, Math.round(rawDuration / 1000)) : 100; // fallback: 100 ms ≈ 10 fps

    frames.push({
      data: rgbData,
      duration: durationMs,
      config: webpConfig,
    });

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

  const result = await encodeAnimation(w, h, false, frames);

  if (!result) {
    throw new Error('wasm-webp encodeAnimation returned null');
  }

  return result;
}
