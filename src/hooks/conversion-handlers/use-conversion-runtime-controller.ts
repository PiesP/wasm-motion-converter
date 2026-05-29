// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import { setConversionProgress, setConversionStatusMessage } from '@stores/conversion-store';
import { ETACalculator } from '@utils/eta-calculator';
import { formatDuration } from '@utils/format-utils';
import { logger } from '@utils/logger';
import { isMemoryCritical } from '@utils/memory-monitor';
import type { Setter } from 'solid-js';
import { batch } from 'solid-js';

const MEMORY_CHECK_INTERVAL = 5000;
const ETA_UPDATE_INTERVAL = 1000;
const UI_PROGRESS_LOG_INTERVAL_MS = 1000;
const STALL_DETECTION_MS = 30_000; // warn user if no progress for 30s

type ParsedStatusCounter = {
  prefix: string;
  current: number;
  total: number;
} | null;

const parseStatusCounter = (status: string): ParsedStatusCounter => {
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
};

interface ConversionRuntimeControllerDeps {
  setConversionStartTime: Setter<number>;
  setEstimatedSecondsRemaining: Setter<number | null>;
  setMemoryWarning: Setter<boolean>;
}

export class ConversionRuntimeController {
  private memoryCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastEtaUpdate = 0;
  private readonly etaCalculator = new ETACalculator();
  private currentStartTimeMs = 0;
  private lastProgressValue = 0;
  private lastStatusMessage = '';
  private lastUiProgressLogAtMs = 0;
  private activeRunId: string | null = null;
  private activeConversionSeq = 0;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: ConversionRuntimeControllerDeps) {}

  invalidateActiveConversions(): void {
    this.activeConversionSeq += 1;
  }

  startNewRun(): { isActive: () => boolean; runId: string } {
    const seq = (this.activeConversionSeq += 1);
    const runId = `run-${seq}-${performance.now().toString(36)}`;
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
    this.clearStallTimer();
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

    this.lastProgressValue = 0;
    this.lastStatusMessage = '';
    this.lastUiProgressLogAtMs = 0;
    this.startStallTimer();
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

  private startStallTimer(): void {
    this.clearStallTimer();
    this.stallTimer = setTimeout(() => {
      const elapsedMs =
        this.currentStartTimeMs > 0 ? Math.max(0, performance.now() - this.currentStartTimeMs) : 0;
      const elapsedSeconds = Math.floor(elapsedMs / 1000);
      logger.warn('progress', 'Conversion stalled — no progress update in 30s', {
        runId: this.activeRunId,
        lastProgressValue: this.lastProgressValue,
        elapsedSeconds,
        elapsed: formatDuration(elapsedSeconds),
      });
      setConversionStatusMessage(
        'Still processing… conversion may be slow for this format. Consider cancelling and reducing quality or scale.'
      );
    }, STALL_DETECTION_MS);
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  updateProgress(progress: number): void {
    if (!Number.isFinite(progress)) {
      return;
    }

    const rounded = Math.round(Math.min(100, Math.max(0, progress)));
    const monotonic = Math.max(rounded, this.lastProgressValue);

    if (monotonic === this.lastProgressValue) {
      return;
    }

    this.lastProgressValue = monotonic;

    // Reset stall timer whenever progress advances
    this.startStallTimer();

    const now = performance.now();
    batch(() => {
      setConversionProgress(monotonic);
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
          etaSeconds !== null && etaSeconds > 0 ? `ETA: ${formatDuration(etaSeconds)}` : null,
      });
    }
  }
}
