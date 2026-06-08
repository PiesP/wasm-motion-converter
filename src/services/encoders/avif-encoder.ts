// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Experimental AVIF animation support.
 *
 * AVIF (AV1 Image File Format) offers 20-30% better compression than WebP
 * at equivalent quality. However, encoding is CPU-intensive and Firefox
 * does not support animated AVIF (only still images).
 *
 * This module provides capability detection so the UI can gate the AVIF
 * format option. Actual encoding is done via the existing FFmpeg WASM
 * path using libaom-av1.
 *
 * Browser support (animation): Chrome 85+, Safari 16.1+, Edge 121+
 * Not supported (animation): Firefox (all versions as of 2026)
 */

let cachedSupport: boolean | null = null;

/**
 * Check if the browser can decode animated AVIF.
 *
 * Uses a tiny 1×1 animated AVIF data URL to test decode support.
 * Result is cached for the lifetime of the page.
 */
export async function isAvifAnimationSupported(): Promise<boolean> {
  if (cachedSupport !== null) return cachedSupport;

  // Minimal animated AVIF — 1 frame, 1×1 pixel, AV1 encoded
  // This is a valid AVIF container that any AVIF decoder should handle.
  const testImage = new Image();
  const result = await new Promise<boolean>((resolve) => {
    testImage.onload = () => resolve(true);
    testImage.onerror = () => resolve(false);
    // 30-second timeout in case of network stall
    setTimeout(() => resolve(false), 30_000);

    // Animated AVIF test image (1×1, 1 frame)
    testImage.src =
      'data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAAB0AAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQ0MAAAAABNjb2xybmNseAABAA0ABoAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACVtZGF0EgAKCBgANogQEAwgMg8f8D///8WfhwB8+ErK42A=';
  });

  cachedSupport = result;
  return result;
}

/**
 * Check whether the browser's WebCodecs VideoEncoder supports AV1 encoding.
 *
 * This is relevant for GPU-accelerated AVIF encoding (future path).
 * Currently, AVIF encoding goes through FFmpeg WASM.
 */
export async function isAv1EncodingSupported(): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false;

  try {
    const config: VideoEncoderConfig = {
      codec: 'av01.0.04M.08',
      width: 64,
      height: 64,
    };
    const support = await VideoEncoder.isConfigSupported(config);
    return support.supported === true;
  } catch {
    return false;
  }
}
