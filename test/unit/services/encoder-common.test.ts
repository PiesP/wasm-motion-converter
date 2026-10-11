// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import {
  calcAutoDecimation,
  calcMemoryPressureDecimation,
  resolveCadencePolicy,
} from '@services/encoder-common';
describe('calcAutoDecimation', () => {
  // ── Basic FPS-based decimation ─────────────────────────────

  it('returns 1 when source fps <= target fps', () => {
    // 15fps source, 30fps target → no decimation needed
    expect(calcAutoDecimation(15, 30)).toBe(1);
  });

  it('returns 1 when source fps equals target fps', () => {
    expect(calcAutoDecimation(30, 30)).toBe(1);
  });

  it('decimates 60fps to ~30fps (targetFps=30)', () => {
    // 60/30 = 2 → keep every 2nd frame = 30fps output
    expect(calcAutoDecimation(60, 30)).toBe(2);
  });

  it('decimates 60fps to ~20fps (targetFps=20, GIF high)', () => {
    // 60/20 = 3 → keep every 3rd frame = 20fps output
    expect(calcAutoDecimation(60, 20)).toBe(3);
  });

  it('decimates 60fps to ~12fps (targetFps=12, GIF medium)', () => {
    // 60/12 = 5 → keep every 5th frame = 12fps output
    expect(calcAutoDecimation(60, 12)).toBe(5);
  });

  it('decimates 60fps to ~8fps (targetFps=8, GIF low)', () => {
    // Retain the 7.5 ratio so timestamp sampling averages 8fps.
    expect(calcAutoDecimation(60, 8)).toBe(7.5);
  });

  it('decimates 30fps to ~12fps (targetFps=12)', () => {
    expect(calcAutoDecimation(30, 12)).toBe(2.5);
  });

  it('decimates 30fps to ~18fps (targetFps=18, WebP medium)', () => {
    expect(calcAutoDecimation(30, 18)).toBeCloseTo(30 / 18);
  });

  it('preserves fractional source/target cadence', () => {
    expect(calcAutoDecimation(25, 15)).toBeCloseTo(25 / 15);
  });

  // ── Source FPS clamping ────────────────────────────────────

  it('clamps source fps to minimum of 1', () => {
    // clampedFps=1, 1 <= 15 → baseDecimation=1
    expect(calcAutoDecimation(0, 15)).toBe(1);
  });

  it('clamps source fps to maximum of 120', () => {
    // clampedFps=120, 120/30=4 → keep every 4th frame
    expect(calcAutoDecimation(200, 30)).toBe(4);
  });

  // ── MIN_OUTPUT_FPS guard ───────────────────────────────────

  it('ensures output FPS never drops below MIN_OUTPUT_FPS', () => {
    // 120fps source, 5fps target → decimation=24 → output=5fps (≥3fps, OK)
    expect(calcAutoDecimation(120, 5)).toBe(24);
  });

  it('caps decimation when output would drop below MIN_OUTPUT_FPS', () => {
    // 120fps source, 1fps target → decimation would be 120 → output=1fps (<3fps)
    // → capped to floor(120/3) = 40
    expect(calcAutoDecimation(120, 1)).toBe(40);
  });

  it('applies MIN_OUTPUT_FPS guard for 60fps with very low target', () => {
    // 60fps source, 2fps target → decimation=30 → output=2fps (<3fps)
    // → capped to floor(60/3) = 20
    expect(calcAutoDecimation(60, 2)).toBe(20);
  });

  // ── Force decimation override ──────────────────────────────

  it('returns forceDecimation when provided, ignoring all other parameters', () => {
    // Would normally be 12, but force overrides to 2
    expect(calcAutoDecimation(60, 5, 2)).toBe(2);
  });

  it('returns forceDecimation even when value is 1 (reduced decimation)', () => {
    expect(calcAutoDecimation(60, 5, 1)).toBe(1);
  });

  it('ignores an invalid zero forceDecimation and uses the automatic preset', () => {
    expect(calcAutoDecimation(60, 5, 0)).toBe(12);
  });

  it('rounds a positive fractional forceDecimation to a valid integer', () => {
    expect(calcAutoDecimation(60, 5, 2.6)).toBe(3);
  });

  it('ignores a non-finite forceDecimation', () => {
    expect(calcAutoDecimation(60, 5, Number.POSITIVE_INFINITY)).toBe(12);
  });

  // ── Scale independence ─────────────────────────────────────

  it('does not depend on scale — scale is a separate quality axis', () => {
    // Same target FPS (12) always produces the same decimation regardless of scale
    const decimation = calcAutoDecimation(60, 12);
    expect(decimation).toBe(5);
  });

  // ── Edge cases ─────────────────────────────────────────────

  it('handles 24fps source with 12fps target', () => {
    // 24/12 = 2
    expect(calcAutoDecimation(24, 12)).toBe(2);
  });

  it('handles 50fps source with 30fps target', () => {
    expect(calcAutoDecimation(50, 30)).toBeCloseTo(50 / 30);
  });

  it('handles 30fps source with 8fps target', () => {
    expect(calcAutoDecimation(30, 8)).toBe(3.75);
  });

  it('always returns at least 1', () => {
    expect(calcAutoDecimation(10, 60)).toBe(1);
    expect(calcAutoDecimation(1, 30)).toBe(1);
  });
});

describe('calcMemoryPressureDecimation', () => {
  it('never keeps more frames than the selected quality preset', () => {
    expect(calcMemoryPressureDecimation(60, 8)).toBe(7.5);
  });

  it('reduces a smooth preset to at most 15fps under critical pressure', () => {
    expect(calcMemoryPressureDecimation(60, 30)).toBe(4);
  });

  it('does not push low-fps input below the minimum output fps', () => {
    expect(calcMemoryPressureDecimation(10, 30)).toBe(1);
  });
});

describe('resolveCadencePolicy', () => {
  it('does not turn an automatic integer time ratio into a source-frame gap', () => {
    expect(resolveCadencePolicy(60, 30)).toEqual({
      frameDecimation: 2,
      minimumSourceFrameGap: 1,
      pressureCadenceRatio: undefined,
    });
  });

  it('preserves a fractional critical-memory restriction independently of the preset', () => {
    expect(resolveCadencePolicy(21, 20, undefined, 1.4)).toEqual({
      frameDecimation: 1.05,
      minimumSourceFrameGap: 1,
      pressureCadenceRatio: 1.4,
    });
    expect(resolveCadencePolicy(60, 8, undefined, 4)).toEqual({
      frameDecimation: 7.5,
      minimumSourceFrameGap: 1,
      pressureCadenceRatio: undefined,
    });
  });

  it('preserves an explicit integer source-frame override with a separate pressure floor', () => {
    expect(resolveCadencePolicy(60, 30, 3)).toEqual({
      frameDecimation: 3,
      minimumSourceFrameGap: 3,
      pressureCadenceRatio: undefined,
    });
    expect(resolveCadencePolicy(60, 30, 2, 4)).toEqual({
      frameDecimation: 2,
      minimumSourceFrameGap: 2,
      pressureCadenceRatio: 4,
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
    'ignores an invalid optional pressure ratio %s',
    (invalid) => {
      expect(resolveCadencePolicy(21, 20, undefined, invalid)).toEqual({
        frameDecimation: 1.05,
        minimumSourceFrameGap: 1,
        pressureCadenceRatio: undefined,
      });
    }
  );

  it.each([1.49, 1.5, 1.51, 1.99, 2, 2.01])(
    'does not round a valid pressure time ratio %s across a half/integer boundary',
    (pressureRatio) => {
      expect(resolveCadencePolicy(30, 30, undefined, pressureRatio)).toEqual({
        frameDecimation: 1,
        minimumSourceFrameGap: 1,
        pressureCadenceRatio: pressureRatio,
      });
    }
  );
});
