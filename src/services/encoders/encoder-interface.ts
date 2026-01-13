/**
 * Encoder Interface
 *
 * Defines the common interface for all encoder implementations (GIF, WebP, MP4).
 * This pluggable architecture allows:
 * - Easy addition of new output formats
 * - Multiple encoder implementations per format
 * - Capability-based encoder selection
 * - Worker vs main-thread encoding strategies
 *
 * All encoders must implement the EncoderAdapter interface to be registered
 * in the encoder factory and used by the conversion pipeline.
 */

import type { ConversionFormat, ConversionQuality } from '@t/conversion-types';

/**
 * Frame types supported by encoders
 *
 * Encoders can accept frames in multiple formats:
 * - VideoFrame: GPU-resident frame (fastest, no CPU copy)
 * - ImageBitmap: GPU-resident bitmap (faster than ImageData)
 * - ImageData: CPU-resident pixel data (slowest, but universal)
 *
 * Encoders must convert to ImageData internally when pixel access is needed.
 */
export type EncoderFrame = VideoFrame | ImageBitmap | ImageData;

/**
 * Encoder input request
 *
 * Parameters passed to encoder.encode() method. Contains all information
 * needed to encode a sequence of video frames into the target format.
 *
 * Frames can be provided as VideoFrame, ImageBitmap, or ImageData. Encoders
 * should prefer GPU-resident formats (VideoFrame, ImageBitmap) when possible
 * to avoid expensive GPU→CPU transfers.
 *
 * @example
 * const request: EncoderRequest = {
 *   frames: [videoFrame1, videoFrame2, videoFrame3], // Can also be ImageBitmap or ImageData
 *   width: 640,
 *   height: 480,
 *   fps: 10,
 *   quality: 'high',
 *   onProgress: (current, total) => console.log(`${current}/${total}`),
 *   shouldCancel: () => false
 * };
 */
export interface EncoderRequest {
  /** Array of video frames to encode (VideoFrame, ImageBitmap, or ImageData) */
  frames: EncoderFrame[];
  /** Frame width in pixels */
  width: number;
  /** Frame height in pixels */
  height: number;
  /** Frames per second (target playback rate) */
  fps: number;
  /** Quality level (affects palette size, compression, bitrate) */
  quality: ConversionQuality;
  /** Optional capture timestamps (seconds), one per frame */
  timestamps?: number[];
  /** Optional animation duration (seconds) used to avoid pacing drift */
  durationSeconds?: number;
  /** Optional codec string (e.g., 'av01', 'vp09', 'hvc1') for heuristics */
  codec?: string;
  /** Optional source FPS hint (used to detect downsampling and reduce stutter) */
  sourceFPS?: number;
  /** Optional progress callback (current frame, total frames) */
  onProgress?: (current: number, total: number) => void;
  /** Optional cancellation check (returns true to abort) */
  shouldCancel?: () => boolean;
}

/**
 * Encoder capability flags
 *
 * Describes what an encoder can do and what it requires. Used by
 * encoder factory to select the appropriate encoder based on:
 * - Output format needed
 * - Browser capabilities (workers, SharedArrayBuffer)
 * - Input constraints (max frames, max dimensions)
 * - Performance characteristics (relative speed)
 *
 * @example
 * const capabilities: EncoderCapabilities = {
 *   formats: ['gif'],
 *   supportsWorkers: true,
 *   requiresSharedArrayBuffer: false,
 *   maxFrames: 240,
 *   maxDimension: 2048,
 *   performanceScore: 8
 * };
 */
export interface EncoderCapabilities {
  /** Output formats this encoder can produce */
  formats: ConversionFormat[];
  /** Whether encoder can run in workers for parallel encoding */
  supportsWorkers: boolean;
  /** Whether encoder requires SharedArrayBuffer (for WASM multithreading) */
  requiresSharedArrayBuffer: boolean;
  /** Maximum number of frames (undefined = no limit) */
  maxFrames?: number;
  /** Maximum frame dimension (width or height, undefined = no limit) */
  maxDimension?: number;
  /**
   * Performance score (1-10 scale, higher = faster)
   *
   * Relative performance rating for encoder selection. The factory uses this
   * to prioritize faster encoders when multiple options are available.
   *
   * Guidelines:
   * - 9-10: Very fast (GPU-accelerated, native browser APIs)
   * - 7-8: Fast (optimized WASM, efficient algorithms)
   * - 5-6: Medium (balanced implementation)
   * - 3-4: Slow (complex processing, unoptimized)
   * - 1-2: Very slow (last resort, compatibility fallback)
   *
   * @default 5
   */
  performanceScore?: number;
}

/**
 * Encoder adapter interface
 *
 * All encoder implementations must implement this interface. The interface
 * provides a consistent API for:
 * - Capability detection (isAvailable)
 * - Encoding frames to blob (encode)
 * - Resource cleanup (dispose)
 *
 * Encoders are stateless - each encode() call is independent. For stateful
 * encoding (e.g., streaming), use dispose() to reset state between conversions.
 *
 * @example
 * class MyEncoder implements EncoderAdapter {
 *   name = 'my-encoder';
 *   capabilities = {
 *     formats: ['gif'],
 *     supportsWorkers: true,
 *     requiresSharedArrayBuffer: false
 *   };
 *
 *   async isAvailable(): Promise<boolean> {
 *     return typeof Worker !== 'undefined';
 *   }
 *
 *   async encode(request: EncoderRequest): Promise<Blob> {
 *     // Encoding logic here
 *     return new Blob([encodedData], { type: 'image/gif' });
 *   }
 *
 *   async dispose(): Promise<void> {
 *     // Cleanup resources
 *   }
 * }
 */
export interface EncoderAdapter {
  /**
   * Encoder name (unique identifier)
   *
   * Used for logging, debugging, and encoder selection.
   * Should be lowercase with hyphens (e.g., 'modern-gif', 'libwebp-wasm').
   */
  name: string;

  /**
   * Encoder capabilities
   *
   * Describes what formats this encoder supports, whether it can use workers,
   * and any constraints (max frames, max dimensions).
   */
  capabilities: EncoderCapabilities;

  /**
   * Check if encoder is available in current environment
   *
   * Tests browser capabilities, WASM support, worker availability, etc.
   * Encoder factory calls this before using an encoder to ensure it will work.
   *
   * @returns Promise resolving to true if encoder can be used
   *
   * @example
   * async isAvailable(): Promise<boolean> {
   *   // Check for worker support
   *   if (this.capabilities.supportsWorkers && typeof Worker === 'undefined') {
   *     return false;
   *   }
   *
   *   // Check for SharedArrayBuffer if required
   *   if (this.capabilities.requiresSharedArrayBuffer && typeof SharedArrayBuffer === 'undefined') {
   *     return false;
   *   }
   *
   *   // Check for specific APIs
   *   try {
   *     await someLibrary.init();
   *     return true;
   *   } catch {
   *     return false;
   *   }
   * }
   */
  isAvailable(): Promise<boolean>;

  /**
   * Encode frames to target format
   *
   * Core encoding method. Takes array of ImageData frames and produces
   * encoded blob in target format (GIF, WebP, MP4). Must be stateless -
   * each call is independent.
   *
   * @param request - Encoding parameters (frames, dimensions, fps, quality)
   * @returns Promise resolving to encoded blob
   * @throws {Error} If encoding fails or is cancelled
   *
   * @example
   * async encode(request: EncoderRequest): Promise<Blob> {
   *   const { frames, width, height, fps, quality, onProgress, shouldCancel } = request;
   *
   *   const encoder = await this.initEncoder(width, height, fps, quality);
   *
   *   for (let i = 0; i < frames.length; i++) {
   *     if (shouldCancel?.()) {
   *       throw new Error('Encoding cancelled');
   *     }
   *
   *     await encoder.addFrame(frames[i]);
   *     onProgress?.(i + 1, frames.length);
   *   }
   *
   *   const data = await encoder.finalize();
   *   return new Blob([data], { type: 'image/gif' });
   * }
   */
  encode(request: EncoderRequest): Promise<Blob>;

  /**
   * Clean up resources
   *
   * Called when encoder is no longer needed. Should:
   * - Terminate workers
   * - Free WASM memory
   * - Clear caches
   * - Reset state
   *
   * @returns Promise resolving when cleanup is complete
   *
   * @example
   * async dispose(): Promise<void> {
   *   // Terminate worker pool
   *   await this.workerPool?.terminate();
   *   this.workerPool = null;
   *
   *   // Free WASM instance
   *   this.wasmInstance?.free();
   *   this.wasmInstance = null;
   * }
   */
  dispose(): Promise<void>;
}

/**
 * Encoder selection preferences
 *
 * Hints for encoder factory to select the best encoder for a use case.
 * These are preferences, not requirements - factory will fall back if
 * preferred encoder is unavailable.
 *
 * @example
 * const preferences: EncoderPreferences = {
 *   preferWorkers: true,          // Try worker-based encoders first
 *   quality: 'high',               // Optimize for quality
 *   environment: 'worker'          // Running in worker context
 * };
 */
export interface EncoderPreferences {
  /** Prefer worker-based encoders for parallel processing */
  preferWorkers?: boolean;
  /** Quality level (may influence encoder selection) */
  quality?: ConversionQuality;
  /** Execution environment (affects encoder availability) */
  environment?: 'main' | 'worker';
}
