import { encode } from 'modern-gif';
import { logger } from '../utils/logger';

export interface ModernGifOptions {
  width: number;
  height: number;
  fps: number;
  quality: 'low' | 'medium' | 'high';
  loop?: number;
  onProgress?: (current: number, total: number) => void;
  shouldCancel?: () => boolean;
}

export class ModernGifService {
  static isSupported(): boolean {
    return typeof encode === 'function';
  }

  static async encode(frames: ImageData[], options: ModernGifOptions): Promise<Blob> {
    if (!frames.length) {
      throw new Error('No frames provided for GIF encoding.');
    }

    const { width, height, fps, quality, onProgress, shouldCancel } = options;

    if (shouldCancel?.()) {
      throw new Error('Conversion cancelled by user');
    }

    // Quality mapping: high=256 (most colors), medium=128, low=64
    const qualityMap = { high: 256, medium: 128, low: 64 };
    const maxColors = qualityMap[quality];

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
