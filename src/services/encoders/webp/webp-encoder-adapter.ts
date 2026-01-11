/**
 * WebP Encoder Adapter (STUB)
 *
 * Placeholder for libwebp-wasm integration.
 * Currently falls back to FFmpeg for WebP encoding.
 *
 * TODO (Phase 3): Implement proper libwebp-wasm encoding with worker support
 */

import { logger } from '@utils/logger';
import type { EncoderAdapter, EncoderRequest } from '../encoder-interface';

/**
 * WebP encoder adapter (stub implementation)
 *
 * This is a placeholder that will be replaced with proper libwebp-wasm
 * integration in Phase 3. For now, WebP encoding goes through FFmpeg.
 */
export class WebPEncoderAdapter implements EncoderAdapter {
  name = 'webp-stub';

  capabilities = {
    formats: ['webp' as const],
    supportsWorkers: false, // Will be true when implemented
    requiresSharedArrayBuffer: false,
    maxFrames: 240, // WebP animation limit
    maxDimension: undefined,
  };

  /**
   * Check if WebP encoding is available
   *
   * Currently returns false to force FFmpeg fallback.
   * Will return true when libwebp-wasm is integrated.
   */
  async isAvailable(): Promise<boolean> {
    logger.debug('webp-encoder', 'WebP encoder stub - not available (FFmpeg fallback)');
    return false; // TODO: Implement availability check
  }

  /**
   * Encode frames to WebP (stub)
   *
   * Currently throws error - WebP encoding goes through FFmpeg.
   */
  async encode(_request: EncoderRequest): Promise<Blob> {
    logger.error('webp-encoder', 'WebP encoder stub called - should use FFmpeg fallback');
    throw new Error(
      'WebP encoder not yet implemented. This should not be called - ' +
        'WebP encoding currently goes through FFmpeg fallback.'
    );
  }

  /**
   * Clean up resources (stub)
   */
  async dispose(): Promise<void> {
    logger.debug('webp-encoder', 'Disposed WebP encoder stub');
  }
}
