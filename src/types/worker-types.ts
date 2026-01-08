import type { ModernGifOptions } from '../services/modern-gif-service';

/**
 * Serializable representation of ImageData for Web Worker message passing
 *
 * Represents a single frame's pixel data in a format that can be transferred
 * via postMessage without issues with different buffer types (ArrayBuffer vs SharedArrayBuffer).
 *
 * @example
 * const frame: SerializableImageData = {
 *   data: pixels,
 *   width: 800,
 *   height: 600,
 *   colorSpace: 'srgb'
 * };
 */
export interface SerializableImageData {
  /** Pixel data (RGBA format) */
  data: Uint8ClampedArray;
  /** Frame width in pixels */
  width: number;
  /** Frame height in pixels */
  height: number;
  /** Color space of the image data */
  colorSpace?: PredefinedColorSpace;
}

/**
 * Encoder options type alias for worker operations
 *
 * @remarks
 * Extends ModernGifOptions to provide standardized encoding configuration
 * for the worker pool system.
 */
export type EncoderOptions = ModernGifOptions;

/**
 * Public API interface for encoder web worker
 *
 * @remarks
 * Exposed via Comlink for main thread communication.
 * The worker processes frames asynchronously and must be terminated
 * to clean up resources properly.
 *
 * @example
 * const worker = Comlink.wrap<EncoderWorkerAPI>(new Worker(...));
 * const blob = await worker.encode(frames, options);
 * worker.terminate();
 */
export interface EncoderWorkerAPI {
  /**
   * Encode frames to animated GIF
   *
   * @param frames - Single frame or array of frames with RGBA pixel data
   * @param options - Encoding options (quality, delay, etc.)
   * @returns Promise resolving to GIF blob
   *
   * @throws {Error} If frames are invalid or encoding fails
   */
  encode(
    frames: SerializableImageData | SerializableImageData[],
    options: EncoderOptions
  ): Promise<Blob>;

  /**
   * Terminate the worker and clean up resources
   *
   * @remarks
   * Must be called when the worker is no longer needed to prevent
   * memory leaks and free up thread resources.
   */
  terminate(): void;
}

/**
 * Configuration options for worker pool management
 *
 * @remarks
 * Controls the pool's behavior for creating and managing worker instances.
 */
export interface WorkerPoolOptions {
  /**
   * Maximum number of concurrent workers (default: auto-detected)
   *
   * @remarks
   * Limited by available CPU cores. Defaults to navigator.hardwareConcurrency
   * if available, otherwise defaults to 4.
   */
  maxWorkers?: number;

  /**
   * Lazy initialize workers on demand (default: false)
   *
   * @remarks
   * If true, workers are created only when needed.
   * If false, all workers are pre-created during pool initialization.
   */
  lazyInit?: boolean;
}
