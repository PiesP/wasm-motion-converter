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

/** Callback invoked per frame in streaming mode. */
export type StreamingFrameCallback = (
  frameData: Uint8Array,
  frameIndex: number,
  totalFrames: number
) => Promise<void>;

/** Parameters for streaming frame extraction. */
export interface StreamingExtractParams extends ExtractFramesParams {
  /** Callback invoked for each extracted frame (instead of batch accumulation). */
  onFrame: StreamingFrameCallback;
}

/**
 * Fixed-size buffer pool for frame extraction.
 *
 * Reuses a small number of pre-allocated buffers to avoid GC pressure
 * from repeated large Uint8Array allocations during frame extraction.
 *
 * Pool size of 4 balances memory usage (~32MB at 1080p) with concurrency headroom.
 *
 * @example
 * ```ts
 * const pool = new FrameBufferPool(1920 * 1080 * 4, 4);
 * const buf = pool.acquire();
 * await frame.copyTo(buf);
 * // use buf...
 * pool.release(buf);
 * ```
 */
export class FrameBufferPool {
  private readonly buffers: Uint8Array[];
  private readonly available: Uint8Array[];
  private readonly bufferSize: number;

  constructor(bufferSize: number, poolSize = 4) {
    this.bufferSize = bufferSize;
    this.buffers = [];
    this.available = [];
    for (let i = 0; i < poolSize; i++) {
      const buf = new Uint8Array(bufferSize);
      this.buffers.push(buf);
      this.available.push(buf);
    }
  }

  /**
   * Acquire a buffer from the pool.
   *
   * If no buffer is available, allocates a new one (fallback).
   * Always returns a buffer of the configured size.
   */
  acquire(): Uint8Array {
    const buf = this.available.pop();
    if (buf) return buf;
    // Pool exhausted — allocate a new one (will be GC'd)
    logger.debug('conversion', 'FrameBufferPool exhausted, allocating fallback buffer');
    return new Uint8Array(this.bufferSize);
  }

  /**
   * Release a buffer back to the pool for reuse.
   *
   * Only buffers that were originally allocated by this pool are accepted.
   * Non-pool buffers are silently dropped (GC handles them).
   */
  release(buffer: Uint8Array): void {
    if (this.buffers.includes(buffer) && !this.available.includes(buffer)) {
      this.available.push(buffer);
    }
  }

  /** Number of buffers currently available for reuse. */
  get availableCount(): number {
    return this.available.length;
  }

  /** Total number of buffers managed by this pool. */
  get totalCount(): number {
    return this.buffers.length;
  }
}

/**
 * Service for extracting raw RGBA video frames using the best available strategy.
 *
 * Auto-detects browser capabilities and caches the selected strategy.
 * All GPU resources (ImageBitmap, VideoFrame) are properly closed after use.
 *
 * Uses VideoFrame.copyTo() for direct GPU→CPU transfer when no resize is needed,
 * eliminating the ImageBitmap → Canvas → getImageData pipeline.
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
  private bufferPool: FrameBufferPool | null = null;
  private lastBufferPoolKey = 0; // bytesPerFrame used to create current pool

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
   * Get or create the buffer pool for the given frame size.
   *
   * Creates a new pool when the frame size changes, reuses existing pool otherwise.
   * Pool is 4 buffers × frame bytes, ~32MB at 1080p.
   */
  private getBufferPool(bytesPerFrame: number): FrameBufferPool {
    if (this.bufferPool && this.lastBufferPoolKey === bytesPerFrame) {
      return this.bufferPool;
    }
    this.bufferPool = new FrameBufferPool(bytesPerFrame, 4);
    this.lastBufferPoolKey = bytesPerFrame;
    logger.debug('conversion', 'Created FrameBufferPool', { bytesPerFrame, poolSize: 4 });
    return this.bufferPool;
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

  /**
   * Extract frames in streaming mode — invokes `onFrame` callback per frame.
   *
   * Instead of accumulating all frames into a single buffer, this method
   * calls the provided callback for each extracted frame immediately.
   * Uses FrameBufferPool to reuse buffers and minimize GC pressure.
   *
   * @param params - Streaming extraction parameters (includes onFrame callback)
   * @returns Frame metadata (width, height, frameCount)
   */
  async extractFramesStreaming(params: StreamingExtractParams): Promise<{
    frameCount: number;
    width: number;
    height: number;
  }> {
    const { video, fps, duration, options, signal, onProgress, onFrame } = params;
    const strategy = await this.selectStrategy();

    const frameCount = Math.ceil(duration * fps);
    const w = options.resizeWidth ?? options.width;
    const h = options.resizeHeight ?? options.height;
    const bytesPerFrame = w * h * 4;
    const needsResize = w !== options.width || h !== options.height;

    logger.info('conversion', 'Starting streaming frame extraction', {
      strategy,
      frameCount,
      fps,
      duration,
      width: w,
      height: h,
      needsResize,
    });

    performanceTracker.startPhase('frame-extract-streaming', {
      strategy,
      frameCount,
      width: w,
      height: h,
    });

    // Buffer pool for reuse — only used when no resize needed (copyTo path)
    const pool = needsResize ? null : this.getBufferPool(bytesPerFrame);
    let extractedCount = 0;

    try {
      for (let i = 0; i < frameCount; i++) {
        if (signal.aborted) {
          logger.info('conversion', 'Streaming frame extraction cancelled', {
            frame: i,
            total: frameCount,
          });
          break;
        }

        const time = i / fps;
        if (time >= video.duration) {
          logger.debug('conversion', 'Reached end of video duration', { frame: i, time });
          break;
        }

        let frame: ExtractedFrame;
        if (!needsResize && pool) {
          // Fast path: direct copyTo into pooled buffer
          frame = await this.extractWithCopyTo(video, time, options, pool);
        } else {
          // Resize needed — use strategy-specific path
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
        }

        // Clone the pixel data for the callback (pool buffer will be reused)
        const frameCopy = new Uint8Array(frame.pixels);
        await onFrame(frameCopy, i, frameCount);

        extractedCount++;
        onProgress?.(extractedCount, frameCount);
      }
    } finally {
      performanceTracker.endPhase('frame-extract-streaming');
    }

    logger.info('conversion', 'Streaming frame extraction complete', {
      extractedCount,
      expectedCount: frameCount,
    });

    return {
      frameCount: extractedCount,
      width: w,
      height: h,
    };
  }

  // --- Private strategy implementations ---

  /**
   * Extract frame using VideoFrame.copyTo() — fastest direct path.
   *
   * When no resize is needed, this avoids the ImageBitmap → Canvas → getImageData
   * pipeline entirely. Instead:
   * 1. new VideoFrame(video) wraps the current decoded frame
   * 2. frame.copyTo(buffer) performs direct GPU→CPU transfer
   * 3. Buffer is returned from the pool for reuse
   *
   * This eliminates 2 intermediate allocations (ImageBitmap + ImageData)
   * and reduces GPU→CPU transfer from 3 stages to 1.
   *
   * @param video - Source video element
   * @param time - Timestamp in seconds
   * @param options - Extraction options
   * @param pool - Buffer pool for reuse
   * @returns Extracted frame with RGBA data (pixels are pooled — caller must copy)
   */
  private async extractWithCopyTo(
    video: HTMLVideoElement,
    time: number,
    options: FrameExtractionOptions,
    pool: FrameBufferPool
  ): Promise<ExtractedFrame> {
    const w = options.width;
    const h = options.height;

    await this.seekToTime(video, time);

    let frame: VideoFrame | null = null;
    const buffer = pool.acquire();
    try {
      frame = new VideoFrame(video, {
        timestamp: time * 1_000_000, // microseconds
      });

      // Direct GPU→CPU copy into pre-allocated buffer
      await frame.copyTo(buffer);

      return {
        pixels: buffer,
        width: w,
        height: h,
      };
    } finally {
      if (frame) {
        frame.close();
      }
      // Note: buffer is NOT released here — caller must copy data first,
      // then release. This is handled by extractFramesStreaming.
    }
  }

  /**
   * Extract frame using WebCodecs VideoDecoder (hardware-accelerated path).
   *
   * Uses VideoFrame.copyTo() when no resize is needed for direct transfer.
   * Falls back to createImageBitmap + OffscreenCanvas when resize is required.
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
    const needsResize = w !== options.width || h !== options.height;

    await this.seekToTime(video, time);

    let frame: VideoFrame | null = null;
    try {
      frame = new VideoFrame(video, {
        timestamp: time * 1_000_000, // microseconds
      });

      if (!needsResize) {
        // Fast path: direct copyTo, no intermediate allocations
        const buffer = new Uint8Array(w * h * 4);
        await frame.copyTo(buffer);
        return { pixels: buffer, width: w, height: h };
      }

      // Resize needed — use createImageBitmap path
      let bitmap: ImageBitmap | null = null;
      try {
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
        if (bitmap) {
          bitmap.close();
        }
      }
    } finally {
      if (frame) {
        frame.close();
      }
    }
  }

  /**
   * Extract frame using createImageBitmap (GPU-preferred path).
   *
   * Uses VideoFrame.copyTo() when no resize is needed for direct transfer.
   * Falls back to createImageBitmap + OffscreenCanvas when resize is required.
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
    const needsResize = w !== options.width || h !== options.height;

    await this.seekToTime(video, time);

    if (!needsResize) {
      // Fast path: use VideoFrame.copyTo directly
      let frame: VideoFrame | null = null;
      try {
        frame = new VideoFrame(video);
        const buffer = new Uint8Array(w * h * 4);
        await frame.copyTo(buffer);
        return { pixels: buffer, width: w, height: h };
      } finally {
        if (frame) {
          frame.close();
        }
      }
    }

    // Resize needed — use createImageBitmap path
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
   * Uses VideoFrame.copyTo() when no resize is needed for direct transfer.
   * Falls back to createImageBitmap + OffscreenCanvas when resize is required.
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
    const needsResize = w !== options.width || h !== options.height;

    await this.seekToTime(video, time);

    let frame: VideoFrame | null = null;
    try {
      frame = new VideoFrame(video);

      if (!needsResize) {
        // Fast path: direct copyTo
        const buffer = new Uint8Array(w * h * 4);
        await frame.copyTo(buffer);
        return { pixels: buffer, width: w, height: h };
      }

      // Resize needed — use createImageBitmap path
      let bitmap: ImageBitmap | null = null;
      try {
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
        if (bitmap) {
          bitmap.close();
        }
      }
    } finally {
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
   * or rejects on `onerror` or after a 3-second timeout.
   *
   * Ensures forward-only seeking to avoid backward seek penalties.
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
        3_000 // Reduced from 5s to 3s for faster failure detection
      );

      // Ensure forward-only seek to avoid backward seek penalties
      if (time > video.currentTime) {
        video.currentTime = time;
      } else {
        // Already at or past the target time — resolve immediately
        settle(resolve);
      }
    });
  }
}

/** Global singleton instance of the frame extractor service. */
export const frameExtractorService = new FrameExtractorService();
