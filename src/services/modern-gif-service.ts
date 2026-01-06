import { encode } from 'modern-gif';

import { logger } from '../utils/logger';

/**
 * Options for modern-gif encoding
 */
export interface ModernGifOptions {
  width: number;
  height: number;
  fps: number;
  quality: 'low' | 'medium' | 'high';
  loop?: number;
  onProgress?: (current: number, total: number) => void;
  shouldCancel?: () => boolean;
}

/**
 * Quality to max colors mapping for GIF palette optimization
 * - high: 256 colors (full palette, best quality)
 * - medium: 128 colors (balanced)
 * - low: 64 colors (smallest file size)
 */
const QUALITY_TO_MAX_COLORS = { high: 256, medium: 128, low: 64 } as const;

/**
 * Service for encoding GIF animations using modern-gif library
 * Provides GPU-accelerated encoding with better quality than FFmpeg
 */
export class ModernGifService {
  /**
   * Check if modern-gif library is available and supported
   *
   * @returns True if modern-gif encode function is available
   */
  static isSupported(): boolean {
    return typeof encode === 'function';
  }

  /**
   * Encode ImageData frames into animated GIF using modern-gif
   * Uses quality-based color palette optimization for optimal file size
   *
   * @param frames - Array of ImageData frames to encode
   * @param options - Encoding options (width, height, fps, quality, callbacks)
   * @returns Animated GIF as Blob
   * @throws Error if no frames provided or conversion cancelled
   *
   * @example
   * const frames = [imageData1, imageData2, imageData3];
   * const blob = await ModernGifService.encode(frames, {
   *   width: 640,
   *   height: 480,
   *   fps: 30,
   *   quality: 'high',
   *   onProgress: (current, total) => console.log(`${current}/${total}`),
   * });
   */
  static async encode(frames: ImageData[], options: ModernGifOptions): Promise<Blob> {
    if (!frames.length) {
      throw new Error('No frames provided for GIF encoding.');
    }

    const { width, height, fps, quality, onProgress, shouldCancel } = options;

    if (shouldCancel?.()) {
      throw new Error('Conversion cancelled by user');
    }

    // Use quality mapping constant for palette optimization
    const maxColors = QUALITY_TO_MAX_COLORS[quality];

    const startTime = performance.now();

    logger.info('conversion', 'Starting modern-gif encoding', {
      frameCount: frames.length,
      width,
      height,
      fps,
      maxColors,
    });

    // Convert ImageData frames to UnencodedFrame format
    const gifFrames = frames.map((imageData, index) => {
      if (shouldCancel?.()) {
        throw new Error('Conversion cancelled by user');
      }

      onProgress?.(index + 1, frames.length);

      return {
        data: imageData.data,
        delay: Math.max(1, Math.round(1000 / fps)),
      };
    });

    // Encode using modern-gif
    const blob = await encode({
      width,
      height,
      frames: gifFrames,
      maxColors,
      format: 'blob',
    });

    const duration = performance.now() - startTime;

    logger.info('conversion', 'modern-gif encoding completed', {
      frameCount: frames.length,
      fileSize: blob.size,
      duration: Math.round(duration),
      fps,
      maxColors,
    });

    return blob;
  }
}
