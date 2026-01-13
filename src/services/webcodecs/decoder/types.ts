/**
 * WebCodecs Decoder Types
 *
 * Shared types used by WebCodecs decoder helpers and the public
 * WebCodecsDecoderService API.
 */

import type { VideoMetadata } from '@t/conversion-types';

/**
 * Frame format type for WebCodecs output
 * - png: PNG format (lossless, larger file size)
 * - jpeg: JPEG format (lossy compression, smaller file size)
 * - rgba: Raw RGBA pixel data (for in-memory processing)
 * - bitmap: ImageBitmap (GPU-friendly, avoids explicit CPU readback)
 */
export type WebCodecsFrameFormat = 'png' | 'jpeg' | 'rgba' | 'bitmap';

/**
 * Progress callback type for frame extraction
 * Reports current frame count and total expected frames
 */
export type WebCodecsProgressCallback = (current: number, total: number) => void;

/**
 * Capture mode for WebCodecs frame extraction
 * - auto: Automatically select best mode (demuxer → track → frame-callback → seek)
 * - demuxer: External library demuxing (mp4box/web-demuxer) - eliminates seeking overhead
 * - frame-callback: Use requestVideoFrameCallback API (Chrome/Edge)
 * - seek: Manual seeking with seeked event (universal fallback)
 * - track: MediaStreamTrackProcessor API (experimental)
 */
export type WebCodecsCaptureMode = 'auto' | 'demuxer' | 'frame-callback' | 'seek' | 'track';

/**
 * Frame payload delivered to onFrame callback
 */
export interface WebCodecsFramePayload {
  /** Frame filename (e.g., 'frame_000001.png') */
  name: string;
  /** Encoded frame data (PNG/JPEG bytes) - undefined for rgba format */
  data?: Uint8Array;
  /** Raw RGBA pixel data - undefined for png/jpeg/bitmap formats */
  imageData?: ImageData;
  /** GPU-friendly bitmap - undefined for png/jpeg/rgba formats */
  bitmap?: ImageBitmap;
  /** Zero-based frame index */
  index: number;
  /** Frame timestamp in seconds */
  timestamp: number;
}

/**
 * Options for WebCodecs video decoding
 */
export interface WebCodecsDecodeOptions {
  /** Input video file */
  file: File;
  /** Target frames per second (frame extraction rate) */
  targetFps: number;
  /** Scale factor (0.0 to 1.0) - 1.0 = original size */
  scale: number;
  /** Output frame format (png, jpeg, rgba, or bitmap) */
  frameFormat: WebCodecsFrameFormat;
  /** JPEG quality (0.0 to 1.0) - ignored for png/rgba */
  frameQuality: number;
  /** Frame filename prefix (e.g., 'frame_') */
  framePrefix: string;
  /** Number of zero-padded digits in filename (e.g., 6 = '000001') */
  frameDigits: number;
  /** Starting frame number (usually 0) */
  frameStartNumber: number;
  /** Optional maximum frame count (for limiting output) */
  maxFrames?: number;
  /** Frame capture mode (auto, track, frame-callback, seek) */
  captureMode?: WebCodecsCaptureMode;
  /** Optional video codec for timeout optimization (e.g., 'av01', 'vp9', 'avc1') */
  codec?: string;
  /** Conversion quality level (low, medium, high) - determines encoding format */
  quality?: 'low' | 'medium' | 'high';
  /** Callback invoked for each extracted frame */
  onFrame: (frame: WebCodecsFramePayload) => Promise<void>;
  /** Optional progress callback */
  onProgress?: WebCodecsProgressCallback;
  /** Optional cancellation check */
  shouldCancel?: () => boolean;
}

/**
 * Result of WebCodecs video decoding
 */
export interface WebCodecsDecodeResult {
  /** Array of frame filenames */
  frameFiles: string[];
  /** Total number of extracted frames */
  frameCount: number;
  /** Effective capture mode used after auto-selection/fallbacks */
  captureModeUsed?: WebCodecsCaptureMode;
  /** Frame width in pixels (after scaling) */
  width: number;
  /** Frame height in pixels (after scaling) */
  height: number;
  /** Effective frames per second (may differ from requested target in some modes) */
  fps: number;
  /** Video duration in seconds */
  duration: number;
}

/**
 * Lightweight metadata adapter for demuxer eligibility checks.
 *
 * The decoder service passes a minimal metadata shape so canUseDemuxer() can
 * apply its heuristic codec filter without requiring a full analyzer run.
 */
export type DemuxerEligibilityMetadata = VideoMetadata;
