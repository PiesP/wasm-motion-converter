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
 *
 * Strategy:
 * 1. Try native RGB output via copyTo({ format: 'RGB' }) — avoids RGBA→RGB conversion entirely.
 *    Supported in Chrome 114+, Firefox 130+.
 * 2. Fall back to 4-channel formats (RGBX/BGRX/RGBA/BGRA) + fast Uint32Array RGBA→RGB.
 * 3. Last resort: OffscreenCanvas for exotic YUV/NV12 formats.
 *
 * Uses buffer pooling for all copyTo target buffers.
 */
export async function copyFrameToRGB(
  frame: VideoFrame,
  width: number,
  height: number
): Promise<Uint8Array> {
  // ── Strategy 1: Native RGB output (zero-conversion path) ──
  // Chrome 114+ / Firefox 130+ support format:'RGB' in copyTo options.
  // This lets the browser's native code handle YUV→RGB conversion + packing.
  try {
    const size = width * height * 3;
    const buffer = globalBufferPool.acquire(size);
    const layout = await frame.copyTo(buffer, {
      rect: { x: 0, y: 0, width, height },
      layout: [{ offset: 0, stride: width * 3 }],
      format: 'RGB' as VideoFrameCopyToOptions['format'],
    });
    // Verify we actually got RGB data (3 bytes per pixel)
    if (layout && layout[0]?.stride === width * 3) {
      return buffer;
    }
    // Unexpected layout — release and fall through
    globalBufferPool.release(buffer);
  } catch {
    // format:'RGB' not supported, fall through to 4-channel path
  }

  // ── Strategy 2: 4-channel formats + fast Uint32Array RGBA→RGB ──
  const fourChannelFormats: Array<'RGBX' | 'BGRX' | 'RGBA' | 'BGRA'> = [
    'RGBX',
    'BGRX',
    'RGBA',
    'BGRA',
  ];

  for (const fmt of fourChannelFormats) {
    try {
      const size = frame.allocationSize({
        rect: { x: 0, y: 0, width, height },
        layout: [{ offset: 0, stride: width * 4 }],
      });
      const buffer = globalBufferPool.acquire(size);
      await frame.copyTo(buffer, {
        rect: { x: 0, y: 0, width, height },
        layout: [{ offset: 0, stride: width * 4 }],
      });

      const rgb = rgbaToRGBFast(buffer, width, height, fmt);
      globalBufferPool.release(buffer);
      return rgb;
    } catch {
      // Format not supported, try next
    }
  }

  // ── Strategy 3: Canvas fallback for exotic formats ──
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to get 2d context from OffscreenCanvas');
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
  const rgb = rgbaToRGBFast(rgbaBuf, width, height, 'RGBA');
  return rgb;
}

/**
 * Fast RGBA→RGB conversion using Uint32Array bitwise operations.
 *
 * Reads 4 bytes at a time as a single uint32, then extracts R/G/B with bit shifts.
 * ~2-3x faster than per-pixel byte copying for large frames.
 *
 * @param src - Source 4-channel buffer (RGBA, BGRA, RGBX, or BGRX)
 * @param width - Frame width in pixels
 * @param height - Frame height in pixels
 * @param format - Source channel order
 * @returns New RGB buffer (pooled)
 */
function rgbaToRGBFast(
  src: Uint8Array,
  width: number,
  height: number,
  format: 'RGBA' | 'BGRA' | 'RGBX' | 'BGRX'
): Uint8Array {
  const pixelCount = width * height;
  const dst = globalBufferPool.acquire(pixelCount * 3);

  // Use Uint32Array view for 4-byte-at-a-time reads
  const src32 = new Uint32Array(src.buffer, src.byteOffset, pixelCount);
  const len = pixelCount;

  if (format === 'RGBA' || format === 'RGBX') {
    // RGBA: R=byte0, G=byte1, B=byte2, A/X=byte3 (little-endian: 0xAABBGGRR in uint32)
    // We need bytes 0,1,2 → copy with alpha skip
    for (let i = 0; i < len; i++) {
      const v = src32[i]!;
      const dstIdx = i * 3;
      dst[dstIdx] = v & 0xff; // R
      dst[dstIdx + 1] = (v >> 8) & 0xff; // G
      dst[dstIdx + 2] = (v >> 16) & 0xff; // B
    }
  } else {
    // BGRA/BGRX: B=byte0, G=byte1, R=byte2, A/X=byte3
    for (let i = 0; i < len; i++) {
      const v = src32[i]!;
      const dstIdx = i * 3;
      dst[dstIdx] = (v >> 16) & 0xff; // R (from byte 2)
      dst[dstIdx + 1] = (v >> 8) & 0xff; // G (from byte 1)
      dst[dstIdx + 2] = v & 0xff; // B (from byte 0)
    }
  }

  return dst;
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
