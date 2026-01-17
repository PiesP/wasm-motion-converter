/**
 * WebAV MP4 Conversion Service
 *
 * High-performance MP4 conversions using WebAV's Combinator API.
 * Provides 20x faster MP4 encoding compared to FFmpeg.wasm.
 *
 * @module services/webav/webav-mp4-service
 */

import type { ConversionOptions, ConversionOutputBlob } from '@t/conversion-types';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { performanceTracker } from '@utils/performance-tracker';

// Type definitions for lazy-loaded @webav/av-cliper

// biome-ignore lint/suspicious/noExplicitAny: WebAV types are complex
type Mp4ClipInput = Uint8Array | any;

type AVCliperModule = typeof import('@webav/av-cliper');

type Combinator = InstanceType<AVCliperModule['Combinator']>;

// Cached module reference for lazy loading
let avCliperModule: AVCliperModule | null = null;

const PROGRESS_LIMITS = {
  init: 10,
  load: 20,
  sprite: 30,
  encode: 40,
  finalize: 95,
  done: 100,
} as const;

const PROGRESS_SAMPLE_INTERVAL_MS = 100;

/**
 * Lazy-load @webav/av-cliper module
 */
async function loadAVCliper(): Promise<AVCliperModule> {
  if (!avCliperModule) {
    logger.debug('webav-mp4', 'Loading @webav/av-cliper module');
    avCliperModule = await import('@webav/av-cliper');
  }
  return avCliperModule;
}

function createProgressEstimator(durationMicros: number): (chunkCount: number) => number {
  const durationSeconds = durationMicros > 0 ? durationMicros / 1e6 : 1;
  return (chunkCount: number): number =>
    Math.min(90, PROGRESS_LIMITS.encode + Math.round(50 * (chunkCount / durationSeconds)));
}

function setProgress(value: number, onProgress?: (progress: number) => void): void {
  onProgress?.(value);
}

/**
 * WebAV MP4 Conversion Service
 */
export class WebAVMP4Service {
  private combinator: Combinator | null = null;
  private abortController: AbortController | null = null;

  /**
   * Check if WebAV MP4 conversion is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') {
        logger.debug('webav-mp4', 'Required WebCodecs APIs not available');
        return false;
      }

      logger.debug('webav-mp4', 'WebAV MP4 service available');
      return true;
    } catch (error) {
      logger.debug('webav-mp4', 'WebAV availability check failed', {
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  /**
   * Convert video file to MP4 using WebAV
   */
  async convertToMP4(
    file: File,
    options: ConversionOptions,
    onProgress?: (progress: number) => void
  ): Promise<ConversionOutputBlob> {
    performanceTracker.startPhase('webav-mp4-conversion');

    const startTime = performance.now();
    this.abortController = new AbortController();

    try {
      logger.info('webav-mp4', 'Starting WebAV MP4 conversion', {
        fileName: file.name,
        fileSize: file.size,
        quality: options.quality,
        scale: options.scale,
      });

      const { MP4Clip, Combinator: CombinatorClass, OffscreenSprite } = await loadAVCliper();

      setProgress(PROGRESS_LIMITS.init, onProgress);
      const arrayBuffer = await file.arrayBuffer();
      const mp4Clip = new MP4Clip(new Uint8Array(arrayBuffer) as Mp4ClipInput);
      await mp4Clip.ready;

      const { width, height, duration } = mp4Clip.meta;

      logger.debug('webav-mp4', 'Input video loaded', {
        width,
        height,
        duration: `${(duration / 1e6).toFixed(1)}s`,
      });

      setProgress(PROGRESS_LIMITS.load, onProgress);
      const outputWidth = Math.round(width * (options.scale || 1));
      const outputHeight = Math.round(height * (options.scale || 1));

      this.combinator = new CombinatorClass({
        width: outputWidth,
        height: outputHeight,
      });

      logger.debug('webav-mp4', 'Combinator created', {
        width: outputWidth,
        height: outputHeight,
      });

      setProgress(PROGRESS_LIMITS.sprite, onProgress);
      const sprite = new OffscreenSprite(mp4Clip);
      sprite.time = { offset: 0, duration };
      await this.combinator.addSprite(sprite);

      logger.debug('webav-mp4', 'Sprite added to combinator');

      setProgress(PROGRESS_LIMITS.encode, onProgress);
      const mp4Data = await this.encodeMP4(this.combinator, duration, onProgress);

      setProgress(PROGRESS_LIMITS.finalize, onProgress);
      const blob = new Blob([mp4Data.slice().buffer], {
        type: 'video/mp4',
      }) as ConversionOutputBlob;
      blob.wasTranscoded = true;

      const durationMs = performance.now() - startTime;

      logger.info('webav-mp4', 'WebAV MP4 conversion completed', {
        outputSize: `${(blob.size / 1024 / 1024).toFixed(1)}MB`,
        durationMs: Math.round(durationMs),
      });

      setProgress(PROGRESS_LIMITS.done, onProgress);
      return blob;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      logger.error('webav-mp4', 'WebAV MP4 conversion failed', { error: errorMessage });
      throw new Error(`WebAV MP4 conversion failed: ${errorMessage}`);
    } finally {
      await this.cleanup();
      performanceTracker.endPhase('webav-mp4-conversion');
    }
  }

  /**
   * Encode combinator output to MP4
   */
  private async encodeMP4(
    combinator: Combinator,
    videoDuration: number,
    onProgress?: (progress: number) => void
  ): Promise<Uint8Array> {
    const estimateProgress = createProgressEstimator(videoDuration);

    return new Promise((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let lastProgressTime = 0;

      try {
        // biome-ignore lint/suspicious/noExplicitAny: WebAV types are complex
        (combinator.output as any)({
          maxTime: videoDuration,
          handler: {
            ondata: (data: Uint8Array) => {
              chunks.push(new Uint8Array(data));

              const now = performance.now();
              if (now - lastProgressTime > PROGRESS_SAMPLE_INTERVAL_MS) {
                setProgress(estimateProgress(chunks.length), onProgress);
                lastProgressTime = now;
              }
            },
            ondone: () => {
              resolve(this.concatChunks(chunks));
            },
            onerror: (error: Error) => {
              reject(error);
            },
          },
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private concatChunks(chunks: Uint8Array[]): Uint8Array {
    const totalSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const result = new Uint8Array(totalSize);
    let offset = 0;

    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return result;
  }

  /**
   * Cleanup resources
   */
  private async cleanup(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.combinator) {
      try {
        // biome-ignore lint/suspicious/noExplicitAny: WebAV types are complex
        await (this.combinator as any).destroy?.();
      } catch (error) {
        logger.debug('webav-mp4', 'Error cleaning up combinator', {
          error: getErrorMessage(error),
        });
      }
      this.combinator = null;
    }
  }

  /**
   * Cancel ongoing conversion
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}

/**
 * Create WebAV MP4 service instance
 */
export function createWebAVMP4Service(): WebAVMP4Service {
  return new WebAVMP4Service();
}
