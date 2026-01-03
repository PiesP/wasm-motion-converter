/**
 * ETA (Estimated Time of Arrival) Calculator
 * Uses linear regression on progress samples to estimate remaining time
 */
export class ETACalculator {
  private samples: Array<{ timestamp: number; progress: number }> = [];
  private readonly maxSamples = 10;

  /**
   * Add a new progress sample
   * @param progress - Current progress percentage (0-100)
   */
  addSample(progress: number): void {
    const now = Date.now();

    // Only add if progress has changed or it's the first sample
    const lastSample = this.samples[this.samples.length - 1];
    if (this.samples.length === 0 || !lastSample || lastSample.progress !== progress) {
      this.samples.push({ timestamp: now, progress });

      // Keep only the most recent samples
      if (this.samples.length > this.maxSamples) {
        this.samples.shift();
      }
    }
  }

  /**
   * Calculate estimated time remaining in seconds
   * Returns null if not enough data is available (< 3 samples)
   * @returns Estimated seconds remaining, or null if insufficient data
   */
  getETA(): number | null {
    // Need at least 3 samples for a reasonable estimate
    if (this.samples.length < 3) {
      return null;
    }

    // Don't estimate if progress is already at 100%
    const lastSample = this.samples[this.samples.length - 1];
    if (!lastSample) {
      return null;
    }

    const currentProgress = lastSample.progress;
    if (currentProgress >= 100) {
      return 0;
    }

    // Calculate time elapsed and progress made
    const firstSample = this.samples[0];
    if (!firstSample) {
      return null;
    }

    const timeElapsed = (lastSample.timestamp - firstSample.timestamp) / 1000; // Convert to seconds
    const progressMade = lastSample.progress - firstSample.progress;

    // Avoid division by zero or negative progress
    if (progressMade <= 0 || timeElapsed <= 0) {
      return null;
    }

    // Calculate rate of progress (percentage per second)
    const progressRate = progressMade / timeElapsed;

    // Calculate remaining progress
    const remainingProgress = 100 - currentProgress;

    // Estimate remaining time
    const estimatedSeconds = remainingProgress / progressRate;

    // Return null for unreasonable estimates (> 1 hour)
    if (estimatedSeconds > 3600) {
      return null;
    }

    // Return conservative estimate (add 10% buffer)
    return Math.ceil(estimatedSeconds * 1.1);
  }

  /**
   * Reset all samples
   */
  reset(): void {
    this.samples = [];
  }

  /**
   * Get the number of samples currently stored
   */
  getSampleCount(): number {
    return this.samples.length;
  }
}
