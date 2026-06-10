// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * WebP frame encoding helper.
 *
 * Converts ImageData → WebP bytes using OffscreenCanvas when available.
 *
 * GPU-resident pipeline (preferred):
 *   ImageData → putImageData(OffscreenCanvas) → convertToBlob({webp})
 *
 * Fallback pipeline (no OffscreenCanvas):
 *   ImageData → canvas.putImageData → canvas.toBlob({webp})
 *
 * Note: putImageData is a GPU→CPU→GPU round-trip on most drivers.
 * For VideoFrame/ImageBitmap sources, prefer drawImage() directly on
 * OffscreenCanvas and skip the ImageData intermediate entirely.
 */

export function createWebPFrameEncoder(
  qualityRatio: number
): (frame: ImageData) => Promise<Uint8Array> {
  let offscreen: OffscreenCanvas | null = null;
  let offscreenCtx: OffscreenCanvasRenderingContext2D | null = null;
  let fallbackCanvas: HTMLCanvasElement | null = null;
  let fallbackCtx: CanvasRenderingContext2D | null = null;

  const useOffscreen = typeof OffscreenCanvas !== 'undefined';

  return async (frame: ImageData): Promise<Uint8Array> => {
    const quality = Math.min(1, Math.max(0, qualityRatio));

    if (useOffscreen) {
      // GPU-resident path: OffscreenCanvas + convertToBlob
      if (!offscreen) {
        offscreen = new OffscreenCanvas(frame.width, frame.height);
        offscreenCtx = offscreen.getContext('2d');
      }

      if (offscreen && offscreenCtx) {
        if (offscreen.width !== frame.width || offscreen.height !== frame.height) {
          offscreen.width = frame.width;
          offscreen.height = frame.height;
        }
        offscreenCtx.putImageData(frame, 0, 0);
        const blob = await offscreen.convertToBlob({
          type: 'image/webp',
          quality,
        });
        if (!blob || blob.size === 0) {
          throw new Error('WebP frame encoding produced an empty blob (OffscreenCanvas).');
        }
        const buffer = await blob.arrayBuffer();
        return new Uint8Array(buffer);
      }
    }

    // Fallback: HTMLCanvasElement + toBlob callback
    if (!fallbackCanvas) {
      fallbackCanvas = document.createElement('canvas');
      fallbackCanvas.width = frame.width;
      fallbackCanvas.height = frame.height;
      fallbackCtx = fallbackCanvas.getContext('2d', { alpha: false });
    }

    if (!fallbackCanvas || !fallbackCtx) {
      throw new Error('Canvas context unavailable for WebP frame encoding.');
    }

    if (fallbackCanvas.width !== frame.width || fallbackCanvas.height !== frame.height) {
      fallbackCanvas.width = frame.width;
      fallbackCanvas.height = frame.height;
    }

    fallbackCtx.putImageData(frame, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      fallbackCanvas!.toBlob(
        (result) => {
          if (result && result.size > 0) {
            resolve(result);
            return;
          }
          reject(new Error('Failed to encode WebP frame via toBlob.'));
        },
        'image/webp',
        quality
      );
    });

    const buffer = await blob.arrayBuffer();
    return new Uint8Array(buffer);
  };
}
