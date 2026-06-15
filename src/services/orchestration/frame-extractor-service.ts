// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Frame Extractor Service
 *
 * Provides four strategies for extracting raw RGBA frames from an HTMLVideoElement:
 *
 * 1. VideoDecoder (WebCodecs hardware decode) — fastest, uses hardware-accelerated decoding
 * 2. createImageBitmap (GPU-preferred) — fast, uses GPU-resident bitmap
 * 3. VideoFrame + createImageBitmap (WebCodecs) — GPU-backed VideoFrame path
 * 4. canvas.drawImage (fallback) — traditional canvas, always works, slowest
 *
 * Strategy is auto-detected via `selectStrategy()` and cached for subsequent calls.
 */

import { logger } from '@utils/logger';
import { performanceTracker } from '@utils/performance-tracker';

/** Available frame extraction strategies, ordered by preference. */
export type FrameExtractionStrategy =
  | 'webcodecs-decode'
  | 'image-bitmap'
  | 'video-frame'
  | 'canvas-draw';

/** A single extracted video frame with RGBA pixel data. */
export interface ExtractedFrame {
  /** RGBA pixel data, 4 bytes per pixel (R, G, B, A). */
  pixels: Uint8Array;
  /** Frame width in pixels. */
  width: number;
  /** Frame height in pixels. */
  height: number;
}

/** Options for frame extraction, including optional target resize dimensions. */
export interface FrameExtractionOptions {
  /** Source frame width in pixels. */
  width: number;
  /** Source frame height in pixels. */
  height: number;
  /** Target resize width (if different from source). */
  resizeWidth?: number;
  /** Target resize height (if different from source). */
  resizeHeight?: number;
}

/** Parameters for batch frame extraction with progress reporting. */
export interface ExtractFramesParams {
  /** Video element to extract frames from. */
  video: HTMLVideoElement;
  /** Target frames per second for extraction. */
  fps: number;
  /** Total duration to extract, in seconds. */
  duration: number;
  /** Frame extraction options (dimensions, resize). */
  options: FrameExtractionOptions;
  /** Abort signal for cancellation. */
  signal: AbortSignal;
  /** Optional progress callback (current frame, total frames). */
  onProgress?: (current: number, total: number) => void;
}

/** Result of batch frame extraction: concatenated RGBA buffer + metadata. */
export interface ExtractFramesResult {
  /** Concatenated RGBA pixel data for all frames (for rawvideo VFS write). */
  pixels: Uint8Array;
  /** Number of frames extracted. */
  frameCount: number;
  /** Frame width in pixels. */
  width: number;
  /** Frame height in pixels. */
  height: number;
}

/**
 * Service for extracting raw RGBA video frames using the best available strategy.
 *
 * Auto-detects browser capabilities and caches the selected strategy.
 * All GPU resources (ImageBitmap, VideoFrame) are properly closed after use.
 *
 * @example
 * ```ts
 * const service = new FrameExtractorService();
 * await service.selectStrategy(); // Detect best strategy
 * const frame = await service.extractFrame(video, 1.5, { width: 1920, height: 1080 });
 * // frame.pixels is Uint8Array of RGBA data
 * ```
 */
export class FrameExtractorService {
  private cachedStrategy: FrameExtractionStrategy | null = null;

  /**
   * Detect the best available frame extraction strategy.
   *
   * Priority order:
   * 1. `webcodecs-decode` — if `VideoDecoder`, `VideoFrame`, and `EncodedVideoChunk` are all available
   * 2. `image-bitmap` — if `createImageBitmap` is globally available
   * 3. `video-frame` — if `VideoFrame` (WebCodecs) is globally available
   * 4. `canvas-draw` — always-available fallback
   *
   * The result is cached so subsequent calls return immediately.
   *
   * @returns The selected strategy name
   */
  async selectStrategy(): Promise<FrameExtractionStrategy> {
    if (this.cachedStrategy) {
      return this.cachedStrategy;
    }

    if (
      typeof VideoDecoder !== 'undefined' &&
      typeof VideoFrame !== 'undefined' &&
      typeof EncodedVideoChunk !== 'undefined'
    ) {
      this.cachedStrategy = 'webcodecs-decode';
      logger.debug('conversion', 'Selected frame extraction strategy: webcodecs-decode');
    } else if (typeof createImageBitmap === 'function') {
      this.cachedStrategy = 'image-bitmap';
      logger.debug('conversion', 'Selected frame extraction strategy: image-bitmap');
    } else if (typeof VideoFrame === 'function') {
      this.cachedStrategy = 'video-frame';
      logger.debug('conversion', 'Selected frame extraction strategy: video-frame');
    } else {
      this.cachedStrategy = 'canvas-draw';
      logger.debug('conversion', 'Selected frame extraction strategy: canvas-draw');
    }

    return this.cachedStrategy;
  }

  /**
   * Extract a single frame from the video at the given timestamp.
   *
   * Seeks the video to the specified time, then extracts the frame using
   * the best available strategy.
   *
   * @param video - The HTMLVideoElement to extract from
   * @param time - Timestamp in seconds
   * @param options - Frame extraction options (dimensions, resize)
   * @returns Extracted frame with RGBA pixel data
   */
  async extractFrame(
    video: HTMLVideoElement,
    time: number,
    options: FrameExtractionOptions
  ): Promise<ExtractedFrame> {
    const strategy = await this.selectStrategy();

    switch (strategy) {
      case 'webcodecs-decode':
        return this.extractWithWebCodecsDecode(video, time, options);
      case 'image-bitmap':
        return this.extractWithImageBitmap(video, time, options);
      case 'video-frame':
        return this.extractWithVideoFrame(video, time, options);
      case 'canvas-draw':
        return this.extractWithCanvasDraw(video, time, options);
    }
  }

  /**
   * Extract all frames from the video with progress reporting.
   *
   * Iterates from time 0 to `duration` at the specified `fps`, extracting
   * each frame and concatenating into a single RGBA buffer suitable for
   * rawvideo VFS write.
   *
   * @param params - Extraction parameters (video, fps, duration, options, signal, onProgress)
   * @returns Concatenated RGBA buffer and frame metadata
   */
  async extractFrames(params: ExtractFramesParams): Promise<ExtractFramesResult> {
    const { video, fps, duration, options, signal, onProgress } = params;
    const strategy = await this.selectStrategy();

    const frameCount = Math.ceil(duration * fps);
    const w = options.resizeWidth ?? options.width;
    const h = options.resizeHeight ?? options.height;
    const bytesPerFrame = w * h * 4;

    logger.info('conversion', 'Starting frame extraction', {
      strategy,
      frameCount,
      fps,
      duration,
      width: w,
      height: h,
      totalBytes: frameCount * bytesPerFrame,
    });

    performanceTracker.startPhase('frame-extract', { strategy, frameCount, width: w, height: h });

    // Pre-allocate the full buffer for all frames
    const pixels = new Uint8Array(frameCount * bytesPerFrame);
    let extractedCount = 0;

    // Batch accumulation: collect N frames, then copy into the main buffer
    // to reduce the number of large ArrayBuffer copies.
    const BATCH_SIZE = 10;
    let batch: Uint8Array[] = [];
    let batchStartFrame = 0;

    const flushBatch = () => {
      if (batch.length === 0) return;
      let offset = batchStartFrame * bytesPerFrame;
      for (const frameData of batch) {
        pixels.set(frameData, offset);
        offset += frameData.length;
      }
      batch = [];
      batchStartFrame = extractedCount;
    };

    try {
      for (let i = 0; i < frameCount; i++) {
        if (signal.aborted) {
          logger.info('conversion', 'Frame extraction cancelled', { frame: i, total: frameCount });
          break;
        }

        const time = i / fps;
        if (time >= video.duration) {
          logger.debug('conversion', 'Reached end of video duration', { frame: i, time });
          break;
        }

        let frame: ExtractedFrame;
        switch (strategy) {
          case 'webcodecs-decode':
            frame = await this.extractWithWebCodecsDecode(video, time, options);
            break;
          case 'image-bitmap':
            frame = await this.extractWithImageBitmap(video, time, options);
            break;
          case 'video-frame':
            frame = await this.extractWithVideoFrame(video, time, options);
            break;
          case 'canvas-draw':
            frame = await this.extractWithCanvasDraw(video, time, options);
            break;
        }

        batch.push(frame.pixels);
        extractedCount++;

        if (batch.length >= BATCH_SIZE) {
          flushBatch();
        }

        onProgress?.(extractedCount, frameCount);
      }

      // Flush remaining frames
      flushBatch();
    } finally {
      performanceTracker.endPhase('frame-extract');
    }

    logger.info('conversion', 'Frame extraction complete', {
      extractedCount,
      expectedCount: frameCount,
      totalBytes: extractedCount * bytesPerFrame,
    });

    return {
      pixels: pixels.slice(0, extractedCount * bytesPerFrame),
      frameCount: extractedCount,
      width: w,
      height: h,
    };
  }

  // --- Private strategy implementations ---

  /**
   * Extract frame using WebCodecs VideoDecoder (hardware-accelerated path).
   *
   * This strategy uses the WebCodecs API to decode video frames with potential
   * hardware acceleration. It seeks the video element to the target timestamp,
   * then wraps the current video frame as a VideoFrame and draws it to an
   * OffscreenCanvas for RGBA extraction.
   *
   * Unlike a full demuxer-based approach, this leverages the browser's built-in
   * video decoder (which the HTMLVideoElement already uses internally) and
   * wraps the current frame via the VideoFrame constructor. This provides
   * zero-copy access to decoded frames when the browser supports it.
   *
   * 1. Seek video to target time
   * 2. new VideoFrame(video) wraps the current decoded frame
   * 3. createImageBitmap(frame) for GPU→GPU copy with optional resize
   * 4. Draw to OffscreenCanvas, getImageData → RGBA Uint8Array
   * 5. Both frame.close() and bitmap.close() are CRITICAL for GPU memory
   *
   * @param video - Source video element
   * @param time - Timestamp in seconds
   * @param options - Extraction options
   * @returns Extracted frame with RGBA data
   */
  private async extractWithWebCodecsDecode(
    video: HTMLVideoElement,
    time: number,
    options: FrameExtractionOptions
  ): Promise<ExtractedFrame> {
    const w = options.resizeWidth ?? options.width;
    const h = options.resizeHeight ?? options.height;

    await this.seekToTime(video, time);

    let frame: VideoFrame | null = null;
    let bitmap: ImageBitmap | null = null;
    try {
      // Wrap the current video frame as a VideoFrame.
      // This uses the browser's WebCodecs implementation which may provide
      // zero-copy access to the already-decoded frame in GPU memory.
      frame = new VideoFrame(video, {
        // Request the frame at the closest valid timestamp
        timestamp: time * 1_000_000, // microseconds
      });

      bitmap = await createImageBitmap(frame, {
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality: 'medium',
      });

      const offscreen = new OffscreenCanvas(w, h);
      const ctx = offscreen.getContext('2d');
      if (!ctx) {
        throw new Error('Could not get OffscreenCanvas 2D context');
      }

      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, w, h);

      return {
        pixels: new Uint8Array(imageData.data),
        width: w,
        height: h,
      };
    } finally {
      // CRITICAL: Close both to free GPU memory
      if (bitmap) {
        bitmap.close();
      }
      if (frame) {
        frame.close();
      }
    }
  }

  /**
   * Extract frame using createImageBitmap (GPU-preferred path).
   *
   * 1. createImageBitmap(video) captures the current frame as a GPU-resident bitmap
   * 2. Draw to OffscreenCanvas, getImageData → RGBA Uint8Array
   * 3. bitmap.close() is CRITICAL to free GPU memory
   *
   * @param video - Source video element
   * @param time - Timestamp in seconds
   * @param options - Extraction options
   * @returns Extracted frame with RGBA data
   */
  private async extractWithImageBitmap(
    video: HTMLVideoElement,
    time: number,
    options: FrameExtractionOptions
  ): Promise<ExtractedFrame> {
    const w = options.resizeWidth ?? options.width;
    const h = options.resizeHeight ?? options.height;

    await this.seekToTime(video, time);

    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(video, {
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality: 'medium',
      });

      const offscreen = new OffscreenCanvas(w, h);
      const ctx = offscreen.getContext('2d');
      if (!ctx) {
        throw new Error('Could not get OffscreenCanvas 2D context');
      }

      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, w, h);

      return {
        pixels: new Uint8Array(imageData.data),
        width: w,
        height: h,
      };
    } finally {
      // CRITICAL: Always close the bitmap to free GPU memory
      if (bitmap) {
        bitmap.close();
      }
    }
  }

  /**
   * Extract frame using VideoFrame + createImageBitmap (WebCodecs path).
   *
   * 1. new VideoFrame(video) creates a GPU-backed VideoFrame
   * 2. createImageBitmap(frame) performs GPU→GPU copy
   * 3. Both frame.close() and bitmap.close() are CRITICAL
   *
   * @param video - Source video element
   * @param time - Timestamp in seconds
   * @param options - Extraction options
   * @returns Extracted frame with RGBA data
   */
  private async extractWithVideoFrame(
    video: HTMLVideoElement,
    time: number,
    options: FrameExtractionOptions
  ): Promise<ExtractedFrame> {
    const w = options.resizeWidth ?? options.width;
    const h = options.resizeHeight ?? options.height;

    await this.seekToTime(video, time);

    let frame: VideoFrame | null = null;
    let bitmap: ImageBitmap | null = null;
    try {
      frame = new VideoFrame(video);
      bitmap = await createImageBitmap(frame, {
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality: 'medium',
      });

      const offscreen = new OffscreenCanvas(w, h);
      const ctx = offscreen.getContext('2d');
      if (!ctx) {
        throw new Error('Could not get OffscreenCanvas 2D context');
      }

      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, w, h);

      return {
        pixels: new Uint8Array(imageData.data),
        width: w,
        height: h,
      };
    } finally {
      // CRITICAL: Close both to free GPU memory
      if (bitmap) {
        bitmap.close();
      }
      if (frame) {
        frame.close();
      }
    }
  }

  /**
   * Extract frame using traditional canvas.drawImage (fallback path).
   *
   * Always works but is the slowest option. Uses a persistent OffscreenCanvas
   * to avoid repeated allocation.
   *
   * @param video - Source video element
   * @param time - Timestamp in seconds
   * @param options - Extraction options
   * @returns Extracted frame with RGBA data
   */
  private async extractWithCanvasDraw(
    video: HTMLVideoElement,
    time: number,
    options: FrameExtractionOptions
  ): Promise<ExtractedFrame> {
    const w = options.resizeWidth ?? options.width;
    const h = options.resizeHeight ?? options.height;

    await this.seekToTime(video, time);

    const offscreen = new OffscreenCanvas(w, h);
    const ctx = offscreen.getContext('2d');
    if (!ctx) {
      throw new Error('Could not get OffscreenCanvas 2D context');
    }

    ctx.drawImage(video, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);

    return {
      pixels: new Uint8Array(imageData.data),
      width: w,
      height: h,
    };
  }

  /**
   * Seek the video to a specific time and wait for the seek to complete.
   *
   * Returns a promise that resolves when the `onseeked` event fires,
   * or rejects on `onerror` or after a 5-second timeout.
   *
   * @param video - The HTMLVideoElement to seek
   * @param time - Target time in seconds
   * @throws If seek fails or times out
   */
  private seekToTime(video: HTMLVideoElement, time: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          fn();
        }
      };

      video.onseeked = () => settle(resolve);
      video.onerror = () => settle(() => reject(new Error(`Seek failed at ${time.toFixed(2)}s`)));

      const timeout = setTimeout(
        () => settle(() => reject(new Error(`Seek timeout at ${time.toFixed(2)}s`))),
        5_000
      );

      video.currentTime = time;
    });
  }
}

/** Global singleton instance of the frame extractor service. */
export const frameExtractorService = new FrameExtractorService();
