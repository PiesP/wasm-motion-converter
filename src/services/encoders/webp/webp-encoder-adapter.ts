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

import {
  WEBP_ANIMATION_MAX_FRAMES,
  WEBP_BACKGROUND_COLOR,
} from "@services/webcodecs/webp-constants";
import {
  buildWebPFrameDurations,
  resolveWebPFps,
} from "@services/webcodecs/webp-timing";
import { logger } from "@utils/logger";
import type { AnimatedWebPOptions, WebPFrame } from "@utils/webp-muxer";
import { muxAnimatedWebP } from "@utils/webp-muxer";
import type * as Comlink from "comlink";
import type { EncoderAdapter, EncoderRequest } from "../encoder-interface";

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
  name = "webp-native";

  capabilities = {
    formats: ["webp" as const],
    supportsWorkers: true,
    requiresSharedArrayBuffer: false,
    maxFrames: WEBP_ANIMATION_MAX_FRAMES,
    maxDimension: undefined,
  };

  private workers: Array<Comlink.Remote<WebPEncoderWorkerApi>> = [];
  private Comlink: typeof import("comlink") | null = null;

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
      if (typeof OffscreenCanvas === "undefined") {
        logger.debug("webp-encoder", "OffscreenCanvas not available");
        return false;
      }

      // Check Worker support
      if (typeof Worker === "undefined") {
        logger.debug("webp-encoder", "Worker not available");
        return false;
      }

      // Check WebP encoding support
      // Note: convertToBlob may throw in some browsers or return a different mime type
      let supportsWebP = false;
      try {
        const canvas = new OffscreenCanvas(1, 1);
        const blob = await canvas.convertToBlob({ type: "image/webp" });
        // Some browsers may not honor the type request, check size as fallback
        supportsWebP = blob && (blob.type === "image/webp" || blob.size > 0);
      } catch {
        // convertToBlob failed, WebP not supported
        supportsWebP = false;
      }

      if (!supportsWebP) {
        logger.debug("webp-encoder", "WebP encoding not supported");
        return false;
      }

      logger.debug("webp-encoder", "WebP encoder available");
      return true;
    } catch (error) {
      logger.debug("webp-encoder", "WebP encoder availability check failed", {
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
    const { frames, width, height, fps, quality, onProgress, shouldCancel } =
      request;

    if (frames.length === 0) {
      throw new Error("No frames to encode");
    }

    logger.info("webp-encoder", "Starting WebP encoding", {
      frameCount: frames.length,
      width,
      height,
      fps,
      quality,
    });

    const startTime = performance.now();

    try {
      // Initialize workers
      const workerCount = Math.min(navigator.hardwareConcurrency || 4, 4);
      await this.initializeWorkers(workerCount);

      // Calculate quality parameter (0.0 to 1.0)
      const encodeQuality =
        quality === "low" ? 0.75 : quality === "medium" ? 0.85 : 0.95;

      // Encode frames in parallel
      const encodedFrames = await this.encodeFramesParallel(
        frames,
        encodeQuality,
        onProgress,
        shouldCancel
      );

      if (encodedFrames.length === 0) {
        throw new Error("No frames were encoded");
      }

      // Calculate frame durations
      const effectiveFps = resolveWebPFps(encodedFrames.length, fps);
      const timestamps = Array.from(
        { length: encodedFrames.length },
        (_, i) => i / effectiveFps
      );
      const durations = buildWebPFrameDurations({
        timestamps,
        fps: effectiveFps,
        frameCount: encodedFrames.length,
        sourceFPS: fps,
      });

      // Prepare WebP frames with durations
      const webpFrames: WebPFrame[] = encodedFrames.map((data, index) => ({
        data,
        duration: durations[index] ?? Math.round(1000 / effectiveFps),
      }));

      // Mux frames into animated WebP
      const muxOptions: AnimatedWebPOptions = {
        width,
        height,
        loopCount: 0,
        backgroundColor: WEBP_BACKGROUND_COLOR,
      };

      logger.info("webp-encoder", "Muxing WebP frames", {
        frameCount: webpFrames.length,
        width,
        height,
      });

      const muxedData = await muxAnimatedWebP(webpFrames, muxOptions);
      const blob = new Blob([muxedData], { type: "image/webp" });

      const duration = performance.now() - startTime;
      logger.performance("WebP encoding completed", {
        frameCount: frames.length,
        durationMs: Math.round(duration),
        outputSize: blob.size,
        fps: effectiveFps,
      });

      return blob;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("webp-encoder", "WebP encoding failed", { error: message });
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

    logger.debug("webp-encoder", "Initializing worker pool", { count });

    // Import Comlink if not already imported
    if (!this.Comlink) {
      this.Comlink = await import("comlink");
    }

    for (let i = 0; i < count; i++) {
      // Create worker using standard Vite pattern
      const worker = new Worker(
        new URL("../../../workers/webp-encoder.worker.ts", import.meta.url),
        {
          type: "module",
        }
      );
      const wrappedWorker = this.Comlink.wrap<WebPEncoderWorkerApi>(worker);
      this.workers.push(wrappedWorker);
    }

    logger.debug("webp-encoder", "Worker pool initialized", {
      workerCount: this.workers.length,
    });
  }

  /**
   * Encode frames in parallel using worker pool
   */
  private async encodeFramesParallel(
    frames: ImageData[],
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
        throw new Error("Encoding cancelled");
      }

      const workerIndex = index % workerCount;
      const worker = this.workers[workerIndex];

      if (!worker) {
        throw new Error(`Worker ${workerIndex} not available`);
      }

      // Convert ImageData to transferable format
      const imageData = {
        data: frame.data,
        width: frame.width,
        height: frame.height,
      };

      // Encode frame
      const encoded = await worker.encodeFrame(imageData, quality);
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
    logger.debug("webp-encoder", "Disposing WebP encoder", {
      workerCount: this.workers.length,
    });

    // Terminate all workers
    for (const worker of this.workers) {
      try {
        await worker.terminate();
      } catch (error) {
        logger.debug("webp-encoder", "Error terminating worker", { error });
      }
    }

    this.workers = [];
    this.Comlink = null;

    logger.debug("webp-encoder", "WebP encoder disposed");
  }
}

/**
 * Create WebP encoder adapter instance
 *
 * @returns New WebPEncoderAdapter instance
 */
export function createWebPEncoder(): EncoderAdapter {
  return new WebPEncoderAdapter();
}
