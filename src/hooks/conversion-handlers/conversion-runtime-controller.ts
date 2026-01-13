import { batch, type Setter } from 'solid-js';

import { setConversionProgress, setConversionStatusMessage } from '@stores/conversion-store';
import { ETACalculator } from '@utils/eta-calculator';
import { isMemoryCritical } from '@utils/memory-monitor';

/** Memory check interval during conversion (5 seconds). */
const MEMORY_CHECK_INTERVAL = 5000;

/** ETA update interval for UI throttling (1 second). */
const ETA_UPDATE_INTERVAL = 1000;

export interface ConversionRuntimeControllerDeps {
  setConversionStartTime: Setter<number>;
  setEstimatedSecondsRemaining: Setter<number | null>;
  setMemoryWarning: Setter<boolean>;
}

/**
 * Per-hook runtime state for conversion operations.
 *
 * This isolates timers, ETA logic, and UI-scoped operation sequencing so the
 * main hook can focus on wiring handlers.
 */
export class ConversionRuntimeController {
  private memoryCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastEtaUpdate = 0;
  private readonly etaCalculator = new ETACalculator();

  // Coalesce progress updates to avoid redundant reactive writes.
  private lastProgressValue = 0;

  // UI-scoped operation sequencing.
  // Prevents stale async completions (e.g., a cancelled conversion) from clobbering newer state.
  private activeConversionSeq = 0;

  constructor(private readonly deps: ConversionRuntimeControllerDeps) {}

  invalidateActiveConversions(): void {
    this.activeConversionSeq += 1;
  }

  startNewRun(): { isActive: () => boolean } {
    const seq = (this.activeConversionSeq += 1);
    return {
      isActive: () => seq === this.activeConversionSeq,
    };
  }

  resetRuntimeState(): void {
    setConversionProgress(0);
    setConversionStatusMessage('');
    this.resetTimingState();
  }

  /**
   * Reset post-conversion timing/ETA state without forcing progress back to 0.
   *
   * This mirrors the previous UI behavior where progress could remain at its
   * last value after success/error, while timing-related UI returned to idle.
   */
  resetTimingState(): void {
    this.deps.setConversionStartTime(0);
    this.deps.setEstimatedSecondsRemaining(null);
    this.deps.setMemoryWarning(false);
    this.etaCalculator.reset();
    this.lastEtaUpdate = 0;
    this.stopMemoryMonitoring();
  }

  prepareForNewConversion(startTimeMs: number): void {
    setConversionProgress(0);
    setConversionStatusMessage('');
    this.deps.setConversionStartTime(startTimeMs);
    this.etaCalculator.reset();
    this.deps.setEstimatedSecondsRemaining(null);
    this.lastEtaUpdate = 0;
    this.deps.setMemoryWarning(false);

    // Reset progress coalescing state for this run.
    this.lastProgressValue = 0;
  }

  startMemoryMonitoring(): void {
    this.stopMemoryMonitoring();
    this.memoryCheckTimer = setInterval(() => {
      if (isMemoryCritical()) {
        this.deps.setMemoryWarning(true);
      }
    }, MEMORY_CHECK_INTERVAL);
  }

  stopMemoryMonitoring(): void {
    if (this.memoryCheckTimer) {
      clearInterval(this.memoryCheckTimer);
      this.memoryCheckTimer = null;
    }
  }

  updateProgress(progress: number): void {
    if (!Number.isFinite(progress)) {
      return;
    }

    const rounded = Math.round(Math.min(100, Math.max(0, progress)));

    // Progress should not move backwards within a single run.
    const monotonic = Math.max(rounded, this.lastProgressValue);

    // Avoid redundant writes when progress does not actually change.
    if (monotonic === this.lastProgressValue) {
      return;
    }

    this.lastProgressValue = monotonic;

    const now = Date.now();
    batch(() => {
      setConversionProgress(monotonic);
      this.etaCalculator.addSample(monotonic);

      // Throttle ETA UI updates to max 1/sec to reduce reactive computation overhead.
      if (now - this.lastEtaUpdate >= ETA_UPDATE_INTERVAL) {
        this.deps.setEstimatedSecondsRemaining(this.etaCalculator.getETA());
        this.lastEtaUpdate = now;
      }
    });
  }
}
