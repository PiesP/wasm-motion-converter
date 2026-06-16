// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Frame Processing Utilities
 *
 * Zero-copy frame processing where possible:
 * - VideoFrame.copyTo() for RGBA-compatible formats
 * - createImageBitmap fallback for native YUV formats
 */

/**
 * Copy VideoFrame pixels to RGBA Uint8Array.
 * Tries direct copyTo first, falls back to Canvas for non-RGBA formats.
 */
export async function copyFrameToRGBA(
  frame: VideoFrame,
  width: number,
  height: number
): Promise<Uint8Array> {
  // Try direct copyTo for RGBA-format frames
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
    // Fallback for non-RGBA formats (NV12, YUV, etc.)
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
 * Copy VideoFrame to RGB (strip alpha).
 */
export async function copyFrameToRGB(
  frame: VideoFrame,
  width: number,
  height: number
): Promise<Uint8Array> {
  const rgba = await copyFrameToRGBA(frame, width, height);
  const pixelCount = width * height;
  const rgb = new Uint8Array(pixelCount * 3);

  for (let i = 0; i < pixelCount; i++) {
    const srcIdx = i * 4;
    const dstIdx = i * 3;
    rgb[dstIdx] = rgba[srcIdx]!;
    rgb[dstIdx + 1] = rgba[srcIdx + 1]!;
    rgb[dstIdx + 2] = rgba[srcIdx + 2]!;
  }

  return rgb;
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
