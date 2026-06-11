// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * ETA (Estimated Time of Arrival) Calculator for conversion progress tracking
 *
 * This class estimates remaining conversion time using weighted linear regression
 * on progress samples. It maintains a sliding window of the most recent progress
 * measurements (timestamps and percentages) and calculates the rate of progress
 * to estimate time until completion.
 *
 * **Algorithm**:
 * - Collects progress samples (timestamp + percentage) with deduplication
 * - Maintains a sliding window of the most recent 15 samples
 * - Uses weighted linear regression (least squares) with exponential decay weighting
 *   so recent samples have more influence on the estimate
 * - Applies phase-boundary reset: when progress crosses a major phase boundary
 *   (10%, 40%, 50%, 90%), old samples are discarded so the estimate quickly
 *   adapts to the new phase's speed
 * - Includes 10% buffer and rejects estimates >1 hour as unreasonable
 *
 * **Usage**: Add samples periodically as conversion progresses, then query ETA at any time.
 * Returns null if insufficient data (< 5 samples) or unreasonable estimates (> 1 hour).
 *
 * @example
 * const eta = new ETACalculator();
 * // ..after each frame encoded..
 * eta.addSample(currentProgressPercent);
 * const secondsRemaining = eta.getETA(); // null or seconds remaining
 */
export class ETACalculator {
  private samples: Array<{ timestamp: number; progress: number }> = [];
  private readonly maxSamples = 15;
  private readonly minSamples = 5;
  private readonly weightDecay = 0.85; // exponential decay per sample age

  // Phase boundaries where encoding speed typically changes significantly.
  // Crossing one of these triggers a sample reset so the ETA quickly adapts.
  private static readonly PHASE_BOUNDARIES = [10, 40, 50, 90];
  private lastPhaseIndex = -1;

  /**
   * Add a new progress sample to the estimation window
   *
   * Samples are automatically deduplicated (consecutive identical progress values ignored)
   * and pruned to keep only the most recent 15 samples. When a phase boundary is
   * crossed, old samples are discarded so the estimate adapts to the new phase.
   *
   * @param progress - Current progress percentage (0-100)
   */
  addSample(progress: number): void {
    const now = performance.now();

    // Deduplication: Only add if progress value changed or it's the first sample
    const lastSample = this.samples[this.samples.length - 1];
    if (this.samples.length > 0 && lastSample && lastSample.progress === progress) {
      return;
    }

    // Phase boundary detection: reset samples when crossing a major boundary
    const currentPhaseIndex = ETACalculator.PHASE_BOUNDARIES.findIndex(
      (boundary) => progress >= boundary
    );
    if (currentPhaseIndex > this.lastPhaseIndex) {
      // Crossed into a new phase — keep only the most recent sample as seed
      const kept = this.samples.slice(-1);
      this.samples = kept as Array<{ timestamp: number; progress: number }>;
      this.lastPhaseIndex = currentPhaseIndex;
    }

    this.samples.push({ timestamp: now, progress });

    // Sliding window: Keep only the most recent samples
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  /**
   * Calculate estimated time remaining in seconds
   *
   * Uses weighted linear regression (least squares) with exponential decay weighting.
   * Recent samples get higher weight, so the estimate responds faster to speed changes.
   *
   * @returns Estimated seconds remaining with 10% buffer, or null if:
   *          - Less than 5 samples collected
   *          - Progress already at 100%
   *          - Calculated estimate exceeds 1 hour (too unreliable)
   *          - Negative or zero progress rate (no progress or time elapsed)
   */
  getETA(): number | null {
    if (this.samples.length < this.minSamples) {
      return null; // Insufficient data
    }

    const lastSample = this.samples[this.samples.length - 1];
    if (!lastSample) {
      return null;
    }

    const currentProgress = lastSample.progress;
    if (currentProgress >= 100) {
      return 0;
    }

    // Weighted linear regression: progress = a + b * time
    // We need the slope b (progress per second) to estimate remaining time.
    const n = this.samples.length;

    // Compute weighted sums for least squares
    let sumW = 0;
    let sumWX = 0;
    let sumWY = 0;
    let sumWXX = 0;
    let sumWXY = 0;

    // Normalize timestamps relative to the first sample to avoid large numbers
    const firstSample = this.samples[0];
    if (!firstSample) return null;
    const t0 = firstSample.timestamp;

    for (let i = 0; i < n; i++) {
      const sample = this.samples[i];
      if (!sample) continue;
      // Weight: more recent samples get higher weight
      // Most recent sample (i = n-1) gets weight 1, older samples decay
      const age = n - 1 - i;
      const weight = this.weightDecay ** age;

      const x = (sample.timestamp - t0) / 1000; // seconds from start
      const y = sample.progress;

      sumW += weight;
      sumWX += weight * x;
      sumWY += weight * y;
      sumWXX += weight * x * x;
      sumWXY += weight * x * y;
    }

    // Slope (progress per second) from weighted least squares formula
    const denominator = sumW * sumWXX - sumWX * sumWX;
    if (denominator <= 0) {
      return null; // Degenerate case: all samples at same time
    }

    const slope = (sumW * sumWXY - sumWX * sumWY) / denominator;

    // Guard against invalid slope
    if (slope <= 0.01) {
      return null; // Progress too slow to estimate reliably
    }

    // Estimate remaining time
    const remainingProgress = 100 - currentProgress;
    const estimatedSeconds = remainingProgress / slope;

    // Sanity check - reject unreasonable estimates
    if (estimatedSeconds > 3600 || !Number.isFinite(estimatedSeconds)) {
      return null;
    }

    // Apply conservative 10% buffer and round up
    return Math.ceil(estimatedSeconds * 1.1);
  }

  /**
   * Reset all progress samples and clear the estimation window
   *
   * Use this when starting a new conversion to discard historical data
   * from the previous conversion.
   */
  reset(): void {
    this.samples = [];
    this.lastPhaseIndex = -1;
  }

  /**
   * Get the number of progress samples currently stored
   *
   * @returns Number of samples (0-15, since window is capped at 15)
   */
  getSampleCount(): number {
    return this.samples.length;
  }
}
