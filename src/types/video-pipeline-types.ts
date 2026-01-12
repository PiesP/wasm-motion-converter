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
 * Stored in localStorage under `video_caps_v1` and exposed on `window.__VIDEO_CAPS__`.
 */
export interface VideoCapabilities {
  h264: boolean;
  hevc: boolean;
  av1: boolean;
  webpEncode: boolean;
  hardwareAccelerated: boolean;
}

/**
 * Container formats supported by the pipeline selector.
 */
export type ContainerFormat = 'mp4' | 'mov' | 'm4v' | 'webm' | 'mkv' | 'avi' | 'wmv' | 'unknown';

/**
 * Minimal track information needed for pipeline decisions.
 */
export interface VideoTrackInfo {
  codec: string;
  width: number;
  height: number;
  duration: number;
  frameRate: number;
}

/**
 * Pipeline type returned by the selector.
 */
export type PipelineType = 'webcodecs-hw' | 'webcodecs-sw' | 'ffmpeg-wasm-full';

export type VideoPipelineSelectionErrorCode =
  | 'DecodingNotSupported'
  | 'ContainerNotSupported'
  | 'MissingCapabilities';

/**
 * Error thrown by the pure pipeline selector.
 *
 * This is a lightweight, serializable error used for user-facing failures.
 */
export class VideoPipelineSelectionError extends Error {
  readonly code: VideoPipelineSelectionErrorCode;
  readonly context: Record<string, string | number | boolean | null | undefined>;

  constructor(params: {
    code: VideoPipelineSelectionErrorCode;
    message: string;
    context?: Record<string, string | number | boolean | null | undefined>;
  }) {
    super(params.message);
    this.name = 'VideoPipelineSelectionError';
    this.code = params.code;
    this.context = params.context ?? {};
  }
}

/**
 * Demuxer facade returned by DemuxerService.
 *
 * Produces WebCodecs `EncodedVideoChunk` objects when WebCodecs is available.
 */
export interface VideoDemuxer {
  /** Human-readable demuxer name for logging. */
  readonly name: 'mp4box' | 'web-demuxer';

  /**
   * Initialize container parsing and track probing.
   *
   * Implementations may no-op if already initialized.
   */
  initialize(file: File): Promise<void>;

  /**
   * Extract encoded chunks.
   *
   * IMPORTANT: This API returns an array for compatibility with the prompt,
   * but implementations should cap output to avoid memory exhaustion.
   */
  extractChunks(file: File): Promise<EncodedVideoChunk[]>;

  /** Get track info extracted during initialization. */
  getTrackInfo(): VideoTrackInfo;

  /** Release any resources held by the demuxer. */
  destroy(): void;
}

// -----------------------------------------------------------------------------
// Worker message schemas (typed, no `any`)
// -----------------------------------------------------------------------------

export type WorkerRequest =
  | {
      type: 'probe';
      payload: {
        requestId: string;
      };
    }
  | {
      type: 'decode';
      payload: {
        requestId: string;
        // Reserved for future decode parameters
      };
    }
  | {
      type: 'encode';
      payload: {
        requestId: string;
        // Reserved for future encode parameters
      };
    };

export type WorkerResponse =
  | {
      type: 'result';
      payload: {
        requestId: string;
        result: unknown;
      };
    }
  | {
      type: 'error';
      payload: {
        requestId: string;
        error: {
          message: string;
          name?: string;
          stack?: string;
        };
      };
    };
