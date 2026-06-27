// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import {
  setConversionProgress,
  setConversionStatusMessage,
  setOutputFrames,
} from '@stores/conversion-store';
import type { ProgressPhase } from '@t/conversion-types';
import { ETACalculator } from '@utils/eta-calculator';
import { formatDurationSeconds } from '@utils/format-utils';
import { logger } from '@utils/logger';
import type { Setter } from 'solid-js';
import { batch } from 'solid-js';

export interface ProgressStateDeps {
  setConversionStartTime: Setter<number>;
  setEstimatedSecondsRemaining: Setter<number | null>;
  setMemoryWarning: Setter<boolean>;
  setConversionPhase?: Setter<ProgressPhase>;
}

const ETA_UPDATE_INTERVAL = 1000;
const UI_PROGRESS_LOG_INTERVAL_MS = 1000;
const UI_STATUS_LOG_INTERVAL_MS = 500;
const STALL_DETECTION_MS = 60_000;

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

/**
 * Custom hook that encapsulates progress state management for conversion.
 * Returns progress-related state and update methods.
 */
export function useProgressState(deps: ProgressStateDeps) {
  let lastProgressValue = 0;
  let lastStatusMessage = '';
  let lastUiProgressLogAtMs = 0;
  let lastUiStatusLogAtMs = 0;
  let currentStartTimeMs = 0;
  let activeRunId: string | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let lastEtaUpdate = 0;
  const etaCalculator = new ETACalculator();

  const clearStallTimer = (): void => {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  const startStallTimer = (): void => {
    clearStallTimer();
    stallTimer = setTimeout(() => {
      const elapsedMs =
        currentStartTimeMs > 0 ? Math.max(0, performance.now() - currentStartTimeMs) : 0;
      const elapsedSeconds = Math.floor(elapsedMs / 1000);
      if (lastProgressValue >= 10 || elapsedSeconds > 120) {
        logger.warn('progress', 'Conversion stalled — no progress update in 60s', {
          runId: activeRunId,
          lastProgressValue: lastProgressValue,
          elapsedSeconds,
        });
      }
    }, STALL_DETECTION_MS);
  };

  const updateProgress = (
    progress: number,
    phase?: ProgressPhase | string,
    outputFrames?: number
  ): void => {
    if (!Number.isFinite(progress)) {
      return;
    }

    const rounded = Math.min(100, Math.max(0, progress));
    const monotonic = Math.max(rounded, lastProgressValue);

    if (monotonic === lastProgressValue) {
      return;
    }

    lastProgressValue = monotonic;

    // Update phase if provided
    if (phase && deps.setConversionPhase) {
      deps.setConversionPhase(phase as ProgressPhase);
    }

    // Reset stall timer whenever progress advances — but not at 100%,
    // since the stall timer would fire 60s after completion with a spurious warning.
    if (monotonic < 100) {
      startStallTimer();
    } else {
      clearStallTimer();
    }

    const now = performance.now();
    batch(() => {
      setConversionProgress(monotonic);
      if (outputFrames != null) {
        setOutputFrames(outputFrames);
      }
      etaCalculator.addSample(monotonic);

      if (now - lastEtaUpdate >= ETA_UPDATE_INTERVAL) {
        deps.setEstimatedSecondsRemaining(etaCalculator.getETA());
        lastEtaUpdate = now;
      }
    });

    if (
      monotonic >= 100 ||
      now - lastUiProgressLogAtMs >= UI_PROGRESS_LOG_INTERVAL_MS ||
      lastUiProgressLogAtMs === 0
    ) {
      lastUiProgressLogAtMs = now;
      const elapsedMs = currentStartTimeMs > 0 ? Math.max(0, now - currentStartTimeMs) : 0;
      const elapsedSeconds = Math.floor(elapsedMs / 1000);
      const elapsed = formatDurationSeconds(elapsedSeconds);
      const etaSeconds = etaCalculator.getETA();

      logger.info('progress', 'UI progress update', {
        runId: activeRunId,
        progressPercent: monotonic,
        statusMessage: lastStatusMessage || undefined,
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
  };

  const updateStatus = (message: string): void => {
    const safeMessage = message ?? '';

    if (safeMessage === lastStatusMessage) {
      return;
    }

    lastStatusMessage = safeMessage;
    setConversionStatusMessage(safeMessage);

    if (!safeMessage) {
      return;
    }

    const now = performance.now();
    // Throttle status logging: skip if logged less than UI_STATUS_LOG_INTERVAL_MS ago
    if (now - lastUiStatusLogAtMs < UI_STATUS_LOG_INTERVAL_MS) {
      return;
    }
    lastUiStatusLogAtMs = now;
    const elapsedMs = currentStartTimeMs > 0 ? Math.max(0, now - currentStartTimeMs) : 0;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    const elapsed = formatDurationSeconds(elapsedSeconds);
    const parsed = parseStatusCounter(safeMessage);

    logger.info('progress', 'UI status update', {
      runId: activeRunId,
      statusMessage: safeMessage,
      statusPrefix: parsed?.prefix,
      current: parsed?.current,
      total: parsed?.total,
      progressPercent: lastProgressValue,
      elapsed,
      elapsedLabel: `Elapsed: ${elapsed}`,
      elapsedSeconds,
      elapsedMs,
    });
  };

  const resetProgressState = (): void => {
    setConversionProgress(0);
    setConversionStatusMessage('');
    disposed = true;
    setOutputFrames(undefined);
    deps.setConversionStartTime(0);
    deps.setEstimatedSecondsRemaining(null);
    deps.setMemoryWarning(false);
    etaCalculator.reset();
    lastEtaUpdate = 0;
    currentStartTimeMs = 0;
    lastStatusMessage = '';
    lastUiProgressLogAtMs = 0;
    lastUiStatusLogAtMs = 0;
    activeRunId = null;
    lastProgressValue = 0;
    clearStallTimer();
  };

  const prepareForConversion = (startTimeMs: number): void => {
    disposed = false;
    setConversionProgress(0);
    setConversionStatusMessage('');
    deps.setConversionStartTime(startTimeMs);
    currentStartTimeMs = startTimeMs;
    etaCalculator.reset();
    deps.setEstimatedSecondsRemaining(null);
    lastEtaUpdate = 0;
    deps.setMemoryWarning(false);

    lastProgressValue = 0;
    lastStatusMessage = '';
    lastUiProgressLogAtMs = 0;
    lastUiStatusLogAtMs = 0;
    startStallTimer();
  };

  return {
    updateProgress,
    updateStatus,
    resetProgressState,
    prepareForConversion,
    startStallTimer,
    clearStallTimer,
    get lastProgressValue() {
      return lastProgressValue;
    },
    get lastStatusMessage() {
      return lastStatusMessage;
    },
    get currentStartTimeMs() {
      return currentStartTimeMs;
    },
    set currentStartTimeMs(v: number) {
      currentStartTimeMs = v;
    },
    get activeRunId() {
      return activeRunId;
    },
    set activeRunId(v: string | null) {
      activeRunId = v;
    },
    get disposed() {
      return disposed;
    },
    set disposed(v: boolean) {
      disposed = v;
    },
    get etaCalculator() {
      return etaCalculator;
    },
    get lastEtaUpdate() {
      return lastEtaUpdate;
    },
    set lastEtaUpdate(v: number) {
      lastEtaUpdate = v;
    },
    get lastUiProgressLogAtMs() {
      return lastUiProgressLogAtMs;
    },
    set lastUiProgressLogAtMs(v: number) {
      lastUiProgressLogAtMs = v;
    },
    get lastUiStatusLogAtMs() {
      return lastUiStatusLogAtMs;
    },
    set lastUiStatusLogAtMs(v: number) {
      lastUiStatusLogAtMs = v;
    },
    set lastProgressValue(v: number) {
      lastProgressValue = v;
    },
    set lastStatusMessage(v: string) {
      lastStatusMessage = v;
    },
  };
}
