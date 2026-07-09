// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { ETA_CAP_SECONDS, ETA_MAX_SAMPLES } from './constants';

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

export interface ETACalculator {
  /**
   * Add a new progress sample. Deduplicates consecutive identical values.
   */
  addSample(progress: number): void;

  /**
   * Calculate ETA using weighted linear regression.
   * For the first few samples (< 5), uses simple linear extrapolation
   * from the first sample so the user sees an immediate estimate.
   *
   * @returns Estimated seconds remaining, or null if estimate is unreliable.
   */
  getETA(): number | null;

  /**
   * Reset all samples for a new conversion.
   */
  reset(): void;
}

/**
 * Create an ETA calculator instance.
 *
 * Uses weighted linear regression on recent progress samples for better accuracy.
 * Recent samples are weighted more heavily since encoding speed can vary.
 *
 * - Maintains a sliding window of up to 30 most recent progress measurements.
 * - Uses least squares linear regression instead of simple first-to-last rate.
 * - Returns null when insufficient data (< 5 samples) or unreasonable estimates (> 1 hour).
 */
export function createETACalculator(): ETACalculator {
  const maxSamples = ETA_MAX_SAMPLES;
  const samples: Array<{ timestamp: number; progress: number }> = [];

  const api: ETACalculator = {
    addSample(progress: number): void {
      const now = performance.now();
      const lastSample = samples[samples.length - 1];
      if (samples.length === 0 || !lastSample || lastSample.progress !== progress) {
        samples.push({ timestamp: now, progress });
        if (samples.length > maxSamples) {
          samples.shift();
        }
      }
    },

    getETA(): number | null {
      if (samples.length < 2) return null;

      const n = samples.length;
      const lastSample = samples[n - 1];
      if (!lastSample || lastSample.progress >= 100) return 0;

      // Fast path: simple linear extrapolation for first few samples
      if (n < 5) {
        const firstSample = samples[0]!;
        const elapsedSec = (lastSample.timestamp - firstSample.timestamp) / 1000;
        const progressDelta = lastSample.progress - firstSample.progress;
        if (elapsedSec <= 0 || progressDelta <= 0) return null;
        const rate = progressDelta / elapsedSec; // % per second
        const remaining = 100 - lastSample.progress;
        const estimatedSeconds = remaining / rate;
        if (
          !Number.isFinite(estimatedSeconds) ||
          estimatedSeconds > ETA_CAP_SECONDS ||
          estimatedSeconds < 0
        ) {
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

      const baseTime = samples[0]!.timestamp;

      for (let i = 0; i < n; i++) {
        const sample = samples[i]!;
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
      if (
        !Number.isFinite(estimatedSeconds) ||
        estimatedSeconds > ETA_CAP_SECONDS ||
        estimatedSeconds < 0
      ) {
        return null;
      }

      // Apply conservative 10% buffer, round up
      return Math.ceil(estimatedSeconds * 1.1);
    },

    reset(): void {
      samples.length = 0;
    },
  };

  return api;
}
