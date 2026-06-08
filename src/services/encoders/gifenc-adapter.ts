// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Experimental gifenc adapter — lightweight pure-JS GIF encoder.
 *
 * gifenc (by mattdesl) is a ~3KB pure-JavaScript GIF encoder with zero
 * WASM or native dependencies. It uses NeuQuant-based palette quantization.
 *
 * This adapter is NOT wired into the main conversion pipeline. It exists
 * as a research spike to evaluate gifenc as a potential replacement for
 * modern-gif (~20KB) in the "no FFmpeg WASM" path.
 *
 * To install: pnpm add gifenc
 *
 * @see https://github.com/mattdesl/gifenc
 */

import { convertFramesToImageData } from '@services/encoders/frame-converter-service';
import type { EncoderFrame } from '@t/conversion-types';

export interface GifencOptions {
  /** Frame width in pixels */
  width: number;
  /** Frame height in pixels */
  height: number;
  /** Target frames per second */
  fps: number;
  /** Maximum palette colors (2-256, default 256) */
  colors?: number;
  /** Progress callback */
  onProgress?: (current: number, total: number) => void;
  /** Cancellation check */
  shouldCancel?: () => boolean;
}

/**
 * Encode frames to animated GIF using gifenc.
 *
 * This is an EXPERIMENTAL function. It requires the 'gifenc' package
 * to be installed. If the package is not available, it throws.
 *
 * @throws If gifenc package is not installed
 */
export async function encodeGifWithGifenc(
  frames: EncoderFrame[],
  options: GifencOptions
): Promise<Blob> {
  // Dynamic import — gifenc is an optional peer dependency
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');

  const { width, height, fps, colors = 256, onProgress, shouldCancel } = options;

  if (!frames.length) {
    throw new Error('No frames provided for gifenc encoding');
  }

  if (shouldCancel?.()) {
    throw new Error('Conversion cancelled by user');
  }

  const delay = Math.max(10, Math.round(1000 / Math.max(1, fps)));

  // Convert EncoderFrame[] to ImageData[] — same path as modern-gif
  const imageDataFrames = await convertFramesToImageData(
    frames,
    width,
    height,
    undefined,
    shouldCancel
  );

  if (shouldCancel?.()) {
    throw new Error('Conversion cancelled by user');
  }

  // Generate global palette from first frame (NeuQuant algorithm)
  const palette = quantize(imageDataFrames[0]!.data, colors);

  const gif = GIFEncoder();

  for (let i = 0; i < imageDataFrames.length; i += 1) {
    if (shouldCancel?.()) {
      throw new Error('Conversion cancelled by user');
    }

    onProgress?.(i + 1, imageDataFrames.length);

    const indexed = applyPalette(imageDataFrames[i]!, palette, 'rgb');
    gif.writeFrame(indexed, delay, palette);
  }

  gif.finish();

  return new Blob([gif.bytes() as BlobPart], { type: 'image/gif' });
}

/**
 * Check whether the gifenc package can be loaded.
 * Does NOT install the package — only checks dynamic import availability.
 */
export async function isGifencSupported(): Promise<boolean> {
  try {
    await import('gifenc');
    return true;
  } catch {
    return false;
  }
}
