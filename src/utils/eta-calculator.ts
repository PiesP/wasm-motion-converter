/**
 * ETA (Estimated Time of Arrival) Calculator for conversion progress tracking
 *
 * This class estimates remaining conversion time using linear regression on progress samples.
 * It maintains a sliding window of the most recent progress measurements (timestamps and percentages)
 * and calculates the rate of progress to estimate time until completion.
 *
 * **Algorithm**:
 * - Collects progress samples (timestamp + percentage) with deduplication (no duplicate progress values)
 * - Maintains a sliding window of 10 most recent samples
 * - Uses first and last samples to calculate progress rate (% per second)
 * - Extrapolates to estimate time remaining for remaining progress
 * - Includes 10% buffer and rejects estimates >1 hour as unreasonable
 *
 * **Usage**: Add samples periodically as conversion progresses, then query ETA at any time.
 * Returns null if insufficient data (< 3 samples) or unreasonable estimates (> 1 hour).
 *
 * **Example**: Video encoder calling ETA calculator
 * ```
 * const eta = new ETACalculator();
 * // ..after each frame encoded..
 * eta.addSample(currentProgressPercent);
 * const secondsRemaining = eta.getETA(); // null or seconds remaining
 * ```
 */
export class ETACalculator {
  private samples: Array<{ timestamp: number; progress: number }> = [];
  private readonly maxSamples = 10;

  /**
   * Add a new progress sample to the estimation window
   *
   * Samples are automatically deduplicated (consecutive identical progress values ignored)
   * and pruned to keep only the 10 most recent samples. This prevents memory growth
   * and maintains accuracy by focusing on recent progress trend.
   *
   * @param progress - Current progress percentage (0-100)
   *
   * @example
   * const eta = new ETACalculator();
   * eta.addSample(0);   // 0% - first sample
   * eta.addSample(25);  // 25% - progress made
   * eta.addSample(50);  // 50% - more progress
   * eta.addSample(50);  // 50% - duplicate (ignored, no add)
   * eta.addSample(75);  // 75% - new progress recorded
   */
  addSample(progress: number): void {
    const now = Date.now();

    // Deduplication: Only add if progress value changed or it's the first sample
    // (avoids redundant samples during slow progress periods)
    const lastSample = this.samples[this.samples.length - 1];
    if (this.samples.length === 0 || !lastSample || lastSample.progress !== progress) {
      this.samples.push({ timestamp: now, progress });

      // Sliding window: Keep only the 10 most recent samples to prevent memory growth
      // and focus ETA calculation on recent trend (more relevant than ancient history)
      if (this.samples.length > this.maxSamples) {
        this.samples.shift();
      }
    }
  }

  /**
   * Calculate estimated time remaining in seconds
   *
   * Uses linear regression (simple first-to-last progress rate) to estimate remaining time.
   * Returns null if insufficient data (< 3 samples), conversion complete (100%), or
   * estimate is unreasonable (> 1 hour).
   *
   * **Calculation steps**:
   * 1. Check if ≥3 samples available and current progress < 100%
   * 2. Calculate progress rate: (last progress - first progress) / (last time - first time)
   * 3. Calculate remaining: 100% - current progress
   * 4. Estimate time: remaining / rate
   * 5. Apply conservative 10% buffer and cap at 1 hour (3600s)
   * 6. Round up to nearest second
   *
   * **Buffer rationale**: Conversions often slow near completion (final encoding, writing),
   * so 10% buffer prevents optimistic estimates that disappoint users.
   *
   * @returns Estimated seconds remaining with 10% buffer, or null if:
   *          - Less than 3 samples collected
   *          - Progress already at 100%
   *          - Calculated estimate exceeds 1 hour (too unreliable)
   *          - Negative or zero progress rate (no progress or time elapsed)
   *
   * @example
   * // Fast initial progress, slowing near end
   * const eta = new ETACalculator();
   * eta.addSample(50);  // t=0s, 50%
   * eta.addSample(75);  // t=10s, 75% (25% in 10s = 2.5%/s)
   * eta.addSample(90);  // t=20s, 90% (15% in 10s = 1.5%/s)
   * eta.getETA(); // ~(100-90)/1.5 * 1.1 = 7.3s → 8s (with buffer and rounding)
   *
   * @example
   * // Very slow progress (unreliable estimate)
   * const eta2 = new ETACalculator();
   * eta2.addSample(1);  // t=0s, 1%
   * eta2.addSample(2);  // t=3600s (1 hour), 2% (0.00027%/s)
   * eta2.addSample(3);  // t=7200s (2 hours), 3%
   * eta2.getETA(); // null (estimate would be >1 hour, rejected as unreliable)
   */
  getETA(): number | null {
    // STEP 1: Validation - Need at least 3 samples for reasonable linear regression
    if (this.samples.length < 3) {
      return null; // Insufficient data (early conversion)
    }

    // STEP 2: Check completion status
    const lastSample = this.samples[this.samples.length - 1];
    if (!lastSample) {
      return null; // Defensive check (should not happen)
    }

    const currentProgress = lastSample.progress;
    // Conversion complete - no time remaining
    if (currentProgress >= 100) {
      return 0;
    }

    // STEP 3: Extract first and last samples for rate calculation
    const firstSample = this.samples[0];
    if (!firstSample) {
      return null; // Defensive check (should not happen)
    }

    // STEP 4: Calculate progress rate (% per second)
    const timeElapsed = (lastSample.timestamp - firstSample.timestamp) / 1000; // Convert ms to seconds
    const progressMade = lastSample.progress - firstSample.progress; // Percentage points

    // Guard against invalid data: no progress or no time elapsed
    if (progressMade <= 0 || timeElapsed <= 0) {
      return null; // Can't estimate without forward progress
    }

    // Progress rate in percentage per second (e.g., 2.5% per second)
    const progressRate = progressMade / timeElapsed;

    // STEP 5: Extrapolate remaining time
    const remainingProgress = 100 - currentProgress; // Remaining percentage to encode
    const estimatedSeconds = remainingProgress / progressRate; // Raw estimate (no buffer)

    // STEP 6: Sanity check - reject unreasonable estimates (>1 hour = data quality issue)
    // Indicates conversion is stalling or data is corrupted
    if (estimatedSeconds > 3600) {
      return null;
    }

    // STEP 7: Apply conservative 10% buffer and round up
    // Buffer accounts for typical slowdown near completion (final encoding writes, etc)
    return Math.ceil(estimatedSeconds * 1.1);
  }

  /**
   * Reset all progress samples and clear the estimation window
   *
   * Use this when starting a new conversion to discard historical data
   * from the previous conversion. Without reset, old samples would skew
   * the progress rate calculation.
   *
   * @example
   * // After conversion completes or is cancelled
   * eta.reset();
   * // Now ready for next conversion with fresh data
   */
  reset(): void {
    this.samples = [];
  }

  /**
   * Get the number of progress samples currently stored
   *
   * Returns the count of samples in the estimation window. Useful for debugging
   * or determining if ETA is available (>= 3 samples) before calling getETA().
   *
   * @returns Number of samples (0-10, since window is capped at 10)
   *
   * @example
   * const eta = new ETACalculator();
   * eta.addSample(25);
   * eta.addSample(50);
   * logger.debug('performance', 'ETA sample count', { count: eta.getSampleCount() }); // 2 (not enough for ETA)
   * eta.addSample(75);
   * logger.debug('performance', 'ETA sample count', { count: eta.getSampleCount() }); // 3 (ready for ETA)
   */
  getSampleCount(): number {
    return this.samples.length;
  }
}
