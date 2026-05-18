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

/**
 * WebCodecs Decoder Types
 *
 * Shared types used by WebCodecs decoder helpers and the public
 * WebCodecsDecoderService API.
 */

/** Frame format type for WebCodecs output */
export type WebCodecsFrameFormat = 'png' | 'jpeg' | 'rgba' | 'bitmap';

/** Progress callback type for frame extraction */
export type WebCodecsProgressCallback = (current: number, total: number) => void;

/** Capture mode for WebCodecs frame extraction */
export type WebCodecsCaptureMode = 'auto' | 'demuxer' | 'frame-callback' | 'seek' | 'track';

/** Frame payload delivered to onFrame callback */
export interface WebCodecsFramePayload {
  name: string;
  data?: Uint8Array;
  imageData?: ImageData;
  bitmap?: ImageBitmap;
  index: number;
  timestamp: number;
}

/** Options for WebCodecs video decoding */
export interface WebCodecsDecodeOptions {
  file: File;
  targetFps: number;
  scale: number;
  frameFormat: WebCodecsFrameFormat;
  frameQuality: number;
  framePrefix: string;
  frameDigits: number;
  frameStartNumber: number;
  maxFrames?: number;
  captureMode?: WebCodecsCaptureMode;
  disableDemuxer?: boolean;
  codec?: string;
  quality?: 'low' | 'medium' | 'high';
  onFrame: (frame: WebCodecsFramePayload) => Promise<void>;
  onProgress?: (current: number, total: number) => void;
  shouldCancel?: () => boolean;
}

/** Result of WebCodecs video decoding */
export interface WebCodecsDecodeResult {
  frameFiles: string[];
  frameCount: number;
  captureModeUsed?: WebCodecsCaptureMode;
  width: number;
  height: number;
  fps: number;
  duration: number;
}
