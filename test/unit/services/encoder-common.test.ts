// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import {
  calcAutoDecimation,
  calcMemoryPressureDecimation,
} from '@services/encoder-common';
import { MIN_OUTPUT_FPS } from '@utils/constants';

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
    // 60/8 ≈ 7.5 → round=8 → keep every 8th frame = 7.5fps output
    expect(calcAutoDecimation(60, 8)).toBe(8);
  });

  it('decimates 30fps to ~12fps (targetFps=12)', () => {
    // 30/12 ≈ 2.5 → round=3 → keep every 3rd frame = 10fps output
    expect(calcAutoDecimation(30, 12)).toBe(3);
  });

  it('decimates 30fps to ~18fps (targetFps=18, WebP medium)', () => {
    // 30/18 ≈ 1.67 → round=2 → keep every 2nd frame = 15fps output
    expect(calcAutoDecimation(30, 18)).toBe(2);
  });

  it('rounds fractional decimation to nearest integer', () => {
    // 25/15 ≈ 1.667 → round=2
    expect(calcAutoDecimation(25, 15)).toBe(2);
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
    // 50/30 ≈ 1.67 → round=2
    expect(calcAutoDecimation(50, 30)).toBe(2);
  });

  it('handles 30fps source with 8fps target', () => {
    // 30/8 ≈ 3.75 → round=4 → output=7.5fps
    expect(calcAutoDecimation(30, 8)).toBe(4);
  });

  it('always returns at least 1', () => {
    expect(calcAutoDecimation(10, 60)).toBe(1);
    expect(calcAutoDecimation(1, 30)).toBe(1);
  });
});

describe('calcMemoryPressureDecimation', () => {
  it('never keeps more frames than the selected quality preset', () => {
    expect(calcMemoryPressureDecimation(60, 8)).toBe(8);
  });

  it('reduces a smooth preset to at most 15fps under critical pressure', () => {
    expect(calcMemoryPressureDecimation(60, 30)).toBe(4);
  });

  it('does not push low-fps input below the minimum output fps', () => {
    expect(calcMemoryPressureDecimation(10, 30)).toBe(1);
  });
});
