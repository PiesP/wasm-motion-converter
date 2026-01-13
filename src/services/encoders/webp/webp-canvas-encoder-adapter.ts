/**
 * WebP Canvas Encoder Adapter
 *
 * Main-thread WebP encoder that uses HTMLCanvasElement.toBlob('image/webp').
 *
 * Why this exists:
 * - Some browsers expose OffscreenCanvas in workers but do not support
 *   OffscreenCanvas.convertToBlob({ type: 'image/webp' }) reliably.
 * - In those cases, the worker-based `webp-native` encoder is unavailable, but
 *   main-thread canvas WebP encoding still works.
 *
 * This adapter provides a safe fallback for the encoder factory so callers can
 * request an encoder without special-casing WebP availability.
 */

import {
  WEBP_ANIMATION_MAX_FRAMES,
  WEBP_BACKGROUND_COLOR,
} from '@services/webcodecs/webp-constants';
import { buildWebPFrameDurations, resolveWebPFps } from '@services/webcodecs/webp-timing';
import type { EncoderAdapter, EncoderRequest } from '@services/encoders/encoder-interface';
import { logger } from '@utils/logger';
import type { AnimatedWebPOptions, WebPFrame } from '@utils/webp-muxer';
import { muxAnimatedWebP } from '@utils/webp-muxer';
import { convertFramesToImageData } from '@services/encoders/frame-converter';

export class WebPCanvasEncoderAdapter implements EncoderAdapter {
  name = 'webp-canvas';

  capabilities = {
    formats: ['webp' as const],
    supportsWorkers: false,
    requiresSharedArrayBuffer: false,
    maxFrames: WEBP_ANIMATION_MAX_FRAMES,
    maxDimension: undefined,
    /**
     * Performance score: 9/10 (Very fast)
     *
     * Main-thread canvas.toBlob() with native WebP encoding is highly optimized.
     * Log data: H.264→WebP in ~1s (13x faster than worker-based alternative).
     */
    performanceScore: 9,
  };

  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;

  async isAvailable(): Promise<boolean> {
    try {
      if (typeof document === 'undefined') {
        logger.debug('webp-encoder', 'document is not available (canvas WebP encoder)');
        return false;
      }

      const createdCanvas = document.createElement('canvas');
      createdCanvas.width = 1;
      createdCanvas.height = 1;

      const ctx = createdCanvas.getContext('2d');
      if (!ctx) {
        logger.debug('webp-encoder', 'Canvas 2D context not available (canvas WebP encoder)');
        return false;
      }

      ctx.fillStyle = 'rgb(0,0,0)';
      ctx.fillRect(0, 0, 1, 1);

      const blob = await new Promise<Blob | null>((resolve) => {
        createdCanvas.toBlob(
          (result) => {
            resolve(result);
          },
          'image/webp',
          0.9
        );
      });

      const supportsWebP = Boolean(blob && blob.size > 0 && blob.type === 'image/webp');
      if (!supportsWebP) {
        logger.debug('webp-encoder', 'Canvas WebP encoding not supported');
        return false;
      }

      logger.debug('webp-encoder', 'Canvas WebP encoder available');
      return true;
    } catch (error) {
      logger.debug('webp-encoder', 'Canvas WebP availability check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

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
      throw new Error('No frames to encode');
    }

    const maxFramesAllowed = this.capabilities.maxFrames;
    if (maxFramesAllowed && frames.length > maxFramesAllowed) {
      throw new Error(`Too many frames for WebP: ${frames.length} (max ${maxFramesAllowed})`);
    }

    logger.info('webp-encoder', 'Starting WebP encoding (canvas)', {
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
      if (!this.canvas || !this.context) {
        if (typeof document === 'undefined') {
          throw new Error('document is not available for canvas WebP encoding');
        }

        this.canvas = document.createElement('canvas');
        this.context = this.canvas.getContext('2d');
      }

      if (!this.canvas || !this.context) {
        throw new Error('Canvas context unavailable for WebP encoding');
      }

      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }

      const encodeQuality = quality === 'low' ? 0.75 : quality === 'medium' ? 0.85 : 0.95;

      // Convert frames to ImageData if needed (VideoFrame/ImageBitmap → ImageData)
      const imageDataFrames = await convertFramesToImageData(
        frames,
        width,
        height,
        undefined, // Don't report conversion progress separately
        shouldCancel
      );

      const hwConcurrency = navigator.hardwareConcurrency || 4;
      const chunkSize = Math.min(20, Math.max(10, hwConcurrency * 2));

      const encodedFrames: ArrayBuffer[] = [];

      const encodeFrame = async (frame: ImageData): Promise<ArrayBuffer> => {
        if (shouldCancel?.()) {
          throw new Error('Encoding cancelled');
        }

        if (!this.canvas || !this.context) {
          throw new Error('Canvas resources not initialized');
        }

        if (this.canvas.width !== frame.width || this.canvas.height !== frame.height) {
          this.canvas.width = frame.width;
          this.canvas.height = frame.height;
        }

        this.context.putImageData(frame, 0, 0);

        const blob = await new Promise<Blob>((resolve, reject) => {
          this.canvas?.toBlob(
            (result) => {
              if (result && result.size > 0) {
                resolve(result);
                return;
              }
              reject(new Error('Failed to encode WebP frame via toBlob.'));
            },
            'image/webp',
            encodeQuality
          );
        });

        const buffer = await blob.arrayBuffer();
        return buffer;
      };

      for (let i = 0; i < imageDataFrames.length; i += chunkSize) {
        if (shouldCancel?.()) {
          throw new Error('Encoding cancelled');
        }

        const chunk = imageDataFrames.slice(i, Math.min(i + chunkSize, imageDataFrames.length));
        const encodedChunk = await Promise.all(chunk.map((frame) => encodeFrame(frame)));
        encodedFrames.push(...encodedChunk);
        onProgress?.(encodedFrames.length, imageDataFrames.length);
      }

      if (encodedFrames.length === 0) {
        throw new Error('No frames were encoded');
      }

      const frameCount = encodedFrames.length;
      const effectiveFps = resolveWebPFps(frameCount, fps, durationSeconds);

      const timestampsForDurations =
        timestamps && timestamps.length >= frameCount
          ? timestamps.slice(0, frameCount)
          : Array.from({ length: frameCount }, (_, index) => index / Math.max(1, effectiveFps));

      const durations = buildWebPFrameDurations({
        timestamps: timestampsForDurations,
        fps: effectiveFps,
        frameCount,
        sourceFPS: sourceFPS ?? fps,
        codec,
        durationSeconds,
      });

      const webpFrames: WebPFrame[] = encodedFrames.map((data, index) => ({
        data,
        duration: Math.max(1, durations[index] ?? Math.round(1000 / Math.max(1, effectiveFps))),
      }));

      const muxOptions: AnimatedWebPOptions = {
        width,
        height,
        loopCount: 0,
        backgroundColor: WEBP_BACKGROUND_COLOR,
      };

      const muxedData = await muxAnimatedWebP(webpFrames, muxOptions);
      const blob = new Blob([muxedData], { type: 'image/webp' });

      const elapsedMs = performance.now() - startTime;
      logger.performance('WebP canvas encoding completed', {
        frameCount,
        durationMs: Math.round(elapsedMs),
        outputSize: blob.size,
        fps: effectiveFps,
      });

      return blob;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('webp-encoder', 'WebP canvas encoding failed', {
        error: message,
      });
      throw error;
    } finally {
      await this.dispose();
    }
  }

  async dispose(): Promise<void> {
    this.canvas = null;
    this.context = null;
  }
}
