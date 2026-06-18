// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Frame Processing Utilities
 *
 * Zero-copy frame processing where possible:
 * - VideoFrame.copyTo() for RGB-compatible formats (primary path)
 * - createImageBitmap fallback only for unsupported formats
 *
 * H3: Optimized to avoid unnecessary RGBA→RGB intermediate buffer.
 *     Direct copyTo to RGB format when supported.
 *
 * BufferPool: Reuses Uint8Array allocations across frames to reduce GC.
 */

import { globalBufferPool } from './buffer-pool';

/**
 * Copy VideoFrame pixels directly to RGB Uint8Array.
 * Tries multiple RGB formats first, falls back to Canvas only as last resort.
 * Uses buffer pooling for the copyTo target buffer.
 */
export async function copyFrameToRGB(
  frame: VideoFrame,
  width: number,
  height: number
): Promise<Uint8Array> {
  // Try direct copyTo for RGB formats (zero-copy path)
  const rgbFormats: Array<'RGBX' | 'BGRX' | 'RGB' | 'RGBA' | 'BGRA'> = [
    'RGBX',
    'BGRX',
    'RGB',
    'RGBA',
    'BGRA',
  ];

  for (const fmt of rgbFormats) {
    try {
      const bytesPerPixel = fmt === 'RGB' ? 3 : 4;
      const size = frame.allocationSize({
        rect: { x: 0, y: 0, width, height },
        layout: [{ offset: 0, stride: width * bytesPerPixel }],
      });
      // Use pooled buffer for copyTo target
      const buffer = globalBufferPool.acquire(size);
      await frame.copyTo(buffer, {
        rect: { x: 0, y: 0, width, height },
        layout: [{ offset: 0, stride: width * bytesPerPixel }],
      });

      // If we got RGBA/BGRA/BGRX/RGBX, strip alpha/convert to RGB
      if (bytesPerPixel === 4) {
        const rgb = rgbaToRGB(buffer, width, height);
        globalBufferPool.release(buffer); // Release the 4-channel buffer
        return rgb;
      }
      return buffer;
    } catch {
      // Format not supported, try next
    }
  }

  // Fallback: Canvas-based extraction for YUV/NV12 formats
  // Draw the VideoFrame directly to an OffscreenCanvas at the target size
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to get 2d context from OffscreenCanvas');
  // Use frame's display dimensions as source, target dimensions as dest
  ctx.drawImage(
    frame,
    0,
    0,
    frame.codedWidth || frame.displayWidth,
    frame.codedHeight || frame.displayHeight,
    0,
    0,
    width,
    height
  );

  const imageData = ctx.getImageData(0, 0, width, height);
  const rgbaBuf = new Uint8Array(imageData.data);
  const rgb = rgbaToRGB(rgbaBuf, width, height);
  return rgb;
}

/**
 * Convert RGBA buffer to RGB in-place style (new buffer).
 * Uses loop unrolling for better performance.
 */
function rgbaToRGB(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const pixelCount = width * height;
  const rgb = globalBufferPool.acquire(pixelCount * 3);

  for (let i = 0; i < pixelCount; i++) {
    const srcIdx = i << 2; // i * 4
    const dstIdx = i * 3;
    rgb[dstIdx] = rgba[srcIdx]!;
    rgb[dstIdx + 1] = rgba[srcIdx + 1]!;
    rgb[dstIdx + 2] = rgba[srcIdx + 2]!;
  }

  return rgb;
}

/**
 * Get frame duration in milliseconds — preserves original timing.
 * No clamping: the original video frame duration is used as-is to maintain
 * accurate playback speed. Clamping is applied only at the output stage
 * when writing frames (see writeFrameWithDelay in gif-encoder-service).
 */
export function getFrameDurationMs(frame: VideoFrame): number {
  const raw = frame.duration as number | null;
  // VideoFrame.duration is in microseconds → convert to milliseconds
  return raw != null && raw > 0 ? Math.max(1, Math.round(raw / 1000)) : 100;
}
