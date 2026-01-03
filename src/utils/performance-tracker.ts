/**
 * Performance tracking utility for monitoring conversion phases
 * Tracks timing and metadata for different stages of the video conversion process
 */

type PerformancePhase =
  | 'ffmpeg-download'
  | 'ffmpeg-init'
  | 'conversion'
  | 'palette-gen'
  | 'webp-encode'
  | 'gif-fallback'
  | 'webp-fallback';

interface TimingEntry {
  phase: PerformancePhase;
  startTime: number;
  endTime?: number;
  duration?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Tracks timing and metadata for conversion phases
 */
class PerformanceTracker {
  private timings: TimingEntry[] = [];

  /**
   * Start tracking a performance phase
   * @param phase - The performance phase to track
   * @param metadata - Optional metadata to associate with the phase
   */
  startPhase(phase: PerformancePhase, metadata?: Record<string, unknown>): void {
    this.timings.push({
      phase,
      startTime: performance.now(),
      metadata,
    });
  }

  /**
   * End tracking a performance phase
   * @param phase - The performance phase to end
   */
  endPhase(phase: PerformancePhase): void {
    const entry = this.timings.find((t) => t.phase === phase && !t.endTime);
    if (entry) {
      entry.endTime = performance.now();
      entry.duration = entry.endTime - entry.startTime;
    }
  }

  /**
   * Get a report of all tracked phases with timing information
   * @returns Report containing timings, phase summary, and total time in milliseconds
   */
  getReport(): Record<string, unknown> {
    return {
      timings: this.timings,
      summary: this.timings.reduce(
        (acc, t) => {
          if (t.duration) {
            acc[t.phase] = t.duration;
          }
          return acc;
        },
        {} as Record<string, number>
      ),
      totalTime: this.timings.reduce((sum, t) => sum + (t.duration || 0), 0),
    };
  }

  exportToConsole(): void {
    console.table(this.getReport().summary);
  }

  /**
   * Save the performance report to sessionStorage for debugging
   */
  saveToSessionStorage(): void {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('perf-report', JSON.stringify(this.getReport()));
    }
  }

  /**
   * Reset all tracked timings
   */
  reset(): void {
    this.timings = [];
  }
}

/**
 * Global performance tracker instance for monitoring conversion phases
 */
export const performanceTracker = new PerformanceTracker();
