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

import type {
  EncoderAdapter,
  EncoderPreferences,
} from '@services/encoders/encoder-interface-service';
import type { ConversionFormat } from '@t/conversion-types';
import { logger } from '@utils/logger';

const DEFAULT_PERFORMANCE_SCORE = 5;
const FORMAT_SPECIALIZATION_BONUS = 1.2;
const WORKER_SUPPORT_BONUS = 1.1;
const MINUTES_TO_MS = 60_000;
const ONE_MINUTE_LABEL = '<1 min';

/**
 * Availability cache entry with timestamp
 */
interface AvailabilityCacheEntry {
  available: boolean;
  timestamp: number;
}

/**
 * Encoder factory class
 *
 * Singleton registry for all encoder implementations. Provides capability-based
 * selection and lazy initialization with performance-based ranking.
 */
class EncoderFactoryClass {
  /**
   * Availability cache TTL (30 minutes)
   *
   * Encoders can become temporarily unavailable due to:
   * - CDN failures for WASM modules
   * - Worker initialization timeouts
   * - Browser resource constraints
   *
   * Cache invalidates after 30 minutes to allow recovery from transient failures.
   */
  private static readonly AVAILABILITY_CACHE_TTL_MS = 30 * MINUTES_TO_MS;

  private encoders = new Map<string, EncoderAdapter>();
  private availabilityCache = new Map<string, AvailabilityCacheEntry>();

  /**
   * Invalidate cached availability for a single encoder.
   *
   * Some encoders can become temporarily unavailable at runtime (e.g. CDN/WASM failures).
   * This allows adapters to force re-evaluation on the next selection.
   */
  invalidateAvailability(name: string): void {
    this.availabilityCache.delete(name);
  }

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
   * Check if cached availability is still valid
   *
   * @param entry - Cache entry
   * @returns True if cache entry is fresh
   */
  private isCacheValid(entry: AvailabilityCacheEntry): boolean {
    const age = Date.now() - entry.timestamp;
    return age < EncoderFactoryClass.AVAILABILITY_CACHE_TTL_MS;
  }

  /**
   * Calculate encoder score for selection priority
   *
   * Combines performance score with format specialization and worker support.
   * Higher scores are tried first.
   *
   * @param encoder - Encoder to score
   * @param format - Target format
   * @returns Priority score (higher = better)
   */
  private calculateEncoderScore(encoder: EncoderAdapter, format: ConversionFormat): number {
    // Base score from encoder's performance rating (default to 5 if not specified)
    let score = encoder.capabilities.performanceScore ?? DEFAULT_PERFORMANCE_SCORE;

    // Format specialization bonus (20%)
    // Single-format encoders are typically more optimized than multi-format ones
    if (encoder.capabilities.formats.length === 1 && encoder.capabilities.formats[0] === format) {
      score *= FORMAT_SPECIALIZATION_BONUS;
    }

    // Worker support bonus (10%)
    // Worker-based encoders can parallelize work, improving performance
    if (encoder.capabilities.supportsWorkers) {
      score *= WORKER_SUPPORT_BONUS;
    }

    return score;
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
   * 2. Check availability (browser capabilities, WASM support, etc.) with TTL caching
   * 3. Sort by performance score (considers performance rating, format specialization, worker support)
   * 4. Apply user preferences (worker support overrides if specified)
   * 5. Return best available encoder
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

    // Check availability for each candidate (with TTL-based caching)
    const availableEncoders: EncoderAdapter[] = [];

    for (const encoder of candidates) {
      const cached = this.availabilityCache.get(encoder.name);

      // Use cache if valid (within TTL)
      if (cached !== undefined && this.isCacheValid(cached)) {
        if (cached.available) {
          availableEncoders.push(encoder);
        }
        continue;
      }

      // Cache miss or expired - check availability
      try {
        const available = await encoder.isAvailable();
        this.availabilityCache.set(encoder.name, {
          available,
          timestamp: Date.now(),
        });

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
        this.availabilityCache.set(encoder.name, {
          available: false,
          timestamp: Date.now(),
        });
      }
    }

    if (availableEncoders.length === 0) {
      logger.warn('encoder-factory', `No available encoders for format: ${format}`, {
        format,
        candidates: candidates.map((e) => e.name),
      });
      return null;
    }

    // Sort encoders by performance score (highest first)
    availableEncoders.sort((a, b) => {
      const scoreA = this.calculateEncoderScore(a, format);
      const scoreB = this.calculateEncoderScore(b, format);
      return scoreB - scoreA; // Descending order (best first)
    });

    logger.debug('encoder-factory', 'Encoder ranking by performance', {
      format,
      ranking: availableEncoders.map((e) => ({
        name: e.name,
        score: this.calculateEncoderScore(e, format).toFixed(2),
        performanceScore: e.capabilities.performanceScore ?? 5,
      })),
    });

    // Apply user preferences (can override performance ranking)
    let selected: EncoderAdapter = availableEncoders[0]!;

    // Prefer worker-based encoders if explicitly requested
    if (preferences.preferWorkers) {
      const workerEncoder = availableEncoders.find((e) => e.capabilities.supportsWorkers);
      if (workerEncoder) {
        selected = workerEncoder;
        logger.debug('encoder-factory', 'Selected worker-based encoder (user preference)', {
          name: selected.name,
        });
      }
    }

    logger.info('encoder-factory', `Selected encoder: ${selected.name} for format: ${format}`, {
      encoder: selected.name,
      format,
      performanceScore: selected.capabilities.performanceScore ?? 5,
      calculatedScore: this.calculateEncoderScore(selected, format).toFixed(2),
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
    availabilityCache: Record<string, { available: boolean; age: string }>;
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

    // Convert cache to human-readable format
    const availabilityCache: Record<string, { available: boolean; age: string }> = {};
    for (const [name, entry] of this.availabilityCache.entries()) {
      const ageMs = Date.now() - entry.timestamp;
      const ageMinutes = Math.floor(ageMs / MINUTES_TO_MS);
      availabilityCache[name] = {
        available: entry.available,
        age: ageMinutes < 1 ? ONE_MINUTE_LABEL : `${ageMinutes} min`,
      };
    }

    return {
      totalRegistered: this.encoders.size,
      byFormat,
      availabilityCache,
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
