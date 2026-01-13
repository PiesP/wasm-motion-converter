/**
 * WebP Encoder Worker
 *
 * Worker thread for encoding video frames to WebP format using browser's
 * native OffscreenCanvas API. Enables parallel frame encoding across
 * multiple workers for improved performance.
 *
 * Features:
 * - OffscreenCanvas-based WebP encoding
 * - Quality control (0.0 to 1.0)
 * - Transferable ArrayBuffer results
 * - Comlink RPC interface
 *
 * Architecture:
 * Main thread → Worker (via Comlink) → OffscreenCanvas.convertToBlob() → ArrayBuffer
 */

import { logger } from '@utils/logger';
import * as Comlink from 'comlink';

let cachedCanvas: OffscreenCanvas | null = null;
let cachedContext: OffscreenCanvasRenderingContext2D | null = null;

const getCanvas = (width: number, height: number): OffscreenCanvasRenderingContext2D => {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas not available in worker');
  }

  if (
    !cachedCanvas ||
    !cachedContext ||
    cachedCanvas.width !== width ||
    cachedCanvas.height !== height
  ) {
    cachedCanvas = new OffscreenCanvas(width, height);
    cachedContext = cachedCanvas.getContext('2d', { alpha: false });
    if (!cachedContext) {
      throw new Error('Failed to get 2D context from OffscreenCanvas');
    }
    cachedContext.imageSmoothingEnabled = true;
    cachedContext.imageSmoothingQuality = 'high';
  }

  return cachedContext;
};

/**
 * WebP encoder worker API implementation
 *
 * Exposes encodeFrame method via Comlink for main thread communication.
 */
const api = {
  /**
   * Encode single frame to WebP format
   *
   * Uses OffscreenCanvas.convertToBlob() for native WebP encoding.
   * This is hardware-accelerated in most modern browsers.
   *
   * @param imageData - Frame pixel data (RGBA format)
   * @param quality - Encoding quality (0.0 to 1.0, where 1.0 is best quality)
   * @returns Encoded WebP frame as ArrayBuffer
   * @throws {Error} If encoding fails or OffscreenCanvas is not available
   */
  async encodeFrame(
    imageData: { data: Uint8ClampedArray; width: number; height: number },
    quality: number
  ): Promise<ArrayBuffer> {
    try {
      // Validate input
      if (!imageData || !imageData.data || imageData.width <= 0 || imageData.height <= 0) {
        throw new Error('Invalid image data for WebP encoding');
      }

      // Clamp quality to valid range
      const clampedQuality = Math.max(0, Math.min(1, quality));

      const ctx = getCanvas(imageData.width, imageData.height);

      // Create ImageData from raw data
      // Ensure the backing buffer is an ArrayBuffer (not SharedArrayBuffer) for ImageData typing/runtime.
      const imgData = new ImageData(
        new Uint8ClampedArray(imageData.data),
        imageData.width,
        imageData.height
      );

      // Draw to canvas
      ctx.putImageData(imgData, 0, 0);

      // Encode to WebP
      const blob = await cachedCanvas?.convertToBlob({
        type: 'image/webp',
        quality: clampedQuality,
      });

      if (!blob) {
        throw new Error('Failed to encode WebP frame (no blob returned)');
      }

      // Convert Blob to ArrayBuffer
      const arrayBuffer = await blob.arrayBuffer();

      logger.debug('webp-encoder', 'Frame encoded', {
        width: imageData.width,
        height: imageData.height,
        quality: clampedQuality,
        size: arrayBuffer.byteLength,
      });

      return arrayBuffer;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('webp-encoder', 'Frame encoding failed', {
        error: message,
        width: imageData?.width,
        height: imageData?.height,
      });
      throw new Error(`WebP frame encoding failed: ${message}`);
    }
  },

  /**
   * Encode a single ImageBitmap frame to WebP.
   *
   * This avoids explicit GPU→CPU readback in the caller.
   */
  async encodeFrameBitmap(bitmap: ImageBitmap, quality: number): Promise<ArrayBuffer> {
    try {
      if (!bitmap || bitmap.width <= 0 || bitmap.height <= 0) {
        throw new Error('Invalid ImageBitmap for WebP encoding');
      }

      const clampedQuality = Math.max(0, Math.min(1, quality));
      const width = bitmap.width;
      const height = bitmap.height;
      const ctx = getCanvas(width, height);

      try {
        ctx.drawImage(bitmap, 0, 0, width, height);
      } finally {
        // If the bitmap was transferred to this worker, closing it here releases GPU memory.
        try {
          bitmap.close();
        } catch {
          // Ignore: bitmap might already be closed.
        }
      }

      const blob = await cachedCanvas?.convertToBlob({
        type: 'image/webp',
        quality: clampedQuality,
      });

      if (!blob) {
        throw new Error('Failed to encode WebP frame (no blob returned)');
      }

      const arrayBuffer = await blob.arrayBuffer();

      logger.debug('webp-encoder', 'Bitmap frame encoded', {
        width,
        height,
        quality: clampedQuality,
        size: arrayBuffer.byteLength,
      });

      return arrayBuffer;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('webp-encoder', 'Bitmap frame encoding failed', {
        error: message,
        width: bitmap?.width,
        height: bitmap?.height,
      });
      throw new Error(`WebP bitmap frame encoding failed: ${message}`);
    }
  },

  /**
   * Terminate the worker and clean up resources
   *
   * Closes the worker context. Must be called from main thread
   * when the worker is no longer needed.
   */
  terminate(): void {
    logger.debug('webp-encoder', 'Worker terminating');
    self.close();
  },
};

// Expose API via Comlink for main thread communication
Comlink.expose(api);
