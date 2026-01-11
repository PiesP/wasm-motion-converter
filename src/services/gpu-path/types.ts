/**
 * GPU Path Type Definitions
 *
 * Core interfaces for the WebCodecs-based GPU acceleration path.
 * Defines contracts between frame extraction, capture modes, demuxers, and decoders.
 */

import type { VideoMetadata } from '../../types/conversion-types';

/**
 * Capture modes for frame extraction
 */
export type CaptureMode = 'auto' | 'demuxer' | 'frame-callback' | 'seek' | 'track';

/**
 * Frame format for extraction
 */
export type FrameFormat = 'png' | 'jpeg' | 'rgba';

/**
 * Frame data with metadata
 */
export interface ExtractedFrame {
  /** Frame index (0-based) */
  index: number;
  /** Frame filename */
  name: string;
  /** Frame data (encoded image or raw RGBA) */
  data: Uint8Array;
  /** Timestamp in seconds */
  timestamp: number;
  /** Frame width in pixels */
  width: number;
  /** Frame height in pixels */
  height: number;
}

/**
 * Frame extraction request parameters
 */
export interface FrameExtractionRequest {
  /** Input video file */
  file: File;
  /** Target frames per second */
  targetFps: number;
  /** Scale factor (0.5, 0.75, 1.0) */
  scale: number;
  /** Maximum number of frames to extract */
  maxFrames?: number;
  /** Video metadata (optional, for optimizations) */
  metadata?: VideoMetadata;
  /** Frame format (png, jpeg, rgba) */
  frameFormat?: FrameFormat;
  /** Frame quality (0-1, for JPEG) */
  frameQuality?: number;
  /** Progress callback (current, total) */
  onProgress?: (current: number, total: number) => void;
  /** Cancellation check */
  shouldCancel?: () => boolean;
}

/**
 * Frame extraction result
 */
export interface FrameExtractionResult {
  /** Extracted frames */
  frames: ExtractedFrame[];
  /** Actual frame width */
  width: number;
  /** Actual frame height */
  height: number;
  /** Actual FPS (may differ from target) */
  fps: number;
  /** Video duration in seconds */
  duration: number;
  /** Total frame count */
  frameCount: number;
  /** Capture mode that was used */
  captureModeUsed: CaptureMode;
  /** Extraction time in milliseconds */
  extractionTimeMs: number;
}

/**
 * Capture mode adapter interface
 *
 * Implements a specific capture mode (demuxer, frame-callback, seek, track).
 * Each adapter knows how to extract frames using its specific technique.
 */
export interface CaptureAdapter {
  /** Capture mode identifier */
  mode: CaptureMode;

  /**
   * Check if this capture mode is available
   */
  isAvailable(): Promise<boolean>;

  /**
   * Capture frames using this mode
   */
  capture(request: FrameExtractionRequest): Promise<FrameExtractionResult>;
}

/**
 * Demuxer interface
 *
 * Parses container formats (MP4, WebM) to extract encoded video samples.
 */
export interface Demuxer {
  /** Container type (mp4, webm, etc.) */
  containerType: string;

  /**
   * Initialize demuxer with file
   */
  initialize(file: File): Promise<void>;

  /**
   * Get video configuration (codec, dimensions, etc.)
   */
  getVideoConfig(): Promise<VideoDecoderConfig>;

  /**
   * Get video samples (encoded chunks)
   */
  getSamples(): AsyncGenerator<EncodedVideoChunk, void, unknown>;

  /**
   * Get total sample count (if known)
   */
  getSampleCount(): number | undefined;

  /**
   * Clean up resources
   */
  dispose(): Promise<void>;
}

/**
 * Demuxer manager interface
 *
 * Manages demuxer lifecycle and fallback logic.
 */
export interface DemuxerManager {
  /**
   * Check if demuxer is available for this file
   */
  canDemux(file: File, metadata?: VideoMetadata): Promise<boolean>;

  /**
   * Create demuxer for file
   */
  createDemuxer(file: File): Promise<Demuxer>;

  /**
   * Dispose all demuxers
   */
  dispose(): Promise<void>;
}

/**
 * Decoder manager interface
 *
 * Manages WebCodecs VideoDecoder lifecycle.
 */
export interface DecoderManager {
  /**
   * Create and configure decoder
   */
  createDecoder(config: VideoDecoderConfig): Promise<VideoDecoder>;

  /**
   * Decode encoded chunk to VideoFrame
   */
  decode(
    decoder: VideoDecoder,
    chunk: EncodedVideoChunk
  ): Promise<VideoFrame>;

  /**
   * Flush decoder and wait for all frames
   */
  flush(decoder: VideoDecoder): Promise<void>;

  /**
   * Close decoder and clean up
   */
  close(decoder: VideoDecoder): Promise<void>;
}

/**
 * Canvas processor interface
 *
 * Handles frame rendering, resizing, and format conversion.
 */
export interface CanvasProcessor {
  /**
   * Process VideoFrame to target format
   */
  processFrame(params: {
    frame: VideoFrame;
    targetWidth: number;
    targetHeight: number;
    format: FrameFormat;
    quality?: number;
  }): Promise<Uint8Array>;

  /**
   * Convert VideoFrame to ImageData
   */
  frameToImageData(
    frame: VideoFrame,
    targetWidth: number,
    targetHeight: number
  ): Promise<ImageData>;

  /**
   * Clean up resources
   */
  dispose(): void;
}
