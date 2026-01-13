/**
 * Progress Reporter
 *
 * Standardized progress reporting for multi-phase conversion operations.
 * Replaces hardcoded FFMPEG_INTERNALS.PROGRESS constants and scattered
 * progress calculation logic.
 *
 * Supports:
 * - Multi-phase progress tracking (e.g., decode → encode → finalize)
 * - Weighted phases (some phases take longer than others)
 * - Nested phases (sub-progress within a phase)
 * - Progress callbacks with automatic scaling
 *
 * Example workflow:
 * 1. Define phases: decode (0-40%), encode (40-95%), finalize (95-100%)
 * 2. Start each phase and report sub-progress
 * 3. Reporter automatically scales to global 0-100% range
 */

import { logger } from '@utils/logger';

/**
 * Progress phase definition
 */
export interface ProgressPhase {
  /** Phase name (for logging) */
  name: string;
  /** Start percentage (0-100) */
  start: number;
  /** End percentage (0-100) */
  end: number;
  /** Optional weight (for automatic phase sizing) */
  weight?: number;
}

/**
 * Progress reporter configuration
 */
export interface ProgressReporterConfig {
  /** Optional global progress callback */
  onProgress?: (progress: number) => void;
  /** Optional status message callback */
  onStatus?: (message: string) => void;
  /** Whether to round progress to integers (default: true) */
  roundProgress?: boolean;
  /**
   * Whether the reporter is still allowed to emit progress/status updates.
   *
   * Useful when multiple conversions overlap in-flight (e.g., rapid cancel/retry)
   * and a stale conversion should not mutate global UI state or log prefixes.
   */
  isActive?: () => boolean;
}

/**
 * Progress reporter for multi-phase operations
 *
 * Manages progress reporting across multiple phases of a conversion operation.
 * Each phase has a defined progress range (start-end percentage), and the
 * reporter automatically scales sub-progress within each phase to the global range.
 *
 * @example
 * const reporter = new ProgressReporter({
 *   onProgress: (p) => console.log(`${p}%`),
 *   onStatus: (s) => console.log(s)
 * });
 *
 * // Define phases
 * reporter.definePhase('decode', 0, 50);
 * reporter.definePhase('encode', 50, 100);
 *
 * // Start decode phase
 * reporter.startPhase('decode');
 * reporter.report(0.5); // Reports 25% (halfway through decode phase)
 *
 * // Start encode phase
 * reporter.startPhase('encode');
 * reporter.report(0.5); // Reports 75% (halfway through encode phase)
 */
export class ProgressReporter {
  private phases = new Map<string, ProgressPhase>();
  private currentPhase: string | null = null;
  private config: Required<ProgressReporterConfig>;
  private lastReportedProgress = 0;

  constructor(config: ProgressReporterConfig = {}) {
    this.config = {
      onProgress: config.onProgress || (() => {}),
      onStatus: config.onStatus || (() => {}),
      roundProgress: config.roundProgress !== false, // Default true
      isActive: config.isActive || (() => true),
    };
  }

  /**
   * Define a progress phase with explicit start/end percentages
   *
   * @param name - Phase name (unique identifier)
   * @param start - Start percentage (0-100)
   * @param end - End percentage (0-100)
   *
   * @example
   * reporter.definePhase('initialization', 0, 5);
   * reporter.definePhase('processing', 5, 95);
   * reporter.definePhase('cleanup', 95, 100);
   */
  definePhase(name: string, start: number, end: number): void {
    if (start < 0 || start > 100 || end < 0 || end > 100) {
      throw new Error(`Invalid phase range: ${start}-${end}. Must be 0-100.`);
    }

    if (start >= end) {
      throw new Error(`Invalid phase range: start (${start}) must be less than end (${end})`);
    }

    this.phases.set(name, { name, start, end });
  }

  /**
   * Define phases with automatic sizing based on weights
   *
   * Useful when you know relative phase durations but don't want to manually
   * calculate percentages.
   *
   * @param phases - Array of phase definitions with weights
   *
   * @example
   * reporter.definePhases([
   *   { name: 'decode', weight: 2 },    // 40% (2/5 of total)
   *   { name: 'encode', weight: 2 },    // 40% (2/5 of total)
   *   { name: 'finalize', weight: 1 }   // 20% (1/5 of total)
   * ]);
   */
  definePhases(phases: Array<{ name: string; weight: number }>): void {
    if (phases.length === 0) {
      throw new Error('Must provide at least one phase');
    }

    const totalWeight = phases.reduce((sum, phase) => sum + phase.weight, 0);
    if (totalWeight <= 0) {
      throw new Error('Total weight must be positive');
    }

    let currentStart = 0;

    for (const phase of phases) {
      const range = (phase.weight / totalWeight) * 100;
      const start = currentStart;
      const end = Math.min(100, currentStart + range);

      this.definePhase(phase.name, start, end);
      currentStart = end;
    }
  }

  /**
   * Start a progress phase
   *
   * Sets the current phase and optionally updates status message.
   * All subsequent report() calls will be scaled to this phase's range.
   *
   * @param name - Phase name (must be previously defined)
   * @param statusMessage - Optional status message to display
   *
   * @example
   * reporter.startPhase('decode', 'Extracting frames...');
   * reporter.report(0.5); // Reports 25% if decode is 0-50%
   */
  startPhase(name: string, statusMessage?: string): void {
    if (!this.phases.has(name)) {
      throw new Error(`Phase not defined: ${name}. Call definePhase() first.`);
    }

    this.currentPhase = name;

    if (statusMessage && this.config.isActive()) {
      this.config.onStatus(statusMessage);
    }

    // Report start of phase
    const phase = this.phases.get(name)!;
    this.reportAbsolute(phase.start);
  }

  /**
   * Report progress within the current phase
   *
   * Progress is automatically scaled to the current phase's range.
   * For example, if phase is 50-100% and you report 0.5, it reports 75%.
   *
   * @param phaseProgress - Progress within phase (0.0 - 1.0)
   *
   * @example
   * reporter.startPhase('encode');
   * reporter.report(0);    // Start of encode phase
   * reporter.report(0.5);  // Halfway through encode phase
   * reporter.report(1);    // End of encode phase
   */
  report(phaseProgress: number): void {
    if (!this.currentPhase) {
      throw new Error('No active phase. Call startPhase() first.');
    }

    const phase = this.phases.get(this.currentPhase);
    if (!phase) {
      throw new Error(`Phase not found: ${this.currentPhase}`);
    }

    // Clamp phase progress to 0-1
    const clampedProgress = Math.min(1, Math.max(0, phaseProgress));

    // Scale to phase range
    const { start, end } = phase;
    const globalProgress = start + (end - start) * clampedProgress;

    this.reportAbsolute(globalProgress);
  }

  /**
   * Report absolute progress (0-100), bypassing phase scaling
   *
   * Rarely needed - use report() for normal phase-based progress.
   *
   * @param progress - Absolute progress (0-100)
   *
   * @example
   * reporter.reportAbsolute(75); // Reports exactly 75%
   */
  reportAbsolute(progress: number): void {
    if (!this.config.isActive()) {
      return;
    }

    const clamped = Math.min(100, Math.max(0, progress));
    const final = this.config.roundProgress ? Math.round(clamped) : clamped;

    // Only report if changed (avoid duplicate callbacks)
    if (final !== this.lastReportedProgress) {
      // Keep logger prefix progress decoration in sync for in-progress logs.
      logger.setConversionProgress(final);
      this.config.onProgress(final);
      this.lastReportedProgress = final;
    }
  }

  /**
   * Update status message without changing progress
   *
   * @param message - Status message to display
   *
   * @example
   * reporter.updateStatus('Processing frame 50/100...');
   */
  updateStatus(message: string): void {
    if (!this.config.isActive()) {
      return;
    }
    this.config.onStatus(message);
  }

  /**
   * Complete the current phase and move to 100%
   *
   * @param statusMessage - Optional completion message
   *
   * @example
   * reporter.complete('Conversion finished');
   */
  complete(statusMessage?: string): void {
    this.reportAbsolute(100);

    if (statusMessage && this.config.isActive()) {
      this.config.onStatus(statusMessage);
    }

    this.currentPhase = null;
  }

  /**
   * Reset the reporter (clear phases and progress)
   *
   * Useful for reusing the reporter for multiple operations.
   */
  reset(): void {
    this.phases.clear();
    this.currentPhase = null;
    this.lastReportedProgress = 0;

    // Reset log prefix decoration as well.
    logger.clearConversionProgress();
  }

  /**
   * Get current progress (0-100)
   *
   * @returns Current absolute progress
   */
  getCurrentProgress(): number {
    return this.lastReportedProgress;
  }

  /**
   * Check if a phase is defined
   *
   * @param name - Phase name
   * @returns True if phase exists
   */
  hasPhase(name: string): boolean {
    return this.phases.has(name);
  }

  /**
   * Get current phase name
   *
   * @returns Current phase name or null if no active phase
   */
  getCurrentPhase(): string | null {
    return this.currentPhase;
  }
}
