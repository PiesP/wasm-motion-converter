// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * ETA (Estimated Time of Arrival) Calculator for conversion progress tracking.
 *
 * Uses weighted linear regression on recent progress samples for better accuracy.
 * Recent samples are weighted more heavily since encoding speed can vary.
 *
 * - Maintains a sliding window of up to 30 most recent progress measurements.
 * - Uses least squares linear regression instead of simple first-to-last rate.
 * - Returns null when insufficient data (< 5 samples) or unreasonable estimates (> 1 hour).
 */
export class ETACalculator {
  private samples: Array<{ timestamp: number; progress: number }> = [];
  private readonly maxSamples = 30;

  /**
   * Add a new progress sample. Deduplicates consecutive identical values.
   */
  addSample(progress: number): void {
    const now = performance.now();
    const lastSample = this.samples[this.samples.length - 1];
    if (this.samples.length === 0 || !lastSample || lastSample.progress !== progress) {
      this.samples.push({ timestamp: now, progress });
      if (this.samples.length > this.maxSamples) {
        this.samples.shift();
      }
    }
  }

  /**
   * Calculate ETA using weighted linear regression.
   * For the first few samples (< 5), uses simple linear extrapolation
   * from the first sample so the user sees an immediate estimate.
   *
   * @returns Estimated seconds remaining, or null if estimate is unreliable.
   */
  getETA(): number | null {
    if (this.samples.length < 2) return null;

    const n = this.samples.length;
    const lastSample = this.samples[n - 1];
    if (!lastSample || lastSample.progress >= 100) return 0;

    // Fast path: simple linear extrapolation for first few samples
    if (n < 5) {
      const firstSample = this.samples[0]!;
      const elapsedSec = (lastSample.timestamp - firstSample.timestamp) / 1000;
      const progressDelta = lastSample.progress - firstSample.progress;
      if (elapsedSec <= 0 || progressDelta <= 0) return null;
      const rate = progressDelta / elapsedSec; // % per second
      const remaining = 100 - lastSample.progress;
      const estimatedSeconds = remaining / rate;
      if (!Number.isFinite(estimatedSeconds) || estimatedSeconds > 3600 || estimatedSeconds < 0) {
        return null;
      }
      return Math.ceil(estimatedSeconds * 1.1);
    }

    // Weighted linear regression: weight = 1 / (position from end)
    // Recent samples get higher weight
    let sumW = 0;
    let sumWX = 0; // weighted time (seconds)
    let sumWY = 0; // weighted progress
    let sumWXY = 0;
    let sumWX2 = 0;

    const baseTime = this.samples[0]!.timestamp;

    for (let i = 0; i < n; i++) {
      const sample = this.samples[i]!;
      // Weight: position-based, recent samples weigh more
      const weight = (i + 1) / n;

      const x = (sample.timestamp - baseTime) / 1000; // seconds elapsed
      const y = sample.progress;

      sumW += weight;
      sumWX += weight * x;
      sumWY += weight * y;
      sumWXY += weight * x * y;
      sumWX2 += weight * x * x;
    }

    // Slope = progress rate (% per second)
    const denominator = sumW * sumWX2 - sumWX * sumWX;
    if (denominator <= 0) return null;

    const slope = (sumW * sumWXY - sumWX * sumWY) / denominator;
    if (slope <= 0.0001) return null; // Progress too slow or stalled

    const remaining = 100 - lastSample.progress;
    const estimatedSeconds = remaining / slope;

    // Sanity checks
    if (!Number.isFinite(estimatedSeconds) || estimatedSeconds > 3600 || estimatedSeconds < 0) {
      return null;
    }

    // Apply conservative 10% buffer, round up
    return Math.ceil(estimatedSeconds * 1.1);
  }

  /**
   * Reset all samples for a new conversion.
   */
  reset(): void {
    this.samples = [];
  }

  /**
   * Get number of samples currently stored.
   */
  getSampleCount(): number {
    return this.samples.length;
  }
}
