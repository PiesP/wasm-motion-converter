// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

export type AdaptiveMotionClass = 'static' | 'slow' | 'normal' | 'fast';

export const ADAPTIVE_NOISE_SAMPLE_COUNT = 15;

const STATIC_THRESHOLD = 1.5;
const SLOW_THRESHOLD = 3;
const NORMAL_THRESHOLD = 6;
const NOISE_FLOOR_MULTIPLIER = 3.5;
const MAX_CONSECUTIVE_SKIP_MS = 500;

const DECIMATION_BY_MOTION: Readonly<Record<AdaptiveMotionClass, number>> = {
  static: 8,
  slow: 3,
  normal: 2,
  fast: 1,
};

const MOTION_CLASS_ORDER: Readonly<Record<AdaptiveMotionClass, number>> = {
  static: 0,
  slow: 1,
  normal: 2,
  fast: 3,
};

export function calculateAdaptiveNoiseFloor(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return median * NOISE_FLOOR_MULTIPLIER;
}

export function classifyAdaptiveMotion(
  frameDistance: number,
  noiseFloor: number
): AdaptiveMotionClass {
  const effectiveStatic = Math.max(STATIC_THRESHOLD, noiseFloor / NOISE_FLOOR_MULTIPLIER);
  const effectiveSlow = Math.max(SLOW_THRESHOLD, noiseFloor / 1.8);
  const effectiveNormal = Math.max(NORMAL_THRESHOLD, noiseFloor / 1.2);

  if (frameDistance <= effectiveStatic) return 'static';
  if (frameDistance <= effectiveSlow) return 'slow';
  if (frameDistance <= effectiveNormal) return 'normal';
  return 'fast';
}

export function isSignificantMotionIncrease(
  motionClass: AdaptiveMotionClass,
  previousMotionClass: AdaptiveMotionClass
): boolean {
  return MOTION_CLASS_ORDER[motionClass] > MOTION_CLASS_ORDER[previousMotionClass] + 1;
}

export function calculateAdaptiveDecimation(
  motionClass: AdaptiveMotionClass,
  requestedDecimation: number,
  maxAdaptiveDecimation: number
): number {
  return Math.max(
    requestedDecimation,
    Math.min(DECIMATION_BY_MOTION[motionClass], maxAdaptiveDecimation)
  );
}

interface AdaptiveSkipInput {
  frameNum: number;
  lastKeptFrame: number;
  requestedDecimation: number;
  frameCounter: number;
  decimation: number;
  consecutiveSkipMs: number;
}

export function shouldSkipAdaptiveFrame(input: AdaptiveSkipInput): boolean {
  const violatesRequestedFloor = input.frameNum - input.lastKeptFrame < input.requestedDecimation;
  return (
    violatesRequestedFloor ||
    (input.frameCounter % input.decimation !== 0 &&
      input.consecutiveSkipMs < MAX_CONSECUTIVE_SKIP_MS)
  );
}
