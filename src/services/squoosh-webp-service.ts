import { encode } from '@jsquash/webp';
import { logger } from '../utils/logger';

export interface SquooshWebPOptions {
  quality: 'low' | 'medium' | 'high';
  onProgress?: (current: number, total: number) => void;
  shouldCancel?: () => boolean;
}

export class SquooshWebPService {
  static isSupported(): boolean {
    return typeof encode === 'function';
  }

  /**
   * Encode static WebP using @jsquash/webp
   * Note: Only supports single frame (static WebP)
   * For animated WebP, use FFmpeg fallback
   */
  static async encode(frame: ImageData, options: SquooshWebPOptions): Promise<Blob> {
    if (!frame) {
      throw new Error('No frame provided for WebP encoding.');
    }

    if (options.shouldCancel?.()) {
      throw new Error('Conversion cancelled by user');
    }

    const { quality } = options;

    // Quality mapping: high=95, medium=85, low=70
    const qualityMap = { high: 95, medium: 85, low: 70 };
    const webpQuality = qualityMap[quality];

    const startTime = performance.now();

    logger.info('conversion', 'Starting @jsquash/webp encoding', {
      width: frame.width,
      height: frame.height,
      quality: webpQuality,
    });

    // Encode using @jsquash/webp
    const webpData = await encode(frame, {
      quality: webpQuality,
      target_size: 0,
      target_PSNR: 0,
      method: 6, // 0-6, higher = slower but better compression
      sns_strength: 50,
      filter_strength: 60,
      filter_sharpness: 0,
      filter_type: 1,
      partitions: 0,
      segments: 4,
      pass: 1,
      show_compressed: 0,
      preprocessing: 0,
      autofilter: 0,
      partition_limit: 0,
      alpha_compression: 1,
      alpha_filtering: 1,
      alpha_quality: 100,
      lossless: 0,
      exact: 0,
      image_hint: 0,
      emulate_jpeg_size: 0,
      thread_level: 0,
      low_memory: 0,
      near_lossless: 100,
      use_delta_palette: 0,
      use_sharp_yuv: 0,
    });

    const duration = performance.now() - startTime;

    logger.info('conversion', '@jsquash/webp encoding completed', {
      fileSize: webpData.byteLength,
      duration: Math.round(duration),
      quality: webpQuality,
    });

    options.onProgress?.(1, 1);

    return new Blob([webpData], { type: 'image/webp' });
  }
}
