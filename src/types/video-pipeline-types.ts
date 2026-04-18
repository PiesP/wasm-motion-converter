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
 * Extended video capabilities with additional codec and environment detection.
 *
 * Stored in localStorage under `extended_video_caps_v4` with 7-day TTL.
 * Exposed on `window.__EXTENDED_VIDEO_CAPS__` in dev mode.
 */
export interface ExtendedCapabilities extends VideoCapabilities {
  // Additional codec support
  vp8: boolean;
  vp9: boolean;

  // Optional per-codec hardware decode hints for extended codecs.
  vp8HardwareDecode?: boolean;
  vp9HardwareDecode?: boolean;

  // Encoder capabilities
  gifEncode: boolean; // Always true (modern-gif WASM)
  mp4Encode: boolean; // WebAV availability

  // Environment features
  sharedArrayBuffer: boolean;
  crossOriginIsolated: boolean;
  workerSupport: boolean;
  webcodecsDecode: boolean;
  offscreenCanvas: boolean;

  // Performance indicators
  hardwareDecodeCores?: number; // navigator.hardwareConcurrency
  estimatedMemoryMB?: number; // performance.memory if available

  // Detection metadata
  detectedAt: number; // timestamp
  detectionVersion: number; // for cache invalidation
}

/**
 * Container formats supported by the pipeline selector.
 */
export type ContainerFormat = 'mp4' | 'mov' | 'm4v' | 'webm' | 'mkv' | 'avi' | 'wmv' | 'unknown';

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
