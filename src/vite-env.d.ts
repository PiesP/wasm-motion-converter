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

import type { ExtendedCapabilities, VideoCapabilities } from '@t/video-pipeline-types';
import type { CodecPathPreference } from '@services/orchestration/types';
import type { ConversionHistory } from '@services/orchestration/strategy-history-service';
import type {
  ConversionMetricGroup,
  ConversionMetricRecord,
} from '@services/orchestration/conversion-metrics-service';

/* ============================================================================
   Vite Environment Variables
   ============================================================================ */

declare global {
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
}

/* ============================================================================
   WebCodecs API Extensions
   ============================================================================ */

declare global {
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
}

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

  interface Window {
    /** Cached runtime video capabilities (capability-service.ts) */
    __VIDEO_CAPS__?: VideoCapabilities;
    /** Extended video capabilities with additional codecs and environment info (extended-capability-service.ts) */
    __EXTENDED_VIDEO_CAPS__?: ExtendedCapabilities;
    /** Debug interface for testing conversion strategies (dev mode only) */
    __CONVERSION_DEBUG__?: {
      capabilities: ExtendedCapabilities;
      strategies: CodecPathPreference[];
      history: () => ConversionHistory[];
      metrics: () => ConversionMetricRecord[];
      metricsSummary: () => ConversionMetricGroup[];
      clearMetrics: () => void;
      lastDecision: () => {
        timestamp: number;
        format: 'gif' | 'webp' | 'mp4';
        codec?: string;
        container?: string;
        plannedPath: 'gpu' | 'cpu' | 'hybrid' | 'webav';
        plannedReason: string;
        strategyConfidence?: 'high' | 'medium' | 'low';
        demuxerAvailable?: boolean;
        useDemuxerPlanned?: boolean;
        hardwareAccelerated?: boolean;
        sharedArrayBuffer?: boolean;
        crossOriginIsolated?: boolean;
        workerSupport?: boolean;
        executedPath?: 'gpu' | 'cpu' | 'hybrid' | 'webav';
        encoderBackend?: string;
        captureModeUsed?: string | null;
        outcome?: 'success' | 'error' | 'cancelled';
        errorMessage?: string;
      } | null;
      phaseTimings: () => {
        timestamp: number;
        initializationMs: number;
        analysisMs: number;
        conversionMs: number;
        totalMs: number;
        outcome?: 'success' | 'error' | 'cancelled';
      } | null;
      testStrategy: (
        codec: string,
        format: 'gif' | 'webp' | 'mp4'
      ) => CodecPathPreference & { confidence: 'high' | 'medium' | 'low' };
    };
  }
}
