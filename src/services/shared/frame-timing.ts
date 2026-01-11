/**
 * Frame Timing Utilities
 *
 * Unified timing calculations for video conversion. Consolidates logic from:
 * - webcodecs/webp-timing.ts (WebP-specific timing)
 * - utils/quality-optimizer.ts (FPS optimization)
 *
 * Provides functions for:
 * - FPS calculation and optimization
 * - Frame duration calculation
 * - Timestamp alignment
 * - Animation duration resolution
 *
 * All functions handle edge cases (invalid durations, zero FPS, etc.) and
 * provide detailed logging for debugging timing issues.
 */

import type { ConversionQuality, VideoMetadata } from '../../types/conversion-types';
import { QUALITY_PRESETS } from '../../utils/constants';
import { logger } from '../../utils/logger';
import { isComplexCodec } from '../webcodecs/codec-utils';
import {
  FPS_DOWNSAMPLING_THRESHOLD,
  MAX_WEBP_DURATION_24BIT,
  MIN_WEBP_FRAME_DURATION_MS,
  WEBP_ANIMATION_MAX_DURATION_SECONDS,
  WEBP_ANIMATION_MAX_FRAMES,
} from '../webcodecs/webp-constants';

/**
 * Supported output formats for FPS optimization
 */
type ConversionFormat = 'gif' | 'webp';

// ============================================================================
// FPS Optimization (from quality-optimizer.ts)
// ============================================================================

/**
 * Calculate optimal FPS based on source video FPS and quality preset
 *
 * Strategy:
 * - Don't exceed source FPS (wasteful - upsampling doesn't add quality)
 * - Don't go below preset FPS (maintains quality floor)
 * - Returns min(sourceFPS, presetFPS) for best balance
 *
 * Examples:
 * - 30 FPS source, high quality (30 FPS preset) → 30 FPS (perfect match)
 * - 10 FPS source, medium quality (20 FPS preset) → 10 FPS (no fake interpolation)
 * - 60 FPS source, high quality (30 FPS preset) → 30 FPS (reasonable downsampling)
 *
 * @param sourceFPS - Original video frame rate (must be > 0)
 * @param quality - Quality preset (low/medium/high)
 * @param format - Output format (gif/webp)
 * @returns Optimized FPS value between 1 and 60
 * @throws Error if sourceFPS is not a positive number
 *
 * @example
 * const fps = getOptimalFPS(30, 'high', 'gif'); // Returns 30
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
 * const shouldAdapt = shouldUseAdaptiveFPS(10, 'high', 'gif'); // true (10 < 30)
 * const shouldAdapt = shouldUseAdaptiveFPS(30, 'high', 'gif'); // false (30 == 30)
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

// ============================================================================
// WebP Frame Timing (from webcodecs/webp-timing.ts)
// ============================================================================

/**
 * Calculate maximum WebP frame count
 *
 * Limits frame count based on duration and FPS to prevent memory issues.
 * Caps at WEBP_ANIMATION_MAX_FRAMES (240) and WEBP_ANIMATION_MAX_DURATION_SECONDS (10s).
 *
 * @param targetFps - Target frames per second
 * @param durationSeconds - Optional video duration in seconds
 * @returns Maximum number of frames to extract
 *
 * @example
 * const maxFrames = getMaxWebPFrames(10, 5); // Returns 50 (5s * 10fps)
 * const maxFrames = getMaxWebPFrames(30, 15); // Returns 240 (capped at max)
 */
export function getMaxWebPFrames(targetFps: number, durationSeconds?: number): number {
  // NOTE: FFmpeg metadata probing can return duration=0 for some containers/codecs.
  // Treat non-positive / non-finite durations as unknown to avoid clamping the
  // extraction window to 1s (which severely under-samples frames and causes choppy motion).
  if (durationSeconds !== undefined) {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      logger.warn(
        'conversion',
        'Invalid duration provided for WebP frame budget; falling back to default budget window',
        {
          durationSeconds,
          targetFps,
        }
      );
    } else if (durationSeconds < 1) {
      logger.debug('conversion', 'Short duration provided for WebP frame budget; using default', {
        durationSeconds,
        targetFps,
      });
    }
  }

  const safeDurationSeconds =
    durationSeconds && Number.isFinite(durationSeconds) && durationSeconds >= 1
      ? durationSeconds
      : undefined;

  const cappedDuration = Math.max(
    1,
    Math.min(
      safeDurationSeconds ?? WEBP_ANIMATION_MAX_DURATION_SECONDS,
      WEBP_ANIMATION_MAX_DURATION_SECONDS
    )
  );
  const estimatedFrames = Math.ceil(cappedDuration * Math.max(1, targetFps));
  const maxFrames = Math.max(1, Math.min(estimatedFrames, WEBP_ANIMATION_MAX_FRAMES));

  logger.debug(
    'conversion',
    `Computed WebP frame extraction budget: targetFps=${targetFps}, durationUsedSeconds=${(
      safeDurationSeconds ?? WEBP_ANIMATION_MAX_DURATION_SECONDS
    ).toFixed(
      3
    )}, cappedDurationSeconds=${cappedDuration.toFixed(3)}, estimatedFrames=${estimatedFrames}, maxFrames=${maxFrames}`,
    {
      targetFps,
      durationSeconds: durationSeconds ?? null,
      durationUsedSeconds: safeDurationSeconds ?? WEBP_ANIMATION_MAX_DURATION_SECONDS,
      cappedDurationSeconds: cappedDuration,
      estimatedFrames,
      maxFrames,
    }
  );

  return maxFrames;
}

/**
 * Resolve effective animation duration for WebP output
 *
 * Uses the longest known duration (metadata or captured duration) capped to the
 * WebP animation limit to avoid unintended speed-ups.
 *
 * @param frameCount - Number of captured frames
 * @param targetFps - Target frames per second
 * @param metadata - Optional video metadata with duration
 * @param captureDurationSeconds - Optional actual capture duration
 * @returns Resolved duration in seconds, or undefined if cannot determine
 *
 * @example
 * const duration = resolveAnimationDurationSeconds(120, 10, { duration: 12 });
 * // Returns 10 (capped at WEBP_ANIMATION_MAX_DURATION_SECONDS)
 */
export function resolveAnimationDurationSeconds(
  frameCount: number,
  targetFps: number,
  metadata?: VideoMetadata,
  captureDurationSeconds?: number
): number | undefined {
  if (frameCount <= 0) {
    return undefined;
  }

  const durationCandidates: number[] = [];

  if (metadata?.duration && Number.isFinite(metadata.duration) && metadata.duration > 0) {
    durationCandidates.push(metadata.duration);
  }

  if (
    captureDurationSeconds &&
    Number.isFinite(captureDurationSeconds) &&
    captureDurationSeconds > 0
  ) {
    durationCandidates.push(captureDurationSeconds);
  }

  if (durationCandidates.length === 0) {
    return undefined;
  }

  const maxDurationSeconds = Math.max(...durationCandidates);
  const cappedDurationSeconds = Math.min(maxDurationSeconds, WEBP_ANIMATION_MAX_DURATION_SECONDS);
  const minimumDurationSeconds = Math.max(0.016, 1 / Math.max(targetFps || 1, 60));

  return Math.max(minimumDurationSeconds, cappedDurationSeconds);
}

/**
 * Derive an FPS value that matches captured frames to the effective duration
 *
 * Clamps to the requested target FPS to avoid overspeed playback.
 *
 * @param frameCount - Number of captured frames
 * @param targetFps - Target frames per second
 * @param durationSeconds - Optional actual duration
 * @returns Resolved FPS (rounded to 3 decimal places)
 *
 * @example
 * const fps = resolveWebPFps(100, 10, 10.5); // Returns 9.524
 */
export function resolveWebPFps(
  frameCount: number,
  targetFps: number,
  durationSeconds?: number
): number {
  if (!Number.isFinite(targetFps) || targetFps <= 0) {
    return 1;
  }

  if (frameCount <= 0) {
    return Math.max(1, Math.round(targetFps));
  }

  const safeDurationSeconds =
    durationSeconds && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : frameCount / targetFps;

  const derivedFps = frameCount / Math.max(safeDurationSeconds, 1 / targetFps);
  const clampedFps = Math.max(1, Math.min(targetFps, derivedFps));

  return Math.round(clampedFps * 1000) / 1000;
}

/**
 * Build a stable, duration-aligned timestamp series for WebP frame encoding
 *
 * Creates evenly-spaced timestamps that respect minimum frame duration constraints.
 *
 * @param params - Timestamp generation parameters
 * @param params.frameCount - Number of frames
 * @param params.durationSeconds - Total duration (optional)
 * @param params.fallbackFps - FPS to use if duration unknown
 * @returns Array of timestamps in seconds
 *
 * @example
 * const timestamps = buildDurationAlignedTimestamps({
 *   frameCount: 10,
 *   durationSeconds: 1.0,
 *   fallbackFps: 10
 * });
 * // Returns [0, 0.1, 0.2, ..., 0.9]
 */
export function buildDurationAlignedTimestamps(params: {
  frameCount: number;
  durationSeconds?: number;
  fallbackFps: number;
}): number[] {
  const { frameCount, durationSeconds, fallbackFps } = params;

  if (frameCount <= 0) {
    return [];
  }

  const safeDurationSeconds =
    durationSeconds && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : frameCount / Math.max(1, fallbackFps);

  const minStepSeconds = MIN_WEBP_FRAME_DURATION_MS / 1000;
  const stepSeconds = Math.max(minStepSeconds, safeDurationSeconds / frameCount);

  return Array.from({ length: frameCount }, (_, index) => index * stepSeconds);
}

/**
 * Build uniform WebP frame durations
 *
 * Creates equal-duration frames that sum to the target total duration.
 * Distributes rounding errors evenly across frames.
 *
 * @param params - Duration generation parameters
 * @param params.frameCount - Number of frames
 * @param params.totalDurationMs - Total animation duration in milliseconds
 * @returns Array of frame durations in milliseconds
 */
function buildUniformWebPDurations(params: {
  frameCount: number;
  totalDurationMs: number;
}): number[] {
  const { frameCount, totalDurationMs } = params;

  if (frameCount <= 0) {
    return [];
  }

  const safeTotalMs = Math.max(0, Math.round(totalDurationMs));
  const minTotalMs = frameCount * MIN_WEBP_FRAME_DURATION_MS;
  const clampedTotalMs = Math.max(minTotalMs, safeTotalMs);

  const base = Math.floor(clampedTotalMs / frameCount);
  const remainder = clampedTotalMs - base * frameCount;

  return Array.from({ length: frameCount }, (_, index) =>
    Math.min(
      MAX_WEBP_DURATION_24BIT,
      Math.max(MIN_WEBP_FRAME_DURATION_MS, base + (index < remainder ? 1 : 0))
    )
  );
}

/**
 * Normalize WebP frame durations to match target total
 *
 * Adjusts durations in 1ms increments to match target total while respecting
 * MIN/MAX duration constraints. Spreads adjustments evenly across frames.
 *
 * @param params - Normalization parameters
 * @param params.durations - Initial frame durations
 * @param params.targetTotalMs - Target total duration in milliseconds
 * @returns Normalized frame durations
 */
function normalizeWebPDurationsToTotal(params: {
  durations: number[];
  targetTotalMs: number;
}): number[] {
  const { durations, targetTotalMs } = params;

  if (!durations.length) {
    return durations;
  }

  const target = Math.max(0, Math.round(targetTotalMs));
  const normalized = durations.map((duration) =>
    Math.min(MAX_WEBP_DURATION_24BIT, Math.max(MIN_WEBP_FRAME_DURATION_MS, Math.round(duration)))
  );

  let currentTotal = normalized.reduce((sum, value) => sum + value, 0);
  let diff = target - currentTotal;

  // Usually diff is small (rounding error). Adjust by 1ms steps without violating bounds.
  const maxIterations = normalized.length * 4 + Math.min(10_000, Math.abs(diff));
  let iterations = 0;

  while (diff !== 0 && iterations < maxIterations) {
    iterations += 1;
    const direction = diff > 0 ? 1 : -1;

    // Spread adjustments across frames to avoid clustering error into a single frame.
    let adjusted = false;
    for (let i = 0; i < normalized.length && diff !== 0; i += 1) {
      const next = normalized[i]! + direction;
      if (next < MIN_WEBP_FRAME_DURATION_MS || next > MAX_WEBP_DURATION_24BIT) {
        continue;
      }
      normalized[i] = next;
      diff -= direction;
      adjusted = true;
    }

    if (!adjusted) {
      break;
    }
  }

  currentTotal = normalized.reduce((sum, value) => sum + value, 0);
  if (currentTotal !== target) {
    logger.warn('conversion', 'Failed to perfectly align WebP durations to target total', {
      targetTotalMs: target,
      currentTotalMs: currentTotal,
      frameCount: normalized.length,
    });
  }

  return normalized;
}

/**
 * Build frame duration array for WebP animation
 *
 * Calculates frame durations using uniform or variable mode based on downsampling
 * and codec complexity. Uniform mode prevents stutter on downsampled or complex-codec videos.
 *
 * @param params - Duration calculation parameters
 * @param params.timestamps - Frame timestamps in seconds
 * @param params.fps - Target output FPS
 * @param params.frameCount - Number of frames
 * @param params.sourceFPS - Original video FPS (optional)
 * @param params.codec - Video codec (optional, for complex codec detection)
 * @param params.durationSeconds - Total video duration (optional)
 * @returns Array of frame durations in milliseconds
 *
 * @example
 * const durations = buildWebPFrameDurations({
 *   timestamps: [0, 0.1, 0.2],
 *   fps: 10,
 *   frameCount: 3,
 *   sourceFPS: 30,
 *   codec: 'h264',
 *   durationSeconds: 0.3
 * });
 */
export function buildWebPFrameDurations(params: {
  timestamps: number[];
  fps: number;
  frameCount: number;
  sourceFPS?: number;
  codec?: string;
  durationSeconds?: number;
}): number[] {
  const { timestamps, fps, frameCount, sourceFPS, codec, durationSeconds } = params;

  const defaultDuration = Math.max(MIN_WEBP_FRAME_DURATION_MS, Math.round(1000 / Math.max(1, fps)));
  const targetTotalDurationMs =
    durationSeconds && durationSeconds > 0
      ? Math.max(frameCount * MIN_WEBP_FRAME_DURATION_MS, Math.round(durationSeconds * 1000))
      : null;

  if (frameCount <= 1 || timestamps.length <= 1) {
    if (targetTotalDurationMs) {
      return buildUniformWebPDurations({
        frameCount: Math.max(1, frameCount),
        totalDurationMs: targetTotalDurationMs,
      });
    }

    const fallbackDuration = Math.min(
      MAX_WEBP_DURATION_24BIT,
      Math.max(MIN_WEBP_FRAME_DURATION_MS, defaultDuration)
    );
    return Array.from({ length: Math.max(1, frameCount) }, () => fallbackDuration);
  }

  // Validate sourceFPS before using it
  const hasValidSourceFPS =
    sourceFPS && Number.isFinite(sourceFPS) && sourceFPS > 0 && sourceFPS <= 120; // Sanity check

  if (!hasValidSourceFPS && sourceFPS) {
    logger.warn('conversion', 'Invalid source FPS detected, using variable durations', {
      sourceFPS,
      reason: sourceFPS <= 0 ? 'non-positive' : sourceFPS > 120 ? 'unrealistic' : 'non-finite',
    });
  }

  // Force uniform durations for complex codecs to prevent stuttering
  const isComplexCodecSource = isComplexCodec(codec);

  // Detect if significant FPS downsampling occurred or if complex codec requires uniform timing
  const useUniformDurations =
    isComplexCodecSource || (hasValidSourceFPS && sourceFPS / fps > FPS_DOWNSAMPLING_THRESHOLD);

  let durations: number[] = [];

  if (useUniformDurations) {
    const uniformDuration = targetTotalDurationMs
      ? null
      : Math.min(MAX_WEBP_DURATION_24BIT, Math.max(MIN_WEBP_FRAME_DURATION_MS, defaultDuration));

    // UNIFORM MODE: Use fixed duration to avoid stutter
    logger.info('conversion', 'Using uniform frame durations to prevent downsampling stutter', {
      sourceFPS: sourceFPS ?? 'unknown',
      targetFPS: fps,
      ratio: sourceFPS ? (sourceFPS / fps).toFixed(2) : 'N/A',
      duration: uniformDuration ?? 'duration-aligned',
      frameCount,
      isComplexCodec: isComplexCodecSource,
      codec: codec ?? 'unknown',
    });

    durations = targetTotalDurationMs
      ? buildUniformWebPDurations({ frameCount, totalDurationMs: targetTotalDurationMs })
      : Array.from({ length: frameCount }, () => uniformDuration ?? defaultDuration);
  } else {
    // VARIABLE MODE: Use timestamp deltas for VFR or near-matching FPS
    logger.info('conversion', 'Using variable frame durations based on timestamps', {
      sourceFPS: sourceFPS ?? 'unknown',
      targetFPS: fps,
      ratio: sourceFPS ? (sourceFPS / fps).toFixed(2) : 'N/A',
      frameCount,
    });

    for (let i = 0; i < frameCount; i += 1) {
      const currentTimestamp: number =
        typeof timestamps[i] === 'number' && Number.isFinite(timestamps[i])
          ? (timestamps[i] as number)
          : i > 0 && typeof timestamps[i - 1] === 'number'
            ? (timestamps[i - 1] as number)
            : 0;
      const nextTimestamp = timestamps[i + 1];
      if (typeof nextTimestamp === 'number' && Number.isFinite(nextTimestamp)) {
        const deltaMs = Math.max(
          MIN_WEBP_FRAME_DURATION_MS,
          Math.round((nextTimestamp - currentTimestamp) * 1000)
        );
        durations.push(Math.min(MAX_WEBP_DURATION_24BIT, deltaMs));
      } else {
        durations.push(defaultDuration);
      }
    }
  }

  // Ensure the last frame has a duration
  if (durations.length < frameCount) {
    durations.push(
      targetTotalDurationMs ? Math.round(targetTotalDurationMs / frameCount) : defaultDuration
    );
  }

  // Align total duration to the target duration when provided
  if (targetTotalDurationMs) {
    const currentTotalMs = durations.reduce((sum, value) => sum + value, 0);
    if (currentTotalMs > 0 && currentTotalMs !== targetTotalDurationMs) {
      const scale = targetTotalDurationMs / currentTotalMs;
      const scaled = durations.map((duration) =>
        Math.min(
          MAX_WEBP_DURATION_24BIT,
          Math.max(MIN_WEBP_FRAME_DURATION_MS, Math.round(duration * scale))
        )
      );
      durations = normalizeWebPDurationsToTotal({
        durations: scaled,
        targetTotalMs: targetTotalDurationMs,
      });
    }
  }

  return durations.slice(0, frameCount);
}
