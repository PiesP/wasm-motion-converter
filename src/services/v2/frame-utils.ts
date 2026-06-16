// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Frame Processing Utilities
 *
 * Zero-copy frame processing: VideoFrame → ArrayBuffer directly,
 * avoiding the ImageBitmap → Canvas → getImageData pipeline.
 */

/**
 * Copy VideoFrame pixels directly to an ArrayBuffer.
 * This avoids the 3-step ImageBitmap → Canvas → getImageData pipeline.
 *
 * @param frame - VideoFrame to copy
 * @param width - Target width (for resize)
 * @param height - Target height (for resize)
 * @returns Uint8Array of RGBA pixel data
 */
export async function copyFrameToRGBA(
  frame: VideoFrame,
  width: number,
  height: number
): Promise<Uint8Array> {
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
}

/**
 * Copy VideoFrame to RGBA, then strip alpha to RGB.
 * Uses direct VideoFrame.copyTo() — no intermediate allocations.
 *
 * @param frame - VideoFrame to copy
 * @param width - Target width
 * @param height - Target height
 * @returns Uint8Array of RGB pixel data (3 bytes per pixel)
 */
export async function copyFrameToRGB(
  frame: VideoFrame,
  width: number,
  height: number
): Promise<Uint8Array> {
  const rgba = await copyFrameToRGBA(frame, width, height);
  const pixelCount = width * height;
  const rgb = new Uint8Array(pixelCount * 3);

  // RGBA → RGB: skip every 4th byte (alpha)
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
 * Returns RGBA pixel data.
 *
 * @param frame - Source VideoFrame
 * @param width - Target width
 * @param height - Target height
 * @returns Uint8Array of RGBA pixel data
 */
export async function resizeFrameToRGBA(
  frame: VideoFrame,
  width: number,
  height: number
): Promise<Uint8Array> {
  // Use createImageBitmap with resize for GPU-accelerated scaling
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
 * This avoids dark artifacts where alpha < 255.
 *
 * @param rgba - RGBA pixel data (4 bytes per pixel)
 * @returns RGB pixel data (3 bytes per pixel)
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
