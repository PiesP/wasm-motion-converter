/**
 * Video Pipeline Types
 *
 * Shared types for the next-generation browser video pipeline.
 *
 * Notes:
 * - This module is intentionally framework-agnostic.
 * - Avoid importing Web APIs here when possible to keep it test-friendly.
 */

/**
 * Cached video capabilities detected at runtime.
 *
 * Stored in localStorage under `video_caps_v4` and exposed on `window.__VIDEO_CAPS__`.
 */
export interface VideoCapabilities {
  h264: boolean;
  hevc: boolean;
  av1: boolean;

  /** WebP encoding support via HTMLCanvasElement.toBlob('image/webp'). */
  canvasWebpEncode: boolean;

  /** WebP encoding support via OffscreenCanvas.convertToBlob({ type: 'image/webp' }). */
  offscreenWebpEncode: boolean;

  /** Backward-compatible aggregate flag: any WebP encode path available. */
  webpEncode: boolean;
  hardwareAccelerated: boolean;

  // Optional per-codec hardware decode hints.
  // These are best-effort signals derived from VideoDecoder.isConfigSupported() with
  // hardwareAcceleration: 'prefer-hardware'. They are not guaranteed to imply true GPU decode,
  // but are useful as additional strategy inputs.
  h264HardwareDecode?: boolean;
  hevcHardwareDecode?: boolean;
  av1HardwareDecode?: boolean;
}

/**
 * Container formats supported by the pipeline selector.
 */
export type ContainerFormat = 'mp4' | 'mov' | 'm4v' | 'webm' | 'mkv' | 'avi' | 'wmv' | 'unknown';

// NOTE: Worker message types were removed in a refactor.
// The ffmpeg.worker.ts was a stub that never worked.
