/**
 * WebP Encoder Adapter
 *
 * Worker-based WebP encoder using browser's native WebP encoding.
 * Encodes frames in parallel using OffscreenCanvas, then muxes into animated WebP.
 *
 * Features:
 * - Parallel frame encoding using workers
 * - Native browser WebP encoding (OffscreenCanvas.convertToBlob)
 * - Custom WebP muxing for animation
 * - Quality-based encoding parameters
 * - Progress tracking and cancellation
 *
 * Architecture:
 * 1. Distribute frames across worker pool
 * 2. Each worker encodes frames to WebP using OffscreenCanvas
 * 3. Main thread collects encoded frames
 * 4. Mux frames into final animated WebP using webp-muxer
 */

import type {
  EncoderAdapter,
  EncoderFrame,
  EncoderRequest,
} from '@services/encoders/encoder-interface-service';
import { convertFramesToImageData } from '@services/encoders/frame-converter-service';
import {
  WEBP_ANIMATION_MAX_FRAMES,
  WEBP_BACKGROUND_COLOR,
} from '@services/webcodecs/webp-constants-service';
import { buildWebPFrameDurations, resolveWebPFps } from '@services/webcodecs/webp-timing-service';
import { logger } from '@utils/logger';
import type { AnimatedWebPOptions, WebPFrame } from '@utils/webp-muxer';
import { muxAnimatedWebP } from '@utils/webp-muxer';
import type * as Comlink from 'comlink';

const NO_FRAMES_ERROR = 'No frames to encode';
const EMPTY_ENCODED_FRAMES_ERROR = 'No frames were encoded';
const ENCODING_CANCELLED_ERROR = 'Encoding cancelled';
const MAX_FRAME_DURATION_MS = 1_000;
const MAX_WORKERS = 4;
const DEFAULT_HW_CONCURRENCY = 4;
const ENCODE_QUALITY_LOW = 0.75;
const ENCODE_QUALITY_MEDIUM = 0.85;
const ENCODE_QUALITY_HIGH = 0.95;

/**
 * WebP encoder worker API
 */
interface WebPEncoderWorkerApi {
  /**
   * Encode single frame to WebP
   */
  encodeFrame(
    imageData: { data: Uint8ClampedArray; width: number; height: number },
    quality: number
  ): Promise<ArrayBuffer>;

  /**
   * Encode a single ImageBitmap frame to WebP.
   */
  encodeFrameBitmap(bitmap: ImageBitmap, quality: number): Promise<ArrayBuffer>;

  /**
   * Terminate worker
   */
  terminate(): void;
}

/**
 * WebP encoder adapter
 *
 * Encodes video frames to animated WebP format using worker-based parallel encoding.
 */
export class WebPEncoderAdapter implements EncoderAdapter {
  name = 'webp-native';

  capabilities = {
    formats: ['webp' as const],
    supportsWorkers: true,
    requiresSharedArrayBuffer: false,
    maxFrames: WEBP_ANIMATION_MAX_FRAMES,
    maxDimension: undefined,
    /**
     * Performance score: 3/10 (Slow)
     *
     * Worker-based parallel encoding with webp-muxer has high overhead.
     * Log data: H.264→WebP in ~13.5s (13x slower than canvas alternative).
     * Worker setup and muxing overhead dominates for typical video sizes.
     */
    performanceScore: 3,
  };

  private workers: Array<Comlink.Remote<WebPEncoderWorkerApi>> = [];
  private Comlink: typeof import('comlink') | null = null;

  /**
   * Check if WebP encoding is available
   *
   * Requirements:
   * - OffscreenCanvas support
   * - WebP encoding support (convertToBlob)
   * - Worker support (for parallel encoding)
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Check OffscreenCanvas support
      if (typeof OffscreenCanvas === 'undefined') {
        logger.debug('webp-encoder', 'OffscreenCanvas not available');
        return false;
      }

      // Check Worker support
      if (typeof Worker === 'undefined') {
        logger.debug('webp-encoder', 'Worker not available');
        return false;
      }

      // Check WebP encoding support
      // Note: convertToBlob may throw in some browsers or return a different mime type
      let supportsWebP = false;
      try {
        const canvas = new OffscreenCanvas(1, 1);
        const blob = await canvas.convertToBlob({ type: 'image/webp' });
        // Some browsers may not honor the type request, check size as fallback
        supportsWebP = blob && (blob.type === 'image/webp' || blob.size > 0);
      } catch {
        // convertToBlob failed, WebP not supported
        supportsWebP = false;
      }

      if (!supportsWebP) {
        logger.debug('webp-encoder', 'WebP encoding not supported');
        return false;
      }

      logger.debug('webp-encoder', 'WebP encoder available');
      return true;
    } catch (error) {
      logger.debug('webp-encoder', 'WebP encoder availability check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Encode frames to animated WebP
   *
   * @param request - Encoding parameters
   * @returns Animated WebP blob
   */
  async encode(request: EncoderRequest): Promise<Blob> {
    const {
      frames,
      width,
      height,
      fps,
      quality,
      timestamps,
      durationSeconds,
      codec,
      sourceFPS,
      onProgress,
      shouldCancel,
    } = request;

    if (frames.length === 0) {
      throw new Error(NO_FRAMES_ERROR);
    }

    logger.info('webp-encoder', 'Starting WebP encoding', {
      frameCount: frames.length,
      width,
      height,
      fps,
      quality,
      hasTimestamps: Boolean(timestamps && timestamps.length > 0),
      durationSeconds,
      codec,
      sourceFPS,
    });

    const startTime = performance.now();

    try {
      // Initialize workers
      const workerCount = Math.min(
        navigator.hardwareConcurrency || DEFAULT_HW_CONCURRENCY,
        MAX_WORKERS
      );
      await this.initializeWorkers(workerCount);

      // Calculate quality parameter (0.0 to 1.0)
      const encodeQuality =
        quality === 'low'
          ? ENCODE_QUALITY_LOW
          : quality === 'medium'
            ? ENCODE_QUALITY_MEDIUM
            : ENCODE_QUALITY_HIGH;

      // If createImageBitmap isn't available, fall back to ImageData conversion.
      // Otherwise, prefer passing GPU-friendly frames (ImageBitmap/VideoFrame) to workers.
      const needsGpuFrames = frames.some((frame) => !(frame instanceof ImageData));
      const canCloneToBitmap = typeof createImageBitmap === 'function';

      const framesForEncoding: EncoderFrame[] =
        needsGpuFrames && !canCloneToBitmap
          ? await convertFramesToImageData(frames, width, height, undefined, shouldCancel)
          : frames;

      // Encode frames in parallel
      const encodedFrames = await this.encodeFramesParallel(
        framesForEncoding,
        encodeQuality,
        onProgress,
        shouldCancel
      );

      if (encodedFrames.length === 0) {
        throw new Error(EMPTY_ENCODED_FRAMES_ERROR);
      }

      // Calculate frame durations
      const frameCount = encodedFrames.length;
      const effectiveFps = resolveWebPFps(frameCount, fps, durationSeconds);
      const timestampsForDurations =
        timestamps && timestamps.length >= frameCount
          ? timestamps.slice(0, frameCount)
          : Array.from({ length: frameCount }, (_, i) => i / Math.max(1, effectiveFps));

      const durations = buildWebPFrameDurations({
        timestamps: timestampsForDurations,
        fps: effectiveFps,
        frameCount,
        sourceFPS: sourceFPS ?? fps,
        codec,
        durationSeconds,
      });

      // Prepare WebP frames with durations
      const webpFrames: WebPFrame[] = encodedFrames.map((data, index) => ({
        data,
        duration: durations[index] ?? Math.round(MAX_FRAME_DURATION_MS / effectiveFps),
      }));

      // Mux frames into animated WebP
      const muxOptions: AnimatedWebPOptions = {
        width,
        height,
        loopCount: 0,
        backgroundColor: WEBP_BACKGROUND_COLOR,
      };

      logger.info('webp-encoder', 'Muxing WebP frames', {
        frameCount: webpFrames.length,
        width,
        height,
      });

      const muxedData = await muxAnimatedWebP(webpFrames, muxOptions);
      const blob = new Blob([muxedData], { type: 'image/webp' });

      const duration = performance.now() - startTime;
      logger.performance('WebP encoding completed', {
        frameCount: frames.length,
        durationMs: Math.round(duration),
        outputSize: blob.size,
        fps: effectiveFps,
      });

      return blob;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('webp-encoder', 'WebP encoding failed', { error: message });
      throw error;
    } finally {
      // Clean up workers
      await this.dispose();
    }
  }

  /**
   * Initialize worker pool
   */
  private async initializeWorkers(count: number): Promise<void> {
    if (this.workers.length > 0) {
      return; // Already initialized
    }

    logger.debug('webp-encoder', 'Initializing worker pool', { count });

    // Import Comlink if not already imported
    if (!this.Comlink) {
      this.Comlink = await import('comlink');
    }

    for (let i = 0; i < count; i++) {
      // Create worker using standard Vite pattern
      const worker = new Worker(
        new URL('../../../workers/webp-encoder.worker.ts', import.meta.url),
        {
          type: 'module',
        }
      );
      const wrappedWorker = this.Comlink.wrap<WebPEncoderWorkerApi>(worker);
      this.workers.push(wrappedWorker);
    }

    logger.debug('webp-encoder', 'Worker pool initialized', {
      workerCount: this.workers.length,
    });
  }

  /**
   * Encode frames in parallel using worker pool
   */
  private async encodeFramesParallel(
    frames: EncoderFrame[],
    quality: number,
    onProgress?: (current: number, total: number) => void,
    shouldCancel?: () => boolean
  ): Promise<ArrayBuffer[]> {
    const encodedFrames: ArrayBuffer[] = new Array(frames.length);
    const workerCount = this.workers.length;
    let completedCount = 0;

    // Distribute frames across workers
    const tasks = frames.map(async (frame, index) => {
      if (shouldCancel?.()) {
        throw new Error(ENCODING_CANCELLED_ERROR);
      }

      const workerIndex = index % workerCount;
      const worker = this.workers[workerIndex];

      if (!worker) {
        throw new Error(`Worker ${workerIndex} not available`);
      }

      let encoded: ArrayBuffer;

      if (frame instanceof ImageData) {
        // Convert ImageData to a structured-clone-friendly shape
        const imageData = {
          data: frame.data,
          width: frame.width,
          height: frame.height,
        };
        encoded = await worker.encodeFrame(imageData, quality);
      } else {
        if (typeof createImageBitmap !== 'function') {
          throw new Error('createImageBitmap is not available for bitmap WebP encoding');
        }

        if (!this.Comlink) {
          throw new Error('Comlink is not initialized');
        }

        // Clone to a transferable ImageBitmap so we can keep the original frame
        // intact for fallback paths.
        const bitmapClone = await createImageBitmap(frame as unknown as ImageBitmapSource);
        const transferableBitmap = this.Comlink.transfer(bitmapClone, [bitmapClone]);
        encoded = await worker.encodeFrameBitmap(transferableBitmap, quality);
      }

      encodedFrames[index] = encoded;

      completedCount += 1;
      onProgress?.(completedCount, frames.length);

      return encoded;
    });

    await Promise.all(tasks);

    return encodedFrames;
  }

  /**
   * Clean up resources
   */
  async dispose(): Promise<void> {
    logger.debug('webp-encoder', 'Disposing WebP encoder', {
      workerCount: this.workers.length,
    });

    // Terminate all workers
    for (const worker of this.workers) {
      try {
        await worker.terminate();
      } catch (error) {
        logger.debug('webp-encoder', 'Error terminating worker', { error });
      }
    }

    this.workers = [];
    this.Comlink = null;

    logger.debug('webp-encoder', 'WebP encoder disposed');
  }
}
