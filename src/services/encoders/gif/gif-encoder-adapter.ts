/**
 * GIF Encoder Adapter
 *
 * Wraps modern-gif-service.ts to provide EncoderAdapter interface.
 * Supports both main-thread and worker-based encoding.
 */

import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { encodeModernGif, isModernGifSupported } from '../../modern-gif-service';
import type { EncoderAdapter, EncoderRequest } from '../encoder-interface';

/**
 * GIF encoder adapter using modern-gif (gifski-wasm)
 *
 * Provides high-quality GIF encoding with dithering and palette optimization.
 */
export class GIFEncoderAdapter implements EncoderAdapter {
  name = 'modern-gif';

  capabilities = {
    formats: ['gif' as const],
    supportsWorkers: true,
    requiresSharedArrayBuffer: false,
    maxFrames: undefined,
    maxDimension: undefined,
  };

  /**
   * Check if modern-gif is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      return isModernGifSupported();
    } catch (error) {
      logger.warn('gif-encoder', 'Error checking modern-gif availability', {
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  /**
   * Encode frames to GIF
   */
  async encode(request: EncoderRequest): Promise<Blob> {
    const { frames, width, height, fps, quality, onProgress, shouldCancel } = request;

    logger.info('gif-encoder', 'Starting GIF encoding', {
      frameCount: frames.length,
      dimensions: `${width}x${height}`,
      fps,
      quality,
    });

    if (frames.length === 0) {
      throw new Error('No frames to encode');
    }

    try {
      // Encode GIF - pass frames directly with options
      const blob = await encodeModernGif(frames, {
        width,
        height,
        fps,
        quality,
        onProgress: (current: number, total: number) => {
          onProgress?.(current, total);
        },
        shouldCancel,
      });

      logger.info('gif-encoder', 'GIF encoding complete', {
        frameCount: frames.length,
        outputSize: `${(blob.size / 1024).toFixed(1)}KB`,
      });

      return blob;
    } catch (error) {
      logger.error('gif-encoder', 'GIF encoding failed', {
        error: getErrorMessage(error),
        frameCount: frames.length,
      });
      throw error;
    }
  }

  /**
   * Clean up resources
   */
  async dispose(): Promise<void> {
    // modern-gif service doesn't require cleanup
    logger.debug('gif-encoder', 'Disposed GIF encoder');
  }
}
