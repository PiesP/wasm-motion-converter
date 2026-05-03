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
import { WebPCanvasEncoderAdapter } from '@services/encoders/webp/webp-canvas-encoder-adapter-service';
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

  // Register WebP canvas encoder (main-thread HTMLCanvasElement.toBlob fallback)
  // Note: webp-native (worker-based OffscreenCanvas) was removed — it was
  // ~13x slower than canvas.toBlob and never selected by EncoderFactory.
  EncoderFactory.register(new WebPCanvasEncoderAdapter());

  const stats = EncoderFactory.getStats();
  logger.info('encoders', ENCODER_REGISTRATION_COMPLETE, {
    totalEncoders: stats.totalRegistered,
    byFormat: stats.byFormat,
  });
}

// Auto-initialize on module load
initializeEncoders();
