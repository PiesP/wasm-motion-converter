// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import {
  setConversionProgress,
  setConversionStatusMessage,
  setOutputFrames,
} from '@stores/conversion-store';
import type { ProgressPhase } from '@t/conversion-types';
import { STALL_DETECTION_TIMEOUT_MS } from '@utils/constants';
import { createETACalculator } from '@utils/eta-calculator';
import { formatDurationSeconds } from '@utils/format-utils';
import { logger } from '@utils/logger';
import type { Setter } from 'solid-js';
import { batch } from 'solid-js';

export interface ProgressStateDeps {
  setConversionStartTime: Setter<number>;
  setEstimatedSecondsRemaining: Setter<number | null>;
  setMemoryWarning: Setter<boolean>;
  setConversionPhase?: Setter<ProgressPhase> | undefined;
}

const ETA_UPDATE_INTERVAL = 1000;
const UI_PROGRESS_LOG_INTERVAL_MS = 1000;
const UI_STATUS_LOG_INTERVAL_MS = 500;

type ParsedStatusCounter = {
  prefix: string;
  current: number;
  total: number;
} | null;

/**
 * Parse a status string in the format "prefix (N/M)" to extract structured
 * counter information. Only used internally by ProgressState for enriched
 * logging — not part of the public API.
 * @internal
 */
const parseStatusCounter = (status: string): ParsedStatusCounter => {
  // Match pattern: "prefix (N/M)" at end of string
  // Use lastIndexOf to find the final " (" which precedes the counter
  const openParen = status.lastIndexOf(' (');
  if (openParen < 0) return null;

  const closeParen = status.indexOf(')', openParen);
  if (closeParen < 0) return null;

  const counter = status.slice(openParen + 2, closeParen);
  const slashIdx = counter.indexOf('/');
  if (slashIdx < 0) return null;

  const currentStr = counter.slice(0, slashIdx).trim();
  const totalStr = counter.slice(slashIdx + 1).trim();
  const current = Number.parseInt(currentStr, 10);
  const total = Number.parseInt(totalStr, 10);

  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
    return null;
  }

  const prefix = status.slice(0, openParen).trim();
  return { prefix, current, total };
};

export class ProgressState {
  lastProgressValue = 0;
  lastStatusMessage = '';
  lastUiProgressLogAtMs = 0;
  lastUiStatusLogAtMs = 0;
  currentStartTimeMs = 0;
  activeRunId: string | null = null;
  disposed = false;
  lastEtaUpdate = 0;
  readonly etaCalculator = createETACalculator();
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: ProgressStateDeps) {}

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private startStallTimer(): void {
    this.clearStallTimer();
    this.stallTimer = setTimeout(() => {
      const elapsedMs =
        this.currentStartTimeMs > 0 ? Math.max(0, performance.now() - this.currentStartTimeMs) : 0;
      const elapsedSeconds = Math.floor(elapsedMs / 1000);
      if (this.lastProgressValue >= 10 || elapsedSeconds > 120) {
        logger.warn('progress', 'Conversion stalled — no progress update in 60s', {
          runId: this.activeRunId,
          lastProgressValue: this.lastProgressValue,
          elapsedSeconds,
        });
      }
    }, STALL_DETECTION_TIMEOUT_MS);
  }

  updateProgress(progress: number, phase?: ProgressPhase | string, outputFrames?: number): void {
    if (!Number.isFinite(progress)) {
      return;
    }

    const rounded = Math.min(100, Math.max(0, progress));
    const monotonic = Math.max(rounded, this.lastProgressValue);

    if (monotonic === this.lastProgressValue) {
      return;
    }

    this.lastProgressValue = monotonic;

    // Update phase if provided
    if (phase && this.deps.setConversionPhase) {
      this.deps.setConversionPhase(phase as ProgressPhase);
    }

    // Reset stall timer whenever progress advances — but not at 100%,
    // since the stall timer would fire 60s after completion with a spurious warning.
    if (monotonic < 100) {
      this.startStallTimer();
    } else {
      this.clearStallTimer();
    }

    const now = performance.now();
    batch(() => {
      setConversionProgress(monotonic);
      if (outputFrames != null) {
        setOutputFrames(outputFrames);
      }
      this.etaCalculator.addSample(monotonic);

      if (now - this.lastEtaUpdate >= ETA_UPDATE_INTERVAL) {
        this.deps.setEstimatedSecondsRemaining(this.etaCalculator.getETA());
        this.lastEtaUpdate = now;
      }
    });

    if (
      monotonic >= 100 ||
      now - this.lastUiProgressLogAtMs >= UI_PROGRESS_LOG_INTERVAL_MS ||
      this.lastUiProgressLogAtMs === 0
    ) {
      this.lastUiProgressLogAtMs = now;
      const elapsedMs =
        this.currentStartTimeMs > 0 ? Math.max(0, now - this.currentStartTimeMs) : 0;
      const elapsedSeconds = Math.floor(elapsedMs / 1000);
      const elapsed = formatDurationSeconds(elapsedSeconds);
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
          etaSeconds !== null && etaSeconds > 0
            ? `ETA: ${formatDurationSeconds(etaSeconds)}`
            : null,
      });
    }
  }

  updateStatus(message: string): void {
    const safeMessage = message ?? '';

    if (safeMessage === this.lastStatusMessage) {
      return;
    }

    this.lastStatusMessage = safeMessage;
    setConversionStatusMessage(safeMessage);

    if (!safeMessage) {
      return;
    }

    const now = performance.now();
    // Throttle status logging: skip if logged less than UI_STATUS_LOG_INTERVAL_MS ago
    if (now - this.lastUiStatusLogAtMs < UI_STATUS_LOG_INTERVAL_MS) {
      return;
    }
    this.lastUiStatusLogAtMs = now;
    const elapsedMs = this.currentStartTimeMs > 0 ? Math.max(0, now - this.currentStartTimeMs) : 0;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    const elapsed = formatDurationSeconds(elapsedSeconds);
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

  resetProgressState(): void {
    setConversionProgress(0);
    setConversionStatusMessage('');
    this.disposed = true;
    setOutputFrames(undefined);
    this.deps.setConversionStartTime(0);
    this.deps.setEstimatedSecondsRemaining(null);
    this.deps.setMemoryWarning(false);
    this.etaCalculator.reset();
    this.lastEtaUpdate = 0;
    this.currentStartTimeMs = 0;
    this.lastStatusMessage = '';
    this.lastUiProgressLogAtMs = 0;
    this.lastUiStatusLogAtMs = 0;
    this.activeRunId = null;
    this.lastProgressValue = 0;
    this.clearStallTimer();
  }

  prepareForConversion(startTimeMs: number): void {
    this.disposed = false;
    setConversionProgress(0);
    setConversionStatusMessage('');
    this.deps.setConversionStartTime(startTimeMs);
    this.currentStartTimeMs = startTimeMs;
    this.etaCalculator.reset();
    this.deps.setEstimatedSecondsRemaining(null);
    this.lastEtaUpdate = 0;
    this.deps.setMemoryWarning(false);

    this.lastProgressValue = 0;
    this.lastStatusMessage = '';
    this.lastUiProgressLogAtMs = 0;
    this.lastUiStatusLogAtMs = 0;
    this.startStallTimer();
  }
}

export function createProgressState(deps: ProgressStateDeps): ProgressState {
  return new ProgressState(deps);
}
