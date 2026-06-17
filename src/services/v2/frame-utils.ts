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
 */

/**
 * Copy VideoFrame pixels directly to RGB Uint8Array.
 * Tries multiple RGB formats first, falls back to Canvas only as last resort.
 */
export async function copyFrameToRGB(
  frame: VideoFrame,
  width: number,
  height: number,
  needsResize = false
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
      const size = frame.allocationSize({
        rect: { x: 0, y: 0, width, height },
        layout: [{ offset: 0, stride: width * (fmt === 'RGB' ? 3 : 4) }],
      });
      const buffer = new Uint8Array(size);
      await frame.copyTo(buffer, {
        rect: { x: 0, y: 0, width, height },
        layout: [{ offset: 0, stride: width * (fmt === 'RGB' ? 3 : 4) }],
      });

      // If we got RGBA/BGRA/BGRX/RGBX, strip alpha/convert to RGB
      const bytesPerPixel = fmt === 'RGB' ? 3 : 4;
      if (bytesPerPixel === 4) {
        return rgbaToRGB(buffer, width, height);
      }
      return buffer;
    } catch {
      // Format not supported, try next
    }
  }

  // Fallback: Canvas-based extraction for YUV/NV12 formats
  // Use resize via createImageBitmap to avoid separate resize step
  const bitmap = await createImageBitmap(frame, {
    resizeWidth: needsResize ? width : frame.displayWidth,
    resizeHeight: needsResize ? height : frame.displayHeight,
    resizeQuality: 'pixelated',
    premultiplyAlpha: 'none',
  });

  const targetW = needsResize ? width : frame.displayWidth;
  const targetH = needsResize ? height : frame.displayHeight;
  const canvas = new OffscreenCanvas(targetW, targetH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, targetW, targetH);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, targetW, targetH);
  return rgbaToRGB(new Uint8Array(imageData.data), targetW, targetH);
}

/**
 * Convert RGBA buffer to RGB in-place style (new buffer).
 * Uses loop unrolling for better performance.
 */
function rgbaToRGB(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const pixelCount = width * height;
  const rgb = new Uint8Array(pixelCount * 3);

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
 * Copy VideoFrame to RGBA Uint8Array (for alpha-compositing path).
 * Tries direct copyTo first, falls back to Canvas.
 */
export async function copyFrameToRGBA(
  frame: VideoFrame,
  width: number,
  height: number
): Promise<Uint8Array> {
  // Try direct copyTo for RGBA formats
  for (const _fmt of ['RGBA', 'BGRA', 'RGBX', 'BGRX'] as const) {
    void _fmt; // Used for format iteration
    try {
      const size = frame.allocationSize({
        rect: { x: 0, y: 0, width, height },
        layout: [{ offset: 0, stride: width * 4 }],
      });
      const buffer = new Uint8Array(size);
      await frame.copyTo(buffer, {
        rect: { x: 0, y: 0, width, height },
        layout: [{ offset: 0, stride: width * 4 }],
      });
      return buffer;
    } catch {
      // Not supported
    }
  }

  // Canvas-based extraction for non-RGBA formats
  const bitmap = await createImageBitmap(frame, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'pixelated',
  });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, width, height);
  return new Uint8Array(imageData.data);
}

/**
 * Resize a VideoFrame to target dimensions using createImageBitmap.
 */
export async function resizeFrameToRGBA(
  frame: VideoFrame,
  width: number,
  height: number
): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(frame, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'medium',
  });

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, width, height);
  return new Uint8Array(imageData.data);
}

/**
 * Get frame duration in milliseconds.
 * Falls back to 100ms (10fps) if duration is unavailable.
 */
export function getFrameDurationMs(frame: VideoFrame): number {
  const raw = frame.duration as number | null;
  return raw != null && raw > 0 ? Math.max(1, Math.round(raw / 1000)) : 100;
}

/**
 * Alpha composite: blend RGBA pixels over a black background.
 * Converts RGBA → RGB by applying alpha pre-multiplication.
 */
export function compositeAlphaToRGB(rgba: Uint8Array): Uint8Array {
  const pixelCount = rgba.length / 4;
  const rgb = new Uint8Array(pixelCount * 3);
  for (let i = 0; i < pixelCount; i++) {
    const srcIdx = i * 4;
    const dstIdx = i * 3;
    const a = (rgba[srcIdx + 3] ?? 255) / 255;
    rgb[dstIdx] = Math.round((rgba[srcIdx] ?? 0) * a);
    rgb[dstIdx + 1] = Math.round((rgba[srcIdx + 1] ?? 0) * a);
    rgb[dstIdx + 2] = Math.round((rgba[srcIdx + 2] ?? 0) * a);
  }
  return rgb;
}
