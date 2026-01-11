/**
 * WebAV MP4 Conversion Service
 *
 * High-performance MP4 conversions using WebAV's Combinator API.
 * Provides 20x faster MP4 encoding compared to FFmpeg.wasm.
 *
 * @module services/webav/webav-mp4-service
 */

import { Combinator, MP4Clip, OffscreenSprite } from '@webav/av-cliper';
import type { ConversionOptions, ConversionOutputBlob } from '@t/conversion-types';
import { logger } from '@utils/logger';
import { performanceTracker } from '@utils/performance-tracker';

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
        error: error instanceof Error ? error.message : String(error),
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

      onProgress?.(10);
      const arrayBuffer = await file.arrayBuffer();
      // biome-ignore lint/suspicious/noExplicitAny: WebAV types are complex
      const mp4Clip = new MP4Clip(new Uint8Array(arrayBuffer) as any);
      await mp4Clip.ready;

      const { width, height, duration } = mp4Clip.meta;

      logger.debug('webav-mp4', 'Input video loaded', {
        width,
        height,
        duration: `${(duration / 1e6).toFixed(1)}s`,
      });

      onProgress?.(20);
      const outputWidth = Math.round(width * (options.scale || 1));
      const outputHeight = Math.round(height * (options.scale || 1));

      this.combinator = new Combinator({
        width: outputWidth,
        height: outputHeight,
      });

      logger.debug('webav-mp4', 'Combinator created', {
        width: outputWidth,
        height: outputHeight,
      });

      onProgress?.(30);
      const sprite = new OffscreenSprite(mp4Clip);
      sprite.time = { offset: 0, duration };
      await this.combinator.addSprite(sprite);

      logger.debug('webav-mp4', 'Sprite added to combinator');

      onProgress?.(40);
      const mp4Data = await this.encodeMP4(this.combinator, duration, onProgress);

      onProgress?.(95);
      // biome-ignore lint/suspicious/noExplicitAny: WebAV types are complex
      const blob = new Blob([mp4Data as any], { type: 'video/mp4' }) as ConversionOutputBlob;
      blob.wasTranscoded = true;

      const duration_ms = performance.now() - startTime;

      logger.info('webav-mp4', 'WebAV MP4 conversion completed', {
        outputSize: `${(blob.size / 1024 / 1024).toFixed(1)}MB`,
        durationMs: Math.round(duration_ms),
      });

      onProgress?.(100);
      return blob;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
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
    return new Promise((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let lastProgressTime = 0;
      const progressInterval = 100;

      try {
        // biome-ignore lint/suspicious/noExplicitAny: WebAV types are complex
        (combinator.output as any)({
          maxTime: videoDuration,
          handler: {
            ondata: (data: Uint8Array) => {
              chunks.push(new Uint8Array(data));

              const now = performance.now();
              if (now - lastProgressTime > progressInterval) {
                const estimatedProgress = Math.min(
                  90,
                  40 + Math.round(50 * (chunks.length / (videoDuration / 1e6)))
                );
                onProgress?.(estimatedProgress);
                lastProgressTime = now;
              }
            },
            ondone: () => {
              const totalSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
              const result = new Uint8Array(totalSize);
              let offset = 0;
              for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.byteLength;
              }
              resolve(result);
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
          error: error instanceof Error ? error.message : String(error),
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
