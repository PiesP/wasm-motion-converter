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
import { EncoderFactory } from '@services/encoders/encoder-factory';
import { convertFramesToImageData } from '@services/encoders/frame-converter';
import { logger } from '@utils/logger';
import { withTimeout } from '@utils/with-timeout';
import type { AnimatedWebPOptions, WebPFrame } from '@utils/webp-muxer';
import { muxAnimatedWebP } from '@utils/webp-muxer';
import type * as Comlink from 'comlink';

import webpJsquashEncoderWorkerUrl from '@/workers/webp-jsquash-encoder.worker?worker&url';

const JSQUASH_DISABLE_COOLDOWN_MS = 10 * 60_000;
const JSQUASH_WARMUP_TIMEOUT_MS = 12_000;
const JSQUASH_WARMUP_RETRY_TIMEOUT_MS = 6_000;
const JSQUASH_WARMUP_KEEPALIVE_MS = 2_000;

let jsquashDisabledUntil = 0;
let jsquashConsecutiveFailures = 0;

function isJsquashTemporarilyDisabled(): boolean {
  return Date.now() < jsquashDisabledUntil;
}

type JsquashWebPEncodeOptions = {
  quality: number;
  method: number;
  lossless?: boolean;
};

interface WebPJsquashWorkerApi {
  warmup(): Promise<void>;
  getDebugInfo(): Promise<{
    comlinkUrl: string;
    jsquashUrl: string;
    webpEncWasmUrl: string;
    webpEncSimdWasmUrl: string;
  }>;
  encodeFrame(
    imageData: { data: Uint8ClampedArray; width: number; height: number },
    options: JsquashWebPEncodeOptions
  ): Promise<ArrayBuffer>;
  terminate(): Promise<void>;
}

export class WebPJsquashEncoderAdapter implements EncoderAdapter {
  name = 'webp-jsquash';

  capabilities = {
    formats: ['webp' as const],
    supportsWorkers: true,
    requiresSharedArrayBuffer: false,
    maxFrames: WEBP_ANIMATION_MAX_FRAMES,
    maxDimension: undefined,
    /**
     * Performance score: 6/10 (Medium)
     *
     * WASM-based libwebp encoder with worker parallelization.
     * Provides good fallback when native WebP encoding is unavailable,
     * but slower than native canvas.toBlob(). Used as compatibility layer.
     */
    performanceScore: 6,
  };

  private workers: Array<Comlink.Remote<WebPJsquashWorkerApi>> = [];
  private workerHandles: Worker[] = [];
  private Comlink: typeof import('comlink') | null = null;

  private hardTerminateWorkers(reason: string): void {
    if (this.workerHandles.length === 0) {
      return;
    }

    logger.warn('webp-encoder', 'Hard-terminating jsquash worker pool', {
      reason,
      workerCount: this.workerHandles.length,
    });

    for (const handle of this.workerHandles) {
      try {
        handle.terminate();
      } catch {
        // Ignore.
      }
    }

    this.workerHandles = [];
    this.workers = [];
  }

  async isAvailable(): Promise<boolean> {
    if (isJsquashTemporarilyDisabled()) {
      return false;
    }

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

      const totalFramesForProgress = Math.max(1, frames.length);
      const warmupHeartbeat = setInterval(() => {
        onProgress?.(0, totalFramesForProgress);
      }, JSQUASH_WARMUP_KEEPALIVE_MS);

      // Warm up WASM early so we can fail fast and fall back to the canvas muxer.
      // Without this, a stalled CDN/WASM fetch can hang the entire encode with no progress.
      onProgress?.(0, totalFramesForProgress);

      const warmupTimeoutMs =
        jsquashConsecutiveFailures > 0
          ? JSQUASH_WARMUP_RETRY_TIMEOUT_MS
          : JSQUASH_WARMUP_TIMEOUT_MS;

      try {
        await this.warmupWorkers({ timeoutMs: warmupTimeoutMs });
      } finally {
        clearInterval(warmupHeartbeat);
      }

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

  private async warmupWorkers(params: { timeoutMs: number }): Promise<void> {
    const { timeoutMs } = params;

    if (this.workers.length === 0) {
      throw new Error('jsquash worker pool is not initialized');
    }

    try {
      await Promise.all(
        this.workers.map((worker) =>
          withTimeout(
            worker.warmup(),
            timeoutMs,
            `jsquash WebP worker warmup timed out after ${Math.round(timeoutMs / 1000)}s`
          )
        )
      );
    } catch (error) {
      let debugInfo: unknown = null;

      try {
        const firstWorker = this.workers[0];
        if (firstWorker) {
          debugInfo = await withTimeout(
            firstWorker.getDebugInfo(),
            1_000,
            'jsquash worker debug info request timed out'
          );
        }
      } catch {
        // Ignore.
      }

      const message = error instanceof Error ? error.message : String(error);

      jsquashConsecutiveFailures += 1;
      jsquashDisabledUntil = Date.now() + JSQUASH_DISABLE_COOLDOWN_MS;
      EncoderFactory.invalidateAvailability(this.name);

      this.hardTerminateWorkers(`warmup_failed: ${message}`);

      logger.warn('webp-encoder', 'jsquash worker warmup failed (temporarily disabling)', {
        error: message,
        debugInfo,
        consecutiveFailures: jsquashConsecutiveFailures,
        disabledForMs: JSQUASH_DISABLE_COOLDOWN_MS,
      });

      throw error;
    }

    jsquashConsecutiveFailures = 0;
    jsquashDisabledUntil = 0;
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
      const worker = new Worker(webpJsquashEncoderWorkerUrl, {
        type: 'module',
      });
      this.workerHandles.push(worker);

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

    // Keep the watchdog alive during long per-frame encodes.
    // The monitoring layer uses time-since-last-progress, not strictly monotonic percent.
    const heartbeat = setInterval(() => {
      onProgress?.(completedCount, Math.max(1, frames.length));
    }, 5_000);

    let didHardTerminate = false;
    const hardTerminateOnce = (reason: string): void => {
      if (didHardTerminate) {
        return;
      }
      didHardTerminate = true;
      this.hardTerminateWorkers(reason);
    };

    try {
      const tasks = frames.map(async (frame, index) => {
        if (shouldCancel?.()) {
          hardTerminateOnce('cancelled');
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

        const encoded = await withTimeout(
          worker.encodeFrame(imageData, options),
          30_000,
          'jsquash WebP frame encoding timed out',
          () => hardTerminateOnce('frame_encode_timeout')
        );

        encodedFrames[index] = encoded;

        completedCount += 1;
        onProgress?.(completedCount, frames.length);

        return encoded;
      });

      await Promise.all(tasks);
      return encodedFrames;
    } finally {
      clearInterval(heartbeat);
    }
  }

  async dispose(): Promise<void> {
    // Prefer hard termination to avoid hanging on Comlink when the worker is wedged.
    this.hardTerminateWorkers('dispose');
    this.Comlink = null;
  }
}
