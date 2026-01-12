/**
 * Encoder Factory
 *
 * Registry and factory for pluggable encoder implementations.
 * Provides capability-based encoder selection and lifecycle management.
 *
 * Usage:
 * 1. Register encoders: EncoderFactory.register(new GIFEncoderAdapter())
 * 2. Get encoder: const encoder = await EncoderFactory.getEncoder('gif')
 * 3. Use encoder: const blob = await encoder.encode(request)
 * 4. Cleanup: await encoder.dispose()
 */

import type { ConversionFormat } from '@t/conversion-types';
import { logger } from '@utils/logger';
import type { EncoderAdapter, EncoderPreferences } from './encoder-interface';

/**
 * Encoder factory class
 *
 * Singleton registry for all encoder implementations. Provides capability-based
 * selection and lazy initialization.
 */
class EncoderFactoryClass {
  private encoders = new Map<string, EncoderAdapter>();
  private availabilityCache = new Map<string, boolean>();

  /**
   * Register an encoder
   *
   * @param encoder - Encoder implementation to register
   *
   * @example
   * EncoderFactory.register(new GIFEncoderAdapter());
   * EncoderFactory.register(new WebPEncoderAdapter());
   */
  register(encoder: EncoderAdapter): void {
    if (this.encoders.has(encoder.name)) {
      logger.warn('encoder-factory', `Encoder ${encoder.name} already registered, overwriting`, {
        name: encoder.name,
      });
    }

    this.encoders.set(encoder.name, encoder);
    logger.debug('encoder-factory', `Registered encoder: ${encoder.name}`, {
      name: encoder.name,
      formats: encoder.capabilities.formats,
      supportsWorkers: encoder.capabilities.supportsWorkers,
    });
  }

  /**
   * Unregister an encoder
   *
   * @param name - Encoder name to unregister
   */
  unregister(name: string): void {
    if (this.encoders.delete(name)) {
      this.availabilityCache.delete(name);
      logger.debug('encoder-factory', `Unregistered encoder: ${name}`, {
        name,
      });
    }
  }

  /**
   * Get all registered encoders
   *
   * @returns Array of registered encoders
   */
  getAll(): EncoderAdapter[] {
    return Array.from(this.encoders.values());
  }

  /**
   * Get encoder by name
   *
   * @param name - Encoder name
   * @returns Encoder or undefined if not found
   */
  getByName(name: string): EncoderAdapter | undefined {
    return this.encoders.get(name);
  }

  /**
   * Get optimal encoder for format and preferences
   *
   * Selection strategy:
   * 1. Filter by format support
   * 2. Check availability (browser capabilities, WASM support, etc.)
   * 3. Apply preferences (worker support, quality)
   * 4. Return first available encoder
   *
   * @param format - Target format (gif, webp, mp4)
   * @param preferences - Optional encoder preferences
   * @returns Promise resolving to encoder or null if none available
   *
   * @example
   * const encoder = await EncoderFactory.getEncoder('gif', {
   *   preferWorkers: true,
   *   quality: 'high'
   * });
   */
  async getEncoder(
    format: ConversionFormat,
    preferences: EncoderPreferences = {}
  ): Promise<EncoderAdapter | null> {
    logger.debug('encoder-factory', `Selecting encoder for format: ${format}`, {
      format,
      preferences,
    });

    // Get all encoders that support this format
    const candidates = Array.from(this.encoders.values()).filter((encoder) =>
      encoder.capabilities.formats.includes(format)
    );

    if (candidates.length === 0) {
      logger.warn('encoder-factory', `No encoders registered for format: ${format}`, {
        format,
        registeredEncoders: Array.from(this.encoders.keys()),
      });
      return null;
    }

    logger.debug('encoder-factory', `Found ${candidates.length} encoder(s) for format`, {
      format,
      candidates: candidates.map((e) => e.name),
    });

    // Check availability for each candidate (with caching)
    const availableEncoders: EncoderAdapter[] = [];

    for (const encoder of candidates) {
      const cached = this.availabilityCache.get(encoder.name);

      if (cached !== undefined) {
        if (cached) {
          availableEncoders.push(encoder);
        }
        continue;
      }

      try {
        const available = await encoder.isAvailable();
        this.availabilityCache.set(encoder.name, available);

        if (available) {
          availableEncoders.push(encoder);
          logger.debug('encoder-factory', `Encoder ${encoder.name} is available`, {
            name: encoder.name,
          });
        } else {
          logger.debug('encoder-factory', `Encoder ${encoder.name} is not available`, {
            name: encoder.name,
          });
        }
      } catch (error) {
        logger.warn('encoder-factory', `Error checking encoder availability: ${encoder.name}`, {
          name: encoder.name,
          error: error instanceof Error ? error.message : String(error),
        });
        this.availabilityCache.set(encoder.name, false);
      }
    }

    if (availableEncoders.length === 0) {
      logger.error('encoder-factory', `No available encoders for format: ${format}`, {
        format,
        candidates: candidates.map((e) => e.name),
      });
      return null;
    }

    // Get first available encoder (safely, since length > 0)
    const firstEncoder = availableEncoders[0];
    if (!firstEncoder) {
      logger.error('encoder-factory', `Failed to get first encoder for format: ${format}`, {
        format,
      });
      return null;
    }

    // Apply preferences to select best encoder
    let selected: EncoderAdapter = firstEncoder;

    // Prefer worker-based encoders if requested
    if (preferences.preferWorkers) {
      const workerEncoder = availableEncoders.find((e) => e.capabilities.supportsWorkers);
      if (workerEncoder) {
        selected = workerEncoder;
        logger.debug('encoder-factory', 'Selected worker-based encoder (preferred)', {
          name: selected.name,
        });
      }
    }

    logger.info('encoder-factory', `Selected encoder: ${selected.name} for format: ${format}`, {
      encoder: selected.name,
      format,
      supportsWorkers: selected.capabilities.supportsWorkers,
      requiresSharedArrayBuffer: selected.capabilities.requiresSharedArrayBuffer,
    });

    return selected;
  }

  /**
   * Clear availability cache
   *
   * Use this when browser capabilities may have changed (e.g., after feature detection).
   */
  clearCache(): void {
    this.availabilityCache.clear();
    logger.debug('encoder-factory', 'Cleared encoder availability cache');
  }

  /**
   * Check if any encoder is available for format
   *
   * Quick check without full encoder selection.
   *
   * @param format - Target format
   * @returns Promise resolving to true if at least one encoder is available
   */
  async hasEncoder(format: ConversionFormat): Promise<boolean> {
    const encoder = await this.getEncoder(format);
    return encoder !== null;
  }

  /**
   * Get encoder statistics
   *
   * Debugging helper to see registered encoders and their availability.
   *
   * @returns Statistics object
   */
  getStats(): {
    totalRegistered: number;
    byFormat: Record<string, string[]>;
    availabilityCache: Record<string, boolean>;
  } {
    const byFormat: Record<string, string[]> = {};

    for (const encoder of this.encoders.values()) {
      for (const format of encoder.capabilities.formats) {
        if (!byFormat[format]) {
          byFormat[format] = [];
        }
        byFormat[format].push(encoder.name);
      }
    }

    return {
      totalRegistered: this.encoders.size,
      byFormat,
      availabilityCache: Object.fromEntries(this.availabilityCache),
    };
  }

  /**
   * Reset factory (clear all encoders and cache)
   *
   * Primarily for testing.
   */
  reset(): void {
    this.encoders.clear();
    this.availabilityCache.clear();
    logger.debug('encoder-factory', 'Reset encoder factory');
  }
}

/**
 * Singleton encoder factory instance
 */
export const EncoderFactory = new EncoderFactoryClass();
