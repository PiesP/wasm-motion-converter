/**
 * MP4 Encoder Adapter (STUB)
 *
 * Placeholder for WebCodecs VideoEncoder integration.
 * MP4 output is a new feature to be implemented in Phase 3.
 *
 * TODO (Phase 3): Implement WebCodecs VideoEncoder for H.264/AV1 encoding
 */

import { logger } from '@utils/logger';
import type { EncoderAdapter, EncoderRequest } from '../encoder-interface';

/**
 * MP4 encoder adapter (stub implementation)
 *
 * This is a placeholder for future MP4 encoding support using
 * WebCodecs VideoEncoder API. Not yet implemented.
 */
export class MP4EncoderAdapter implements EncoderAdapter {
  name = 'mp4-stub';

  capabilities = {
    formats: [], // Empty for now - MP4 not yet supported
    supportsWorkers: false, // VideoEncoder is main-thread only
    requiresSharedArrayBuffer: false,
    maxFrames: undefined,
    maxDimension: 4096, // WebCodecs typical limit
  };

  /**
   * Check if MP4 encoding is available
   *
   * Currently returns false - MP4 output not yet implemented.
   */
  async isAvailable(): Promise<boolean> {
    // TODO: Check for VideoEncoder API support
    // return typeof VideoEncoder !== 'undefined';
    logger.debug('mp4-encoder', 'MP4 encoder stub - not yet implemented');
    return false;
  }

  /**
   * Encode frames to MP4 (stub)
   *
   * Not yet implemented.
   */
  async encode(_request: EncoderRequest): Promise<Blob> {
    logger.error('mp4-encoder', 'MP4 encoder not yet implemented');
    throw new Error('MP4 encoding not yet implemented');
  }

  /**
   * Clean up resources (stub)
   */
  async dispose(): Promise<void> {
    logger.debug('mp4-encoder', 'Disposed MP4 encoder stub');
  }
}
