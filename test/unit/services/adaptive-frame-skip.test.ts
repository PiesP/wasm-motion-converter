// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import {
  calculateAdaptiveDecimation,
  calculateAdaptiveNoiseFloor,
  classifyAdaptiveMotion,
  isSignificantMotionIncrease,
  shouldSkipAdaptiveFrame,
} from '@services/adaptive-frame-skip';
import { describe, expect, it } from 'vitest';

describe('adaptive frame skip policy', () => {
  it('derives a capped noise floor from valid median samples', () => {
    expect(calculateAdaptiveNoiseFloor([0.1, 0.2, 0.3])).toBeCloseTo(0.7);
    expect(calculateAdaptiveNoiseFloor([8, 1, 4, 3, 2])).toBe(4.5);
    expect(calculateAdaptiveNoiseFloor([Number.NaN, -1, 0.4])).toBeCloseTo(1.4);
    expect(calculateAdaptiveNoiseFloor([])).toBe(0);
  });

  it.each([
    [1.5, 'static'],
    [1.51, 'slow'],
    [3, 'slow'],
    [3.01, 'normal'],
    [6, 'normal'],
    [6.01, 'fast'],
  ] as const)('classifies distance %s as %s at the default noise floor', (distance, expected) => {
    expect(classifyAdaptiveMotion(distance, 0)).toBe(expected);
  });

  it('widens classification thresholds for noisy input', () => {
    expect(classifyAdaptiveMotion(2, 7)).toBe('static');
    expect(classifyAdaptiveMotion(3.5, 7)).toBe('slow');
    expect(classifyAdaptiveMotion(5, 7)).toBe('normal');
  });

  it('keeps scene cuts fast even after a high-motion calibration window', () => {
    const noiseFloor = calculateAdaptiveNoiseFloor(Array.from({ length: 15 }, () => 200));
    expect(noiseFloor).toBe(4.5);
    expect(classifyAdaptiveMotion(50, noiseFloor)).toBe('fast');
    expect(classifyAdaptiveMotion(50, 200)).toBe('fast');
    expect(classifyAdaptiveMotion(1, 0)).toBe('static'); // short clip before calibration
  });

  it('detects only jumps of more than one motion class', () => {
    expect(isSignificantMotionIncrease('fast', 'static')).toBe(true);
    expect(isSignificantMotionIncrease('fast', 'slow')).toBe(true);
    expect(isSignificantMotionIncrease('fast', 'normal')).toBe(false);
    expect(isSignificantMotionIncrease('static', 'fast')).toBe(false);
  });

  it('combines the requested floor with the motion and FPS caps', () => {
    expect(calculateAdaptiveDecimation('static', 1, 4)).toBe(4);
    expect(calculateAdaptiveDecimation('static', 5, 8)).toBe(8);
    expect(calculateAdaptiveDecimation('fast', 5, 8)).toBe(5);
  });

  it('preserves the preset floor and the 500ms cadence safety limit', () => {
    const base = {
      frameNum: 8,
      lastKeptFrame: 0,
      requestedDecimation: 8,
      frameCounter: 1,
      decimation: 3,
      consecutiveSkipMs: 0,
    };

    expect(shouldSkipAdaptiveFrame({ ...base, frameNum: 7 })).toBe(true);
    expect(shouldSkipAdaptiveFrame(base)).toBe(true);
    expect(shouldSkipAdaptiveFrame({ ...base, frameCounter: 3 })).toBe(false);
    expect(shouldSkipAdaptiveFrame({ ...base, consecutiveSkipMs: 500 })).toBe(false);
  });
});
