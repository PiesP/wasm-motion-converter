import type { ConversionQuality } from '../types/conversion-types';
import { QUALITY_PRESETS } from './constants';

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
 * @param sourceFPS - Original video frame rate
 * @param quality - Quality preset (low/medium/high)
 * @param format - Output format (gif/webp)
 * @returns Optimized FPS value
 */
export function getOptimalFPS(
  sourceFPS: number,
  quality: ConversionQuality,
  format: 'gif' | 'webp'
): number {
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
 * @param sourceFPS - Original video frame rate
 * @param quality - Quality preset
 * @param format - Output format
 * @returns True if adaptive FPS differs from preset FPS
 */
export function shouldUseAdaptiveFPS(
  sourceFPS: number,
  quality: ConversionQuality,
  format: 'gif' | 'webp'
): boolean {
  const preset = QUALITY_PRESETS[format][quality];
  const presetFPS = 'fps' in preset ? preset.fps : 15;
  const optimalFPS = getOptimalFPS(sourceFPS, quality, format);

  return optimalFPS !== presetFPS;
}

/**
 * Get FPS optimization explanation for user display
 *
 * @param sourceFPS - Original video frame rate
 * @param quality - Quality preset
 * @param format - Output format
 * @returns Human-readable explanation or undefined if no optimization
 */
export function getFPSOptimizationMessage(
  sourceFPS: number,
  quality: ConversionQuality,
  format: 'gif' | 'webp'
): string | undefined {
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
