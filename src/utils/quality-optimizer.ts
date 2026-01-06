import type { ConversionQuality } from '../types/conversion-types';
import { QUALITY_PRESETS } from './constants';

/**
 * Supported output formats for conversion
 */
type ConversionFormat = 'gif' | 'webp';

/**
 * Calculate optimal FPS based on source video FPS and quality preset
 *
 * Strategy:
 * - Don't exceed source FPS (wasteful - upsampling doesn't add quality)
 * - Don't go below preset FPS (maintains quality floor)
 * - Returns min(sourceFPS, presetFPS) for best balance
 *
 * Examples:
 * - 30 FPS source, high quality (24 FPS preset) → 24 FPS (no wasted upsampling)
 * - 10 FPS source, medium quality (15 FPS preset) → 10 FPS (no fake interpolation)
 * - 60 FPS source, high quality (24 FPS preset) → 24 FPS (reasonable downsampling)
 *
 * @param sourceFPS - Original video frame rate (must be > 0)
 * @param quality - Quality preset (low/medium/high)
 * @param format - Output format (gif/webp)
 * @returns Optimized FPS value between 1 and 60
 * @throws Error if sourceFPS is not a positive number
 *
 * @example
 * const fps = getOptimalFPS(30, 'high', 'gif'); // Returns 24
 * const fps = getOptimalFPS(10, 'medium', 'webp'); // Returns 10
 */
export function getOptimalFPS(
  sourceFPS: number,
  quality: ConversionQuality,
  format: ConversionFormat
): number {
  // Validate input
  if (!Number.isFinite(sourceFPS) || sourceFPS <= 0) {
    throw new Error(`Invalid sourceFPS: ${sourceFPS}. Must be a positive number.`);
  }

  // Get preset FPS for this quality/format combination
  const preset = QUALITY_PRESETS[format][quality];
  const presetFPS = 'fps' in preset ? preset.fps : 15;

  // Don't exceed source FPS (no point in upsampling frames)
  // Don't go below preset FPS (maintains quality baseline)
  const optimalFPS = Math.min(sourceFPS, presetFPS);

  // Ensure we have a valid FPS (at least 1, at most 60)
  return Math.max(1, Math.min(60, Math.round(optimalFPS)));
}

/**
 * Check if adaptive FPS would provide benefit over preset FPS
 *
 * Adaptive FPS is beneficial when the source FPS differs significantly from
 * the preset FPS, allowing for optimization based on actual input characteristics.
 *
 * @param sourceFPS - Original video frame rate (must be > 0)
 * @param quality - Quality preset (low/medium/high)
 * @param format - Output format (gif/webp)
 * @returns True if adaptive FPS differs from preset FPS, false otherwise
 * @throws Error if sourceFPS is not a positive number
 *
 * @example
 * const shouldAdapt = shouldUseAdaptiveFPS(10, 'high', 'gif'); // true (10 < 24)
 * const shouldAdapt = shouldUseAdaptiveFPS(24, 'high', 'gif'); // false (24 == 24)
 */
export function shouldUseAdaptiveFPS(
  sourceFPS: number,
  quality: ConversionQuality,
  format: ConversionFormat
): boolean {
  if (!Number.isFinite(sourceFPS) || sourceFPS <= 0) {
    throw new Error(`Invalid sourceFPS: ${sourceFPS}. Must be a positive number.`);
  }

  const preset = QUALITY_PRESETS[format][quality];
  const presetFPS = 'fps' in preset ? preset.fps : 15;
  const optimalFPS = getOptimalFPS(sourceFPS, quality, format);

  return optimalFPS !== presetFPS;
}

/**
 * Get FPS optimization explanation for user display
 *
 * Provides a human-readable explanation of why and how the FPS was adjusted
 * based on source FPS and quality preset. Useful for transparency in UI.
 *
 * @param sourceFPS - Original video frame rate (must be > 0)
 * @param quality - Quality preset (low/medium/high)
 * @param format - Output format (gif/webp)
 * @returns Human-readable explanation or undefined if no optimization applied
 * @throws Error if sourceFPS is not a positive number
 *
 * @example
 * // For 10 FPS source with 15 FPS preset
 * const msg = getFPSOptimizationMessage(10, 'medium', 'gif');
 * // Returns: "Matched output FPS to source (10 FPS) to avoid unnecessary interpolation"
 *
 * @example
 * // For 30 FPS source with 24 FPS preset
 * const msg = getFPSOptimizationMessage(30, 'high', 'webp');
 * // Returns: undefined (no optimization needed)
 */
export function getFPSOptimizationMessage(
  sourceFPS: number,
  quality: ConversionQuality,
  format: ConversionFormat
): string | undefined {
  if (!Number.isFinite(sourceFPS) || sourceFPS <= 0) {
    throw new Error(`Invalid sourceFPS: ${sourceFPS}. Must be a positive number.`);
  }

  const optimalFPS = getOptimalFPS(sourceFPS, quality, format);
  const preset = QUALITY_PRESETS[format][quality];
  const presetFPS = 'fps' in preset ? preset.fps : 15;

  if (optimalFPS === presetFPS) {
    return undefined;
  }

  if (optimalFPS < presetFPS) {
    return `Matched output FPS to source (${optimalFPS} FPS) to avoid unnecessary interpolation`;
  }

  // This shouldn't happen due to min() logic, but included for completeness
  return `Limited output FPS to preset maximum (${optimalFPS} FPS)`;
}
