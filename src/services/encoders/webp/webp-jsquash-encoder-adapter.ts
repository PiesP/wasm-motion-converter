/**
 * WebP jsquash Encoder Adapter
 *
 * Worker-based WebP encoder backed by @jsquash/webp (libwebp WASM).
 *
 * Intended as a practical fallback when native WebP encoding (canvas/offscreen)
 * is unavailable or fails validation, while staying fully client-side.
 */

import {
  WEBP_ANIMATION_MAX_FRAMES,
  WEBP_BACKGROUND_COLOR,
} from '@services/webcodecs/webp-constants';
import { buildWebPFrameDurations, resolveWebPFps } from '@services/webcodecs/webp-timing';
import type { EncoderAdapter, EncoderRequest } from '@services/encoders/encoder-interface';
import { convertFramesToImageData } from '@services/encoders/frame-converter';
import { logger } from '@utils/logger';
import type { AnimatedWebPOptions, WebPFrame } from '@utils/webp-muxer';
import { muxAnimatedWebP } from '@utils/webp-muxer';
import type * as Comlink from 'comlink';

type JsquashWebPEncodeOptions = {
  quality: number;
  method: number;
  lossless?: boolean;
};

interface WebPJsquashWorkerApi {
  encodeFrame(
    imageData: { data: Uint8ClampedArray; width: number; height: number },
    options: JsquashWebPEncodeOptions
  ): Promise<ArrayBuffer>;
  terminate(): void;
}

export class WebPJsquashEncoderAdapter implements EncoderAdapter {
  name = 'webp-jsquash';

  capabilities = {
    formats: ['webp' as const],
    supportsWorkers: true,
    requiresSharedArrayBuffer: false,
    maxFrames: WEBP_ANIMATION_MAX_FRAMES,
    maxDimension: undefined,
  };

  private workers: Array<Comlink.Remote<WebPJsquashWorkerApi>> = [];
  private Comlink: typeof import('comlink') | null = null;

  async isAvailable(): Promise<boolean> {
    if (typeof Worker === 'undefined') {
      return false;
    }

    if (typeof WebAssembly === 'undefined') {
      return false;
    }

    // The actual WASM initialization happens lazily in the worker.
    return true;
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

    logger.info('webp-encoder', 'Starting WebP encoding (jsquash)', {
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
      const workerCount = Math.min(navigator.hardwareConcurrency || 4, 3);
      await this.initializeWorkers(workerCount);

      const imageDataFrames = await convertFramesToImageData(
        frames,
        width,
        height,
        undefined,
        shouldCancel
      );

      const { options, muxQualityHint } = this.getEncodeOptions(quality);

      const encodedFrames = await this.encodeFramesParallel(
        imageDataFrames,
        options,
        onProgress,
        shouldCancel
      );

      if (encodedFrames.length === 0) {
        throw new Error('No frames were encoded');
      }

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

      const webpFrames: WebPFrame[] = encodedFrames.map((data, index) => ({
        data,
        duration: durations[index] ?? Math.round(1000 / Math.max(1, effectiveFps)),
      }));

      const muxOptions: AnimatedWebPOptions = {
        width,
        height,
        loopCount: 0,
        backgroundColor: WEBP_BACKGROUND_COLOR,
      };

      logger.info('webp-encoder', 'Muxing WebP frames (jsquash)', {
        frameCount: webpFrames.length,
        width,
        height,
        muxQualityHint,
      });

      const muxedData = await muxAnimatedWebP(webpFrames, muxOptions);
      const blob = new Blob([muxedData], { type: 'image/webp' });

      const durationMs = performance.now() - startTime;
      logger.performance('WebP encoding completed (jsquash)', {
        frameCount: frames.length,
        durationMs: Math.round(durationMs),
        outputSize: blob.size,
        fps: effectiveFps,
      });

      return blob;
    } finally {
      await this.dispose();
    }
  }

  private getEncodeOptions(quality: EncoderRequest['quality']): {
    options: JsquashWebPEncodeOptions;
    muxQualityHint: string;
  } {
    // jsquash quality: 0..100, method: 0..6 (higher = slower, better compression)
    if (quality === 'low') {
      return { options: { quality: 75, method: 3 }, muxQualityHint: 'low' };
    }

    if (quality === 'medium') {
      return { options: { quality: 85, method: 4 }, muxQualityHint: 'medium' };
    }

    return { options: { quality: 92, method: 5 }, muxQualityHint: 'high' };
  }

  private async initializeWorkers(count: number): Promise<void> {
    if (this.workers.length > 0) {
      return;
    }

    if (!this.Comlink) {
      this.Comlink = await import('comlink');
    }

    for (let i = 0; i < count; i++) {
      const worker = new Worker(
        new URL('../../../workers/webp-jsquash-encoder.worker.ts', import.meta.url),
        {
          type: 'module',
        }
      );

      const wrapped = this.Comlink.wrap<WebPJsquashWorkerApi>(worker);
      this.workers.push(wrapped);
    }

    logger.debug('webp-encoder', 'Worker pool initialized (jsquash)', {
      workerCount: this.workers.length,
    });
  }

  private async encodeFramesParallel(
    frames: ImageData[],
    options: JsquashWebPEncodeOptions,
    onProgress?: (current: number, total: number) => void,
    shouldCancel?: () => boolean
  ): Promise<ArrayBuffer[]> {
    const encodedFrames: ArrayBuffer[] = new Array(frames.length);
    const workerCount = this.workers.length;
    let completedCount = 0;

    const tasks = frames.map(async (frame, index) => {
      if (shouldCancel?.()) {
        throw new Error('Encoding cancelled');
      }

      const workerIndex = index % workerCount;
      const worker = this.workers[workerIndex];
      if (!worker) {
        throw new Error(`Worker ${workerIndex} not available`);
      }

      const imageData = {
        data: frame.data,
        width: frame.width,
        height: frame.height,
      };

      const encoded = await worker.encodeFrame(imageData, options);
      encodedFrames[index] = encoded;

      completedCount += 1;
      onProgress?.(completedCount, frames.length);

      return encoded;
    });

    await Promise.all(tasks);
    return encodedFrames;
  }

  async dispose(): Promise<void> {
    for (const worker of this.workers) {
      try {
        await worker.terminate();
      } catch {
        // Ignore.
      }
    }

    this.workers = [];
    this.Comlink = null;
  }
}
