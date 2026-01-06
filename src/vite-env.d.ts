/**
 * Vite Environment Types
 *
 * Extends global types for:
 * - Environment variable definitions with type safety
 * - WebCodecs API support (experimental MediaStreamTrackProcessor)
 * - HTMLMediaElement WebCodecs integration (captureStream method)
 *
 * These type definitions enable TypeScript support for APIs that may not
 * yet be fully standardized or included in DOM type definitions.
 */

/// <reference types="vite/client" />

/* ============================================================================
   Vite Environment Variables
   ============================================================================ */

/**
 * Type-safe environment variables accessible via import.meta.env
 *
 * @remarks
 * Variables prefixed with VITE_ are exposed to the client-side code.
 * undefined values indicate optional configuration that isn't required
 * for the application to function.
 *
 * Configuration:
 * - VITE_ADSENSE_PUBLISHER_ID: Google AdSense publisher ID for monetization
 * - VITE_ENABLE_ADS: Boolean string to enable/disable ads display
 * - VITE_DEBUG_FFMPEG: Enable detailed FFmpeg logging
 * - VITE_DEBUG_APP: Enable general application debug logging
 * - VITE_FFMPEG_HARD_TIMEOUT_MS: Override default FFmpeg timeout (milliseconds)
 */
interface ImportMetaEnv {
  /** Google AdSense publisher ID (optional) */
  readonly VITE_ADSENSE_PUBLISHER_ID?: string;
  /** Enable ads display as "true" or "false" string (optional) */
  readonly VITE_ENABLE_ADS?: string;
  /** Enable FFmpeg debug logging as "true" or "false" string (optional) */
  readonly VITE_DEBUG_FFMPEG?: string;
  /** Enable general app debug logging as "true" or "false" string (optional) */
  readonly VITE_DEBUG_APP?: string;
  /** FFmpeg hard timeout in milliseconds (optional string, must parse to number) */
  readonly VITE_FFMPEG_HARD_TIMEOUT_MS?: string;
}

/**
 * Extended ImportMeta to include typed env variables
 *
 * @remarks
 * Provides import.meta.env with full TypeScript support for all
 * VITE_* environment variables defined above.
 */
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/* ============================================================================
   WebCodecs API Extensions
   ============================================================================ */

/**
 * Options for creating a MediaStreamTrackProcessor
 *
 * @remarks
 * MediaStreamTrackProcessor is part of the WebCodecs API (experimental).
 * Allows processing of video frames from a MediaStreamTrack with optional
 * buffering control.
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrackProcessor}
 */
interface MediaStreamTrackProcessorInit {
  /** The MediaStreamTrack to process (required) */
  track: MediaStreamTrack;
  /** Maximum number of frames to buffer (optional, default varies by browser) */
  maxBufferSize?: number;
}

/**
 * Processor for reading frames from a MediaStreamTrack
 *
 * @remarks
 * Part of the WebCodecs API (experimental). Converts a MediaStreamTrack
 * into a ReadableStream of VideoFrames for frame-by-frame processing.
 *
 * TypeScript generic T defaults to VideoFrame for video tracks.
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrackProcessor}
 */
interface MediaStreamTrackProcessor<T = VideoFrame> {
  /** ReadableStream of frames from the input track */
  readonly readable: ReadableStream<T>;
}

/**
 * Constructor for MediaStreamTrackProcessor
 *
 * @remarks
 * Browser support: Currently experimental, check caniuse.com before use.
 * Provides an easy way to create a processor for a given track and options.
 */
declare var MediaStreamTrackProcessor: {
  prototype: MediaStreamTrackProcessor;
  new (options: MediaStreamTrackProcessorInit): MediaStreamTrackProcessor;
};

/**
 * Configuration for ImageEncoder initialization
 *
 * @remarks
 * ImageEncoder is part of the WebCodecs API (experimental).
 * Used for encoding images to various formats (WebP, JPEG, PNG).
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/ImageEncoder}
 */
interface ImageEncoderInit {
  /** Output format type (e.g., "image/webp", "image/jpeg") */
  type: string;
  /** Quality level (0-1 for formats that support it, optional) */
  quality?: number;
  /** Callback when encoded chunk is available */
  output: (chunk: {
    /** Size of encoded chunk in bytes */
    byteLength: number;
    /** Copy encoded data to destination buffer */
    copyTo: (destination: ArrayBufferView) => void;
  }) => void;
  /** Callback for encoding errors (optional) */
  error?: (error: Error) => void;
}

/**
 * Encoder for image formats (WebP, JPEG, PNG, etc.)
 *
 * @remarks
 * Part of the WebCodecs API (experimental). Encodes ImageBitmapSource
 * (Canvas, VideoFrame, etc.) to specified image format with quality control.
 *
 * Browser support: Limited, check caniuse.com before use.
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/ImageEncoder}
 */
interface ImageEncoder {
  /** Encode an image source to the specified format */
  encode(image: ImageBitmapSource): Promise<void> | void;
  /** Flush any pending encoded data */
  flush(): Promise<void>;
  /** Close encoder and release resources */
  close(): void;
}

/**
 * Constructor for ImageEncoder
 *
 * @remarks
 * Static method `isTypeSupported` checks if a format is supported
 * before attempting to create an encoder.
 */
declare var ImageEncoder: {
  prototype: ImageEncoder;
  new (init: ImageEncoderInit): ImageEncoder;
  /** Check if image format is supported (optional, browser-dependent) */
  isTypeSupported?: (type: string) => Promise<boolean>;
};

/* ============================================================================
   HTMLMediaElement Extensions
   ============================================================================ */

/**
 * Extension to HTMLMediaElement for WebCodecs support
 *
 * @remarks
 * captureStream() is a standard method to get a MediaStream from
 * an audio or video element for real-time frame/audio capture.
 * This allows using MediaStreamTrackProcessor to process video frames
 * for conversion to GIF or WebP formats.
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/captureStream}
 */
declare global {
  interface HTMLMediaElement {
    /** Capture a MediaStream from the media element for frame processing */
    captureStream?(): MediaStream;
  }
}
