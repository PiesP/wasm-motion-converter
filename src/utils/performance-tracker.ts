import { logger } from './logger';

/**
 * Performance phases tracked during conversion
 * Categories for different stages of video processing and encoding
 */
type PerformancePhase =
  | 'ffmpeg-download'
  | 'ffmpeg-init'
  | 'conversion'
  | 'palette-gen'
  | 'webp-encode'
  | 'gif-fallback'
  | 'webp-fallback';

/**
 * Timing entry for a single performance phase
 * Includes start/end times, computed duration, and optional metadata
 */
interface TimingEntry {
  phase: PerformancePhase;
  startTime: number;
  endTime?: number;
  duration?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Performance report with summary statistics
 * Contains all tracked timings, phase summary, and total duration
 */
interface PerformanceReport {
  timings: TimingEntry[];
  summary: Record<string, number>;
  totalTime: number;
}

/**
 * Tracks timing and metadata for conversion phases
 * Provides utilities for measuring, reporting, and exporting performance metrics
 *
 * @example
 * // Start tracking a phase
 * performanceTracker.startPhase('ffmpeg-init', { cdn: 'unpkg' });
 *
 * // ... perform work ...
 *
 * // End tracking
 * performanceTracker.endPhase('ffmpeg-init');
 *
 * // Get detailed report
 * const report = performanceTracker.getReport();
 * logger.info('performance', 'Conversion metrics', { report });
 */
class PerformanceTracker {
  private timings: TimingEntry[] = [];

  /**
   * Start tracking a performance phase
   *
   * @param phase - The performance phase identifier to track
   * @param metadata - Optional metadata to associate with the phase
   *
   * @example
   * performanceTracker.startPhase('conversion', { format: 'gif', quality: 'high' });
   */
  startPhase(phase: PerformancePhase, metadata?: Record<string, unknown>): void {
    this.timings.push({
      phase,
      startTime: performance.now(),
      metadata,
    });

    logger.debug('performance', `Started tracking ${phase}`, { metadata });
  }

  /**
   * End tracking a performance phase and calculate duration
   *
   * @param phase - The performance phase identifier to end
   * @throws When no active phase with given name is found
   *
   * @example
   * performanceTracker.endPhase('conversion');
   */
  endPhase(phase: PerformancePhase): void {
    const entry = this.timings.find((t) => t.phase === phase && !t.endTime);

    if (!entry) {
      logger.warn('performance', `No active phase found for ${phase}`);
      return;
    }

    entry.endTime = performance.now();
    entry.duration = entry.endTime - entry.startTime;

    logger.debug('performance', `Completed ${phase}`, {
      durationMs: Math.round(entry.duration),
    });
  }

  /**
   * Get a comprehensive report of all tracked phases
   *
   * @returns Performance report containing:
   *   - timings: All timing entries with duration
   *   - summary: Object mapping phase names to durations (ms)
   *   - totalTime: Total elapsed time across all phases (ms)
   *
   * @example
   * const report = performanceTracker.getReport();
   * console.log(`Total time: ${report.totalTime}ms`);
   */
  getReport(): PerformanceReport {
    const summary = this.timings.reduce<Record<string, number>>((acc, t) => {
      if (t.duration !== undefined) {
        acc[t.phase] = t.duration;
      }
      return acc;
    }, {});

    const totalTime = Object.values(summary).reduce((sum, duration) => sum + duration, 0);

    return {
      timings: this.timings,
      summary,
      totalTime,
    };
  }

  /**
   * Export performance summary to browser console table
   * Useful for quick visual inspection during development
   *
   * @example
   * performanceTracker.exportToConsole();
   * // Outputs a table of phase names and durations
   */
  exportToConsole(): void {
    const report = this.getReport();

    if (Object.keys(report.summary).length === 0) {
      logger.warn('performance', 'No timing data available');
      return;
    }

    // Keep console.table for dev ergonomics, but avoid direct console output in production.
    if (import.meta.env.DEV) {
      console.table(report.summary);
    }
    logger.info('performance', 'Performance report exported to console', {
      totalTime: Math.round(report.totalTime),
    });
  }

  /**
   * Save the performance report to sessionStorage for persistent debugging
   * Useful for investigating issues after page reload
   *
   * @example
   * performanceTracker.saveToSessionStorage();
   * // Access via: JSON.parse(sessionStorage.getItem('perf-report'))
   */
  saveToSessionStorage(): void {
    if (typeof sessionStorage === 'undefined') {
      logger.warn('performance', 'sessionStorage not available');
      return;
    }

    try {
      const report = this.getReport();
      sessionStorage.setItem('perf-report', JSON.stringify(report));

      logger.info('performance', 'Performance report saved to sessionStorage', {
        totalTime: Math.round(report.totalTime),
        phaseCount: Object.keys(report.summary).length,
      });
    } catch (error) {
      logger.error('performance', 'Failed to save performance report', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Reset all tracked timings and start fresh
   * Useful for measuring multiple independent conversion operations
   *
   * @example
   * performanceTracker.reset();
   * // Begin new measurement session
   */
  reset(): void {
    this.timings = [];
    logger.debug('performance', 'Performance tracker reset');
  }
}

/**
 * Global performance tracker instance for monitoring conversion phases
 * Use this singleton for measuring timing across the application
 *
 * @example
 * import { performanceTracker } from '../utils/performance-tracker';
 *
 * performanceTracker.startPhase('ffmpeg-download', { cdn: 'unpkg' });
 * await downloadFFmpeg();
 * performanceTracker.endPhase('ffmpeg-download');
 */
export const performanceTracker = new PerformanceTracker();
