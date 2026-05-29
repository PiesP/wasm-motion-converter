// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Frame Format Conversion Utilities
 *
 * Provides helpers to convert between VideoFrame, ImageBitmap, and ImageData.
 * Supports both GPU-accelerated (VideoFrame, ImageBitmap) and CPU (ImageData) formats.
 *
 * Performance hierarchy (fastest to slowest):
 * 1. VideoFrame (GPU-resident, no copy)
 * 2. ImageBitmap (GPU-resident, minimal copy)
 * 3. ImageData (CPU-resident, full GPU→CPU transfer)
 *
 * @example
 * // Convert single frame
 * const imageData = await frameToImageData(videoFrame, canvas, context);
 *
 * // Convert array of frames
 * const imageDataArray = await convertFramesToImageData(videoFrames, width, height);
 */

import type { EncoderFrame } from '@t/conversion-types';

const FRAME_CONVERSION_CANCELLED = 'Frame conversion cancelled';
const FRAME_UNDEFINED_ERROR = 'Frame at index is undefined';
const FRAME_CONVERSION_CONTEXT_ERROR = 'Failed to create 2D canvas context for frame conversion';

// Buffer pool for VideoFrame.copyTo() — avoids per-frame Uint8ClampedArray allocation.
// Triple-buffering prevents GC in async chains where a previous buffer may still
// be in use by an in-flight ImageData consumer.
const BUFFER_POOL_MAX = 3;
const bufferPool: Uint8ClampedArray[] = [];

function acquireBuffer(sizeBytes: number): Uint8ClampedArray {
  const idx = bufferPool.findIndex((buf) => buf.length === sizeBytes);
  if (idx !== -1) {
    return bufferPool.splice(idx, 1)[0]!;
  }
  return new Uint8ClampedArray(sizeBytes);
}

function releaseBuffer(buf: Uint8ClampedArray): void {
  if (bufferPool.length < BUFFER_POOL_MAX) {
    bufferPool.push(buf);
  }
  // else: pool full — let GC collect
}

/**
 * Convert a single frame to ImageData
 *
 * Handles VideoFrame, ImageBitmap, and ImageData inputs. Uses canvas
 * for GPU-accelerated conversion when possible.
 *
 * @param frame - Frame to convert (VideoFrame, ImageBitmap, or ImageData)
 * @param canvas - Canvas element for GPU operations
 * @param context - 2D rendering context
 * @returns ImageData representation of the frame
 *
 * @example
 * const canvas = document.createElement('canvas');
 * const context = canvas.getContext('2d')!;
 * const imageData = await frameToImageData(videoFrame, canvas, context);
 */
export async function frameToImageData(
  frame: EncoderFrame,
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D
): Promise<ImageData> {
  // Fast path: already ImageData
  if (frame instanceof ImageData) {
    return frame;
  }

  // Get frame dimensions
  const width = 'displayWidth' in frame ? frame.displayWidth : frame.width;
  const height = 'displayHeight' in frame ? frame.displayHeight : frame.height;

  // Ensure canvas is correct size
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  // VideoFrame path: try VideoFrame.copyTo() first (fastest)
  if ('format' in frame && 'copyTo' in frame) {
    try {
      // Use pooled buffer to avoid per-frame allocation
      const sizeBytes = width * height * 4;
      const buffer = acquireBuffer(sizeBytes);
      await (frame as VideoFrame).copyTo(buffer, {
        rect: { x: 0, y: 0, width, height },
      });
      // ImageData constructor copies the buffer, safe to release back to pool
      const imageData = new ImageData(
        buffer as unknown as Uint8ClampedArray<ArrayBuffer>,
        width,
        height
      );
      releaseBuffer(buffer);
      return imageData;
    } catch (_error) {
      // copyTo() not supported or failed - fall through to canvas path
      // (This is expected on some browsers/formats)
    }
  }

  // Canvas path: draw to canvas then read pixels (slower but universal)
  // Works for both VideoFrame and ImageBitmap
  context.drawImage(frame as CanvasImageSource, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

/**
 * Convert array of frames to ImageData array
 *
 * Batch converts multiple frames with a single canvas allocation.
 * Reuses canvas and context across all frames for efficiency.
 *
 * Note: This does NOT close VideoFrames - caller must close them after encoding.
 *
 * @param frames - Array of frames to convert
 * @param width - Frame width
 * @param height - Frame height
 * @param onProgress - Optional progress callback (current, total)
 * @param shouldCancel - Optional cancellation check
 * @returns Promise resolving to ImageData array
 * @throws {Error} If conversion is cancelled
 *
 * @example
 * const imageDataArray = await convertFramesToImageData(
 *   videoFrames,
 *   640,
 *   480,
 *   (current, total) => logger.debug('encoders', 'Frame conversion progress', { current, total }),
 *   () => cancelRequested
 * );
 */
export async function convertFramesToImageData(
  frames: EncoderFrame[],
  width: number,
  height: number,
  onProgress?: (current: number, total: number) => void,
  shouldCancel?: () => boolean
): Promise<ImageData[]> {
  // Fast path: all frames already ImageData
  const allImageData = frames.every((f) => f instanceof ImageData);
  if (allImageData) {
    return frames as ImageData[];
  }

  // Create shared canvas for conversions
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', {
    alpha: false,
    willReadFrequently: true,
  });

  if (!context) {
    throw new Error(FRAME_CONVERSION_CONTEXT_ERROR);
  }

  // Convert each frame
  const imageDataArray: ImageData[] = [];

  for (let i = 0; i < frames.length; i++) {
    // Check cancellation
    if (shouldCancel?.()) {
      throw new Error(FRAME_CONVERSION_CANCELLED);
    }

    const frame = frames[i];
    if (!frame) {
      throw new Error(`${FRAME_UNDEFINED_ERROR}: ${i}`);
    }
    const imageData = await frameToImageData(frame, canvas, context);
    imageDataArray.push(imageData);

    // Report progress
    onProgress?.(i + 1, frames.length);
  }

  return imageDataArray;
}
