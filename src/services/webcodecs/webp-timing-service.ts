import type { VideoMetadata } from '@t/conversion-types';
import { logger } from '@utils/logger';
import { isComplexCodec } from './codec-utils-service';
import {
  FPS_DOWNSAMPLING_THRESHOLD,
  MAX_WEBP_DURATION_24BIT,
  MIN_WEBP_FRAME_DURATION_MS,
  WEBP_ANIMATION_MAX_DURATION_SECONDS,
  WEBP_ANIMATION_MAX_FRAMES,
} from './webp-constants-service';

/**
 * Calculate maximum WebP frame count.
 *
 * Limits frame count based on duration and FPS to prevent memory issues.
 * Caps at WEBP_ANIMATION_MAX_FRAMES and WEBP_ANIMATION_MAX_DURATION_SECONDS.
 */
export function getMaxWebPFrames(targetFps: number, durationSeconds?: number): number {
  // NOTE: FFmpeg metadata probing can return duration=0 for some containers/codecs.
  // Treat non-positive / non-finite durations as unknown to avoid clamping the
  // extraction window to 1s (which severely under-samples frames and causes choppy motion).
  // Additionally, some files report implausibly small durations (e.g., <1s) during probe.
  // Using those values would cap extraction to ~1s (via Math.max(1, ...)), causing too few
  // frames for multi-second sources. It's safe to treat small durations as unknown because
  // the decoder will still stop at the real video duration.
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
 * Resolve effective animation duration for WebP output.
 *
 * Uses the longest known duration (metadata or captured duration) capped to the
 * WebP animation limit to avoid unintended speed-ups.
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
 * Derive an FPS value that matches captured frames to the effective duration.
 * Clamps to the requested target FPS to avoid overspeed playback.
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
 * Build a stable, duration-aligned timestamp series for WebP frame encoding.
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
  // Cap work to prevent pathological loops.
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
 * Build frame duration array for WebP animation.
 *
 * Calculates frame durations using uniform or variable mode based on downsampling
 * and codec complexity.
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
  const hasValidSourceFps =
    sourceFPS && Number.isFinite(sourceFPS) && sourceFPS > 0 && sourceFPS <= 120; // Sanity check

  if (!hasValidSourceFps && sourceFPS) {
    logger.warn('conversion', 'Invalid source FPS detected, using variable durations', {
      sourceFPS,
      reason: sourceFPS <= 0 ? 'non-positive' : sourceFPS > 120 ? 'unrealistic' : 'non-finite',
    });
  }

  // Force uniform durations for complex codecs to prevent stuttering
  const isComplexCodecSource = isComplexCodec(codec);

  // Detect if significant FPS downsampling occurred or if complex codec requires uniform timing
  const useUniformDurations =
    isComplexCodecSource || (hasValidSourceFps && sourceFPS / fps > FPS_DOWNSAMPLING_THRESHOLD);

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
