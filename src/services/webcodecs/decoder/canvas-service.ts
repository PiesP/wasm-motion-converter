// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Canvas helpers for WebCodecs frame capture.
 */
export type CaptureContext = {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  targetWidth: number;
  targetHeight: number;
  dispose: () => void;
};

/**
 * Create a canvas context for frame capture.
 */
export const createCanvas = (
  width: number,
  height: number,
  willReadFrequently: boolean = false,
  desynchronized: boolean = false
): CaptureContext => {
  // Prefer OffscreenCanvas when available.
  // In Chrome/Edge, OffscreenCanvas.convertToBlob() is typically faster and can reduce
  // main-thread blocking during PNG/JPEG encoding.
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const contextAttrs: CanvasRenderingContext2DSettings = { alpha: false };

    // desynchronized and willReadFrequently are incompatible — when
    // desynchronized is true, getImageData is unavailable, so we skip
    // willReadFrequently entirely.
    if (desynchronized) {
      contextAttrs.desynchronized = true;
    } else if (willReadFrequently) {
      contextAttrs.willReadFrequently = true;
    }

    const context = canvas.getContext('2d', contextAttrs);
    if (!context) {
      throw new Error('Canvas 2D context not available');
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    return {
      canvas,
      context,
      targetWidth: width,
      targetHeight: height,
      dispose() {
        // Release canvas references to allow GC of potentially large GPU/backing resources.
        // The context is invalidated once the canvas is dereferenced.
        canvas.width = 0;
        canvas.height = 0;
      },
    };
  }

  const hasDocument = typeof document !== 'undefined';
  if (!hasDocument) {
    throw new Error('Canvas rendering is not available in this environment.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently });
  if (!context) {
    throw new Error('Canvas 2D context not available');
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  return {
    canvas,
    context,
    targetWidth: width,
    targetHeight: height,
    dispose() {
      canvas.width = 0;
      canvas.height = 0;
    },
  };
};

/**
 * Create a desynchronized canvas context for frame capture.
 *
 * Uses `desynchronized: true` on the 2D context which allows the browser to
 * paint the canvas independently of the event loop, reducing latency for
 * GPU-backed operations like drawImage + convertToBlob.
 *
 * **Important:** `getImageData()` is NOT available on a desynchronized
 * context. Only use this when the canvas is used for drawImage followed by
 * convertToBlob (or toBlob) — never for RGBA/pixel-readback paths.
 *
 * Supported in Chrome 80+, Firefox 113+, Safari 16.4+.
 */
export const createDesynchronizedCanvas = (width: number, height: number): CaptureContext => {
  return createCanvas(width, height, false, true);
};

/**
 * Convert a canvas to a Blob.
 */
export const canvasToBlob = async (
  canvas: OffscreenCanvas | HTMLCanvasElement,
  mimeType: string,
  quality?: number
): Promise<Blob> => {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type: mimeType, quality });
  }

  const htmlCanvas = canvas as HTMLCanvasElement;
  return new Promise<Blob>((resolve, reject) => {
    htmlCanvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        reject(new Error('Failed to capture frame'));
      },
      mimeType,
      quality
    );
  });
};
