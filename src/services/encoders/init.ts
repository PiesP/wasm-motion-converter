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

import { logger } from '../../utils/logger';
import { EncoderFactory } from './encoder-factory';
import { GIFEncoderAdapter } from './gif/gif-encoder-adapter';
import { MP4EncoderAdapter } from './mp4/mp4-encoder-adapter';
import { WebPEncoderAdapter } from './webp/webp-encoder-adapter';

/**
 * Register all encoder adapters
 */
export function initializeEncoders(): void {
  logger.info('encoders', 'Registering encoder adapters');

  // Register GIF encoder (fully implemented)
  EncoderFactory.register(new GIFEncoderAdapter());

  // Register WebP encoder (stub - will be implemented in Phase 3)
  EncoderFactory.register(new WebPEncoderAdapter());

  // Register MP4 encoder (stub - will be implemented in Phase 3)
  EncoderFactory.register(new MP4EncoderAdapter());

  const stats = EncoderFactory.getStats();
  logger.info('encoders', 'Encoder registration complete', {
    totalEncoders: stats.totalRegistered,
    byFormat: stats.byFormat,
  });
}

// Auto-initialize on module load
initializeEncoders();
