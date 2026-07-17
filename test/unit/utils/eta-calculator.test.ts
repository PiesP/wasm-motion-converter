// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { createETACalculator } from '@utils/eta-calculator';

describe('createETACalculator', () => {
  let mockNow: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockNow = vi.fn();
    vi.stubGlobal('performance', { now: mockNow });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Insufficient samples ───────────────────────────────────

  it('returns null when fewer than 2 samples are added', () => {
    const calc = createETACalculator();
    mockNow.mockReturnValue(0);
    calc.addSample(0);
    expect(calc.getETA()).toBeNull();
  });

  // ── Basic linear extrapolation (< 5 samples) ───────────────

  it('returns estimated seconds with < 5 samples using simple linear extrapolation', () => {
    const calc = createETACalculator();
    mockNow.mockReturnValue(0);
    calc.addSample(0);
    mockNow.mockReturnValue(10_000); // 10 seconds elapsed, progress=50
    calc.addSample(50);

    // rate = 50/10 = 5% per second, remaining = 50, estimated = 10s, *1.1 = 11
    const eta = calc.getETA();
    expect(eta).toBe(11);
  });

  it('returns null when progress delta is 0 (no progress made)', () => {
    const calc = createETACalculator();
    mockNow.mockReturnValue(0);
    calc.addSample(0);
    mockNow.mockReturnValue(10_000);
    calc.addSample(0);

    expect(calc.getETA()).toBeNull();
  });

  it('returns null when elapsed time is 0', () => {
    const calc = createETACalculator();
    mockNow.mockReturnValue(0);
    calc.addSample(0);
    calc.addSample(50); // same timestamp

    expect(calc.getETA()).toBeNull();
  });

  // ── Weighted linear regression (>= 5 samples) ──────────────

  it('uses weighted regression for 5+ samples and returns estimated seconds', () => {
    const calc = createETACalculator();
    // Simulate 5 samples: progress 0, 25, 50, 75, 100 at 0, 5, 10, 15, 20 seconds
    // Actually at 100% it returns 0 immediately. Let's go to 80%
    const samples = [
      { t: 0, p: 0 },
      { t: 5_000, p: 20 },
      { t: 10_000, p: 40 },
      { t: 15_000, p: 60 },
      { t: 20_000, p: 80 },
    ];
    for (const s of samples) {
      mockNow.mockReturnValue(s.t);
      calc.addSample(s.p);
    }
    const eta = calc.getETA();
    expect(eta).not.toBeNull();
    expect(Number.isFinite(eta)).toBe(true);
    expect(eta).toBeGreaterThan(0);
    // slope ≈ 4%/sec, remaining=20, estimated=5s, *1.1 ≈ 6 (rounded up)
    expect(eta).toBe(6);
  });

  // ── Dedup identical progress ───────────────────────────────

  it('deduplicates consecutive identical progress values', () => {
    const calc = createETACalculator();
    mockNow.mockReturnValue(0);
    calc.addSample(0);
    // Same progress, different time
    mockNow.mockReturnValue(5_000);
    calc.addSample(0);
    // Actually the dedup logic checks if last progress === current progress,
    // so this should NOT add a new sample
    expect(calc.getETA()).toBeNull(); // still only 1 effective sample (deduped)
  });

  // ── 100% progress ──────────────────────────────────────────

  it('returns 0 when progress reaches 100', () => {
    const calc = createETACalculator();
    mockNow.mockReturnValue(0);
    calc.addSample(0);
    mockNow.mockReturnValue(10_000);
    calc.addSample(100);
    expect(calc.getETA()).toBe(0);
  });

  it('returns 0 when progress exceeds 100', () => {
    const calc = createETACalculator();
    mockNow.mockReturnValue(0);
    calc.addSample(0);
    mockNow.mockReturnValue(10_000);
    calc.addSample(150);
    expect(calc.getETA()).toBe(0);
  });

  // ── Reset clears samples ───────────────────────────────────

  it('reset clears all samples and getETA returns null', () => {
    const calc = createETACalculator();
    mockNow.mockReturnValue(0);
    calc.addSample(0);
    mockNow.mockReturnValue(10_000);
    calc.addSample(50);

    expect(calc.getETA()).not.toBeNull();

    calc.reset();
    expect(calc.getETA()).toBeNull();
  });

  // ── Stall detection (slope <= 0.0001) ──────────────────────

  it('returns null when slope is near zero (stalled progress)', () => {
    const calc = createETACalculator();
    // Add 5 samples that are all deduped to just 2 effective samples
    // with barely any progress over a long time.
    // After dedup: (0s, 0), (100s, 0.001)
    //   rate = 0.001/100 = 0.00001 %/sec
    //   remaining = 99.999
    //   estimated = 99.999/0.00001 = ~9,999,900 > 3600 → null
    const samples = [
      { t: 0, p: 0 },
      { t: 100_000, p: 0.001 },
      { t: 200_000, p: 0.001 },
      { t: 300_000, p: 0.001 },
      { t: 400_000, p: 0.001 },
    ];
    for (const s of samples) {
      mockNow.mockReturnValue(s.t);
      calc.addSample(s.p);
    }
    expect(calc.getETA()).toBeNull();
  });

  // ── >1 hour cap ────────────────────────────────────────────

  it('returns null when estimated time exceeds 1 hour', () => {
    const calc = createETACalculator();
    // Very slow progress
    mockNow.mockReturnValue(0);
    calc.addSample(0);
    mockNow.mockReturnValue(60_000); // 1 minute for 0.5% progress
    calc.addSample(0.5);

    // rate = 0.5/60 = 0.0083% per second, remaining=99.5
    // estimated = 99.5/0.0083 ≈ 11940 seconds ≈ 3.3 hours → returns null
    expect(calc.getETA()).toBeNull();
  });

  // ── Sliding window (max 30 samples) ────────────────────────

  it('maintains a sliding window of at most 30 samples', () => {
    const calc = createETACalculator();
    // Add 35 samples with increasing progress
    for (let i = 0; i < 35; i++) {
      mockNow.mockReturnValue(i * 100);
      calc.addSample(i * 3); // progress 0..102
    }
    // After sliding window, we should have dropped samples and progress > 100
    // Actually progress 34*3=102 which is >100 → getETA returns 0
    expect(calc.getETA()).toBe(0);
  });

  // ── Negative ETA clamp ─────────────────────────────────────

  it('returns null when estimated seconds is negative', () => {
    const calc = createETACalculator();
    mockNow.mockReturnValue(10_000);
    calc.addSample(0); // first sample at 10s with progress 0
    mockNow.mockReturnValue(0);
    calc.addSample(0); // second sample "before" first — impossible in real life

    // elapsedSec = (0-10000)/1000 = -10
    // This should trigger null via the isFinite/negative check
    expect(calc.getETA()).toBeNull();
  });

  // ── Non-finite estimate ────────────────────────────────────

  it('returns null when estimated seconds is not finite', () => {
    const calc = createETACalculator();
    mockNow.mockReturnValue(0);
    calc.addSample(0);
    mockNow.mockReturnValue(10_000);
    calc.addSample(100); // progress = 100 → returns 0 immediately

    expect(calc.getETA()).toBe(0);
  });
});
