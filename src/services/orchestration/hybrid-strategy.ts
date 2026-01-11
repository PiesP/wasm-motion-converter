/**
 * Hybrid Strategy Module (Future Implementation)
 *
 * This module provides codec-specific path optimization for video conversion.
 * It will be implemented in a future iteration to enable fine-grained control
 * over conversion routing based on codec performance characteristics.
 *
 * Current Status: PLACEHOLDER
 * - All GIF/WebP conversions currently use GPU-first strategy
 * - CPU path is used as fallback when GPU path fails
 *
 * Future Implementation Plan:
 * 1. Add codec-specific benchmarking data
 * 2. Implement per-codec path selection logic
 * 3. Add performance metrics collection
 * 4. Create adaptive path selection based on success rates
 *
 * @module orchestration/hybrid-strategy
 */

import type { CodecPathPreference, ConversionPath, HybridStrategyConfig } from './types';
import type { ConversionFormat } from '@t/conversion-types';

// ============================================================================
// BENCHMARK DATA (To be collected)
// ============================================================================
// This section will contain real-world performance data for different
// codec + format + path combinations to enable data-driven routing decisions.
//
// Example structure:
// ```ts
// const CODEC_BENCHMARKS = {
//   'h264-webp-gpu': { avgTime: 5.2, successRate: 0.98 },
//   'h264-webp-cpu': { avgTime: 90.0, successRate: 0.45 },
//   'h264-gif-gpu': { avgTime: 12.0, successRate: 0.95 },
//   'h264-gif-cpu': { avgTime: 8.5, successRate: 0.99 },
//   'av1-webp-gpu': { avgTime: 63.0, successRate: 1.00 },
//   'av1-gif-gpu': { avgTime: 15.0, successRate: 0.98 }
// };
// ```
// ============================================================================

// ============================================================================
// DEFAULT HYBRID STRATEGY CONFIGURATION
// ============================================================================
// Currently disabled - using simple GPU-first routing for all GIF/WebP.
// Will be enabled once codec-specific preferences are defined.
// ============================================================================

/**
 * Default hybrid strategy configuration
 *
 * @internal
 */
const DEFAULT_HYBRID_CONFIG: HybridStrategyConfig = {
  enableCodecOptimization: false, // Disabled until benchmarks collected
  codecPreferences: [
    // Future codec preferences will be added here
    // Example:
    // {
    //   codec: 'h264',
    //   format: 'webp',
    //   preferredPath: 'gpu',
    //   fallbackPath: 'cpu',
    //   reason: 'H.264 WebP: GPU path 18x faster (5s vs 90s)',
    //   benchmarks: { avgTimeSeconds: 5.2, successRate: 0.98 }
    // }
  ],
  defaultPath: 'gpu',
  fallbackChain: ['gpu', 'cpu'],
};

// ============================================================================
// HYBRID STRATEGY API (Future Implementation)
// ============================================================================

/**
 * Get optimal conversion path for codec and format
 *
 * Future implementation will use codec-specific benchmarks to select
 * the fastest and most reliable path.
 *
 * Current implementation: Returns GPU path for all GIF/WebP conversions.
 *
 * @param codec - Video codec (e.g., 'h264', 'av1', 'vp9')
 * @param format - Target format (gif, webp, mp4)
 * @param config - Optional hybrid strategy configuration
 * @returns Optimal conversion path with fallback
 *
 * @example
 * ```ts
 * const path = getOptimalPath('h264', 'webp');
 * // Returns: { preferred: 'gpu', fallback: 'cpu', reason: '...' }
 * ```
 */
export function getOptimalPath(
  codec: string | undefined,
  format: ConversionFormat,
  config: HybridStrategyConfig = DEFAULT_HYBRID_CONFIG
): { preferred: ConversionPath; fallback: ConversionPath; reason: string } {
  // Current implementation: GPU-first for all GIF/WebP
  if (format === 'gif' || format === 'webp') {
    return {
      preferred: 'gpu',
      fallback: 'cpu',
      reason: `GPU-first strategy for ${format.toUpperCase()} (codec: ${codec || 'unknown'})`,
    };
  }

  // Future implementation will check codec-specific preferences:
  // if (config.enableCodecOptimization) {
  //   const preference = findCodecPreference(codec, format, config.codecPreferences);
  //   if (preference) {
  //     return {
  //       preferred: preference.preferredPath,
  //       fallback: preference.fallbackPath,
  //       reason: preference.reason
  //     };
  //   }
  // }

  // Default fallback
  return {
    preferred: config.defaultPath,
    fallback: 'cpu',
    reason: 'Default path selection',
  };
}

/**
 * Find codec-specific path preference
 *
 * Future helper function to lookup codec preferences.
 *
 * @internal
 */
export function findCodecPreference(
  codec: string | undefined,
  _format: ConversionFormat,
  preferences: CodecPathPreference[]
): CodecPathPreference | undefined {
  if (!codec) return undefined;

  const normalizedCodec = codec.toLowerCase();
  return preferences.find(
    (pref) =>
      pref.codec.toLowerCase() === normalizedCodec ||
      normalizedCodec.includes(pref.codec.toLowerCase())
  );
}

/**
 * Validate hybrid strategy configuration
 *
 * Future helper to validate configuration structure.
 *
 * @internal
 */
export function validateHybridConfig(config: HybridStrategyConfig): boolean {
  // Basic validation
  if (!config.defaultPath || !config.fallbackChain || config.fallbackChain.length === 0) {
    return false;
  }

  // Validate codec preferences structure
  for (const pref of config.codecPreferences) {
    if (!pref.codec || !pref.format || !pref.preferredPath || !pref.fallbackPath) {
      return false;
    }
  }

  return true;
}

// ============================================================================
// FUTURE ENHANCEMENTS
// ============================================================================
// 1. Performance Metrics Collection:
//    - Track actual conversion times per codec/format/path
//    - Calculate success rates over time
//    - Adaptive path selection based on recent performance
//
// 2. Machine Learning Integration:
//    - Predict optimal path based on video characteristics
//    - Consider file size, resolution, duration in decisions
//
// 3. User Preferences:
//    - Allow manual path override
//    - Remember user's preferred quality/speed tradeoff
//
// 4. A/B Testing:
//    - Gradually roll out new codec preferences
//    - Compare performance across different strategies
// ============================================================================
