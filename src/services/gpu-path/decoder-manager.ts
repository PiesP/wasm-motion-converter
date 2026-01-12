/**
 * Decoder Manager
 *
 * Manages WebCodecs VideoDecoder lifecycle with proper error handling and cleanup.
 *
 * Features:
 * - Hardware acceleration preference
 * - Error tracking and reporting
 * - Automatic cleanup
 * - Flush timeout handling
 */

import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

/**
 * Decoder configuration with optional hardware acceleration
 */
export type DecoderConfigWithAcceleration = VideoDecoderConfig & {
  hardwareAcceleration?: 'prefer-hardware' | 'prefer-software' | 'no-preference';
};

/**
 * Decoder manager class
 *
 * Provides high-level API for VideoDecoder operations.
 */
export class DecoderManager {
  private activeDecoders = new Set<VideoDecoder>();

  /**
   * Check if VideoDecoder is supported
   *
   * @returns True if VideoDecoder API is available
   */
  static isSupported(): boolean {
    return typeof VideoDecoder !== 'undefined';
  }

  /**
   * Check if specific decoder configuration is supported
   *
   * @param config - VideoDecoder configuration to check
   * @returns Promise resolving to true if supported
   */
  static async isConfigSupported(config: VideoDecoderConfig): Promise<boolean> {
    if (!DecoderManager.isSupported()) {
      return false;
    }

    try {
      const support = await VideoDecoder.isConfigSupported(config);
      return support.supported ?? false;
    } catch (error) {
      logger.warn('conversion', 'Error checking decoder config support', {
        error: getErrorMessage(error),
        codec: config.codec,
      });
      return false;
    }
  }

  /**
   * Select best decoder configuration
   *
   * Tries configurations in order:
   * 1. Prefer hardware acceleration
   * 2. Prefer software acceleration
   * 3. No preference (original config)
   *
   * @param baseConfig - Base decoder configuration
   * @returns Promise resolving to best supported configuration
   */
  static async selectBestConfig(baseConfig: VideoDecoderConfig): Promise<VideoDecoderConfig> {
    if (!DecoderManager.isSupported() || typeof VideoDecoder.isConfigSupported !== 'function') {
      return baseConfig;
    }

    const base = baseConfig as DecoderConfigWithAcceleration;

    // If already has preference, keep it
    if (base.hardwareAcceleration) {
      return baseConfig;
    }

    const candidates: DecoderConfigWithAcceleration[] = [
      { ...base, hardwareAcceleration: 'prefer-hardware' },
      { ...base, hardwareAcceleration: 'prefer-software' },
      base,
    ];

    for (const candidate of candidates) {
      try {
        const support = await VideoDecoder.isConfigSupported(candidate as VideoDecoderConfig);
        if (support.supported) {
          logger.debug('conversion', 'Selected decoder config', {
            codec: candidate.codec,
            hardwareAcceleration: candidate.hardwareAcceleration ?? 'no-preference',
            usedSupportConfig: Boolean(support.config),
          });
          return (support.config ?? candidate) as VideoDecoderConfig;
        }
      } catch (error) {
        logger.debug('conversion', 'Decoder config check failed', {
          codec: candidate.codec,
          hardwareAcceleration: candidate.hardwareAcceleration ?? 'no-preference',
          error: getErrorMessage(error),
        });
      }
    }

    // Fallback to base config
    return baseConfig;
  }

  /**
   * Create and configure VideoDecoder
   *
   * Automatically selects best configuration (hardware vs software).
   *
   * @param config - Base decoder configuration
   * @param onOutput - Output callback for decoded frames
   * @param onError - Error callback
   * @returns Promise resolving to configured VideoDecoder
   */
  async create(
    config: VideoDecoderConfig,
    onOutput: (frame: VideoFrame) => void,
    onError: (error: Error) => void
  ): Promise<VideoDecoder> {
    if (!DecoderManager.isSupported()) {
      throw new Error('VideoDecoder API is not supported in this browser');
    }

    // Select best config
    const selectedConfig = await DecoderManager.selectBestConfig(config);

    // Create decoder
    const decoder = new VideoDecoder({
      output: onOutput,
      error: (error: Error) => {
        const wrapped = error instanceof Error ? error : new Error(getErrorMessage(error));
        logger.error('conversion', 'VideoDecoder error', {
          error: getErrorMessage(wrapped),
          codec: selectedConfig.codec,
        });
        onError(wrapped);
      },
    });

    // Configure decoder
    decoder.configure(selectedConfig);

    // Track decoder
    this.activeDecoders.add(decoder);
    logger.debug('conversion', 'Created decoder', {
      codec: selectedConfig.codec,
      activeCount: this.activeDecoders.size,
    });

    return decoder;
  }

  /**
   * Flush decoder and wait for all pending frames
   *
   * @param decoder - VideoDecoder to flush
   * @param timeoutMs - Optional timeout in milliseconds (default: 5000)
   * @returns Promise that resolves when flush completes or times out
   */
  async flush(decoder: VideoDecoder, timeoutMs = 5000): Promise<void> {
    if (decoder.state === 'closed') {
      return;
    }

    const flushPromise = decoder.flush();
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`VideoDecoder flush timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      await Promise.race([flushPromise, timeoutPromise]);
    } catch (error) {
      logger.warn('conversion', 'Decoder flush failed or timed out', {
        error: getErrorMessage(error),
        state: decoder.state,
        decodeQueueSize: decoder.decodeQueueSize,
      });
      throw error;
    }
  }

  /**
   * Close decoder and clean up resources
   *
   * @param decoder - VideoDecoder to close
   */
  close(decoder: VideoDecoder): void {
    if (!this.activeDecoders.has(decoder)) {
      // Already closed or not tracked
      return;
    }

    try {
      if (decoder.state !== 'closed') {
        decoder.close();
      }
      this.activeDecoders.delete(decoder);
      logger.debug('conversion', 'Closed decoder', {
        remainingCount: this.activeDecoders.size,
      });
    } catch (error) {
      logger.warn('conversion', 'Error closing decoder', {
        error: getErrorMessage(error),
      });
      // Still remove from tracking
      this.activeDecoders.delete(decoder);
    }
  }

  /**
   * Close all active decoders
   *
   * Safe to call multiple times.
   */
  closeAll(): void {
    const count = this.activeDecoders.size;
    if (count === 0) {
      return;
    }

    logger.debug('conversion', 'Closing all decoders', {
      count,
    });

    // Copy set to avoid modification during iteration
    const decoders = Array.from(this.activeDecoders);
    for (const decoder of decoders) {
      this.close(decoder);
    }
  }

  /**
   * Get number of active decoders
   *
   * @returns Active decoder count
   */
  getActiveCount(): number {
    return this.activeDecoders.size;
  }
}

/**
 * Global decoder manager instance
 */
export const decoderManager = new DecoderManager();
