import {
  setConversionProgress,
  setConversionStatusMessage,
} from '@stores/conversion-progress-store';
import { ETACalculator } from '@utils/eta-calculator';
import { formatDuration } from '@utils/format-duration';
import { logger } from '@utils/logger';
import { isMemoryCritical } from '@utils/memory-monitor';
import { batch, type Setter } from 'solid-js';

/** Memory check interval during conversion (5 seconds). */
const MEMORY_CHECK_INTERVAL = 5000;

/** ETA update interval for UI throttling (1 second). */
const ETA_UPDATE_INTERVAL = 1000;

/** Throttle UI progress log lines to avoid excessive log volume. */
const UI_PROGRESS_LOG_INTERVAL_MS = 1000;

type ParsedStatusCounter = {
  prefix: string;
  current: number;
  total: number;
} | null;

function parseStatusCounter(status: string): ParsedStatusCounter {
  // Expected examples:
  // - "Encoding GIF... (1/137)"
  // - "Decoding with WebCodecs... (23/400)"
  const match = status.match(/^(.*)\s+\((\d+)\s*\/\s*(\d+)\)\s*$/);
  if (!match) {
    return null;
  }

  const prefix = (match[1] ?? '').trim();
  const current = Number.parseInt(match[2] ?? '0', 10);
  const total = Number.parseInt(match[3] ?? '0', 10);

  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
    return null;
  }

  return { prefix, current, total };
}

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

  // Current conversion start timestamp (ms since epoch). Used for UI elapsed-time logging.
  private currentStartTimeMs = 0;

  // Coalesce progress updates to avoid redundant reactive writes.
  private lastProgressValue = 0;

  // Last known user-visible status message (for dedupe and progress log context).
  private lastStatusMessage = '';

  // Throttling for UI-oriented log lines.
  private lastUiProgressLogAtMs = 0;

  // Identifier for correlating UI logs within a single conversion run.
  private activeRunId: string | null = null;

  // UI-scoped operation sequencing.
  // Prevents stale async completions (e.g., a cancelled conversion) from clobbering newer state.
  private activeConversionSeq = 0;

  constructor(private readonly deps: ConversionRuntimeControllerDeps) {}

  invalidateActiveConversions(): void {
    this.activeConversionSeq += 1;
  }

  startNewRun(): { isActive: () => boolean; runId: string } {
    const seq = (this.activeConversionSeq += 1);
    const runId = `run-${seq}-${Date.now().toString(36)}`;
    this.activeRunId = runId;
    return {
      isActive: () => seq === this.activeConversionSeq,
      runId,
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

    this.currentStartTimeMs = 0;
    this.lastStatusMessage = '';
    this.lastUiProgressLogAtMs = 0;
    this.activeRunId = null;
  }

  prepareForNewConversion(startTimeMs: number): void {
    setConversionProgress(0);
    setConversionStatusMessage('');
    this.deps.setConversionStartTime(startTimeMs);
    this.currentStartTimeMs = startTimeMs;
    this.etaCalculator.reset();
    this.deps.setEstimatedSecondsRemaining(null);
    this.lastEtaUpdate = 0;
    this.deps.setMemoryWarning(false);

    // Reset progress coalescing state for this run.
    this.lastProgressValue = 0;
    this.lastStatusMessage = '';
    this.lastUiProgressLogAtMs = 0;
  }

  updateStatus(message: string): void {
    const safeMessage = message ?? '';

    // Avoid redundant reactive writes and log spam when status is unchanged.
    if (safeMessage === this.lastStatusMessage) {
      return;
    }

    this.lastStatusMessage = safeMessage;
    setConversionStatusMessage(safeMessage);

    if (!safeMessage) {
      return;
    }

    const now = Date.now();
    const elapsedMs = this.currentStartTimeMs > 0 ? Math.max(0, now - this.currentStartTimeMs) : 0;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    const elapsed = formatDuration(elapsedSeconds);
    const parsed = parseStatusCounter(safeMessage);

    logger.info('progress', 'UI status update', {
      runId: this.activeRunId,
      statusMessage: safeMessage,
      statusPrefix: parsed?.prefix,
      current: parsed?.current,
      total: parsed?.total,
      progressPercent: this.lastProgressValue,
      elapsed,
      elapsedLabel: `Elapsed: ${elapsed}`,
      elapsedSeconds,
      elapsedMs,
    });
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

    // Log user-visible progress (percent + elapsed), but keep log volume bounded.
    if (
      monotonic >= 100 ||
      now - this.lastUiProgressLogAtMs >= UI_PROGRESS_LOG_INTERVAL_MS ||
      this.lastUiProgressLogAtMs === 0
    ) {
      this.lastUiProgressLogAtMs = now;
      const elapsedMs =
        this.currentStartTimeMs > 0 ? Math.max(0, now - this.currentStartTimeMs) : 0;
      const elapsedSeconds = Math.floor(elapsedMs / 1000);
      const elapsed = formatDuration(elapsedSeconds);
      const etaSeconds = this.etaCalculator.getETA();

      logger.info('progress', 'UI progress update', {
        runId: this.activeRunId,
        progressPercent: monotonic,
        statusMessage: this.lastStatusMessage || undefined,
        elapsed,
        elapsedLabel: `Elapsed: ${elapsed}`,
        elapsedSeconds,
        elapsedMs,
        etaSeconds,
        etaLabel:
          etaSeconds != null && etaSeconds > 0 ? `ETA: ${formatDuration(etaSeconds)}` : null,
      });
    }
  }
}
