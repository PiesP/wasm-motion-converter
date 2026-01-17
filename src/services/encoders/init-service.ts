/**
 * Encoder Initialization
 *
 * Registers all encoder adapters with the encoder factory.
 * Import this file early in the application lifecycle to ensure
 * encoders are available when needed.
 *
 * Usage:
 * ```typescript
 * import './services/encoders/init';
 * ```
 */

import { EncoderFactory } from '@services/encoders/encoder-factory-service';
import { GIFEncoderAdapter } from '@services/encoders/gif/gif-encoder-adapter-service';
import { MP4EncoderAdapter } from '@services/encoders/mp4/mp4-encoder-adapter-service';
import { WebPCanvasEncoderAdapter } from '@services/encoders/webp/webp-canvas-encoder-adapter-service';
import { WebPEncoderAdapter } from '@services/encoders/webp/webp-encoder-adapter-service';
import { logger } from '@utils/logger';

const ENCODER_REGISTRATION_START = 'Registering encoder adapters';
const ENCODER_REGISTRATION_COMPLETE = 'Encoder registration complete';

/**
 * Register all encoder adapters
 */
function initializeEncoders(): void {
  logger.info('encoders', ENCODER_REGISTRATION_START);

  // Register GIF encoder (fully implemented)
  EncoderFactory.register(new GIFEncoderAdapter());

  // Register WebP encoders
  // - webp-native: worker-based OffscreenCanvas.convertToBlob
  // - webp-canvas: main-thread HTMLCanvasElement.toBlob fallback
  EncoderFactory.register(new WebPEncoderAdapter());
  EncoderFactory.register(new WebPCanvasEncoderAdapter());

  // Register MP4 encoder (WebCodecs H.264 + MP4 container muxing)
  EncoderFactory.register(new MP4EncoderAdapter());

  const stats = EncoderFactory.getStats();
  logger.info('encoders', ENCODER_REGISTRATION_COMPLETE, {
    totalEncoders: stats.totalRegistered,
    byFormat: stats.byFormat,
  });
}

// Auto-initialize on module load
initializeEncoders();
