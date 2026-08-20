// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { isMemoryCritical } from '@utils/memory-monitor';
import type { Setter } from 'solid-js';

import type { ProgressState } from './use-progress-state';
import { createProgressState } from './use-progress-state';

const MEMORY_CHECK_INTERVAL = 5000;

interface ConversionRuntimeControllerDeps {
  setConversionStartTime: Setter<number>;
  setEstimatedSecondsRemaining: Setter<number | null>;
  setMemoryWarning: Setter<boolean>;
  setMemoryUsageText: Setter<string | null>;
  setConversionPhase?: Setter<import('@t/conversion-types').ProgressPhase> | undefined;
}

export interface ConversionIntent {
  readonly isActive: () => boolean;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly token: symbol;
}

export interface AnalysisRun {
  readonly isActive: () => boolean;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly token: symbol;
}

export class ConversionRuntimeController {
  private memoryCheckTimer: ReturnType<typeof setInterval> | null = null;
  private activeConversionSeq = 0;
  private activeConversionIntent: {
    abortController: AbortController;
    seq: number;
    token: symbol;
  } | null = null;
  private activeAnalysisRun: {
    abortController: AbortController;
    seq: number;
    token: symbol;
  } | null = null;
  private disposed = false;

  readonly progress: ProgressState;

  constructor(private readonly deps: ConversionRuntimeControllerDeps) {
    this.progress = createProgressState(deps);
  }

  invalidateActiveConversions(): void {
    const activeAnalysis = this.activeAnalysisRun;
    this.activeAnalysisRun = null;
    activeAnalysis?.abortController.abort();
    this.activeConversionSeq += 1;
  }

  getActiveConversionSeq(): number {
    return this.activeConversionSeq;
  }

  startNewRun(): AnalysisRun | null {
    this.abortConversionIntent();
    if (this.activeConversionIntent) return null;
    const previousAnalysis = this.activeAnalysisRun;
    this.activeAnalysisRun = null;
    previousAnalysis?.abortController.abort();

    const seq = (this.activeConversionSeq += 1);
    const token = Symbol('analysis-run');
    const abortController = new AbortController();
    const runId = `run-${seq}-${performance.now().toString(36)}`;
    this.activeAnalysisRun = { abortController, seq, token };
    this.progress.activeRunId = runId;

    return {
      isActive: () =>
        !this.disposed &&
        !abortController.signal.aborted &&
        seq === this.activeConversionSeq &&
        this.activeAnalysisRun?.token === token,
      runId,
      signal: abortController.signal,
      token,
    };
  }

  finishAnalysisRun(run: AnalysisRun): void {
    if (this.activeAnalysisRun?.token === run.token) {
      this.activeAnalysisRun = null;
    }
  }

  beginConversionIntent(): ConversionIntent | null {
    if (this.disposed || this.activeConversionIntent) return null;

    const seq = (this.activeConversionSeq += 1);
    const token = Symbol('conversion-intent');
    const abortController = new AbortController();
    const runId = `run-${seq}-${performance.now().toString(36)}`;
    this.activeConversionIntent = { abortController, seq, token };
    this.progress.activeRunId = runId;

    return {
      isActive: () =>
        !this.disposed &&
        !abortController.signal.aborted &&
        this.activeConversionSeq === seq &&
        this.activeConversionIntent?.token === token,
      runId,
      signal: abortController.signal,
      token,
    };
  }

  finishConversionIntent(intent: ConversionIntent): void {
    if (this.activeConversionIntent?.token === intent.token) {
      this.activeConversionIntent = null;
    }
  }

  abortConversionIntent(): void {
    const active = this.activeConversionIntent;
    if (!active || active.abortController.signal.aborted) return;
    active.abortController.abort();
    this.activeConversionSeq += 1;
  }

  resetRuntimeState(): void {
    this.progress.resetProgressState();
    this.stopMemoryMonitoring();
  }

  /**
   * Full teardown — called by SolidJS onCleanup when the owner scope is disposed.
   * Stops memory monitoring, aborts any in-flight conversion, and marks progress
   * state as disposed so any lingering interval callbacks become no-ops.
   */
  dispose(): void {
    this.stopMemoryMonitoring();
    this.disposed = true;
    this.abortConversionIntent();
    const activeAnalysis = this.activeAnalysisRun;
    this.activeAnalysisRun = null;
    activeAnalysis?.abortController.abort();
    this.progress.disposed = true;
  }

  prepareForNewConversion(startTimeMs: number): void {
    this.progress.prepareForConversion(startTimeMs);
  }

  /** Update the status message shown in the UI during conversion. */
  updateStatus(message: string): void {
    this.progress.updateStatus(message);
  }

  updateMemoryUsage(memoryMB: number): void {
    this.progress.updateMemoryUsage(memoryMB);
  }

  updateProgress(
    progress: number,
    phase?: import('@t/conversion-types').ProgressPhase | string,
    outputFrames?: number
  ): void {
    this.progress.updateProgress(progress, phase, outputFrames);
  }

  startMemoryMonitoring(): void {
    this.stopMemoryMonitoring();
    this.memoryCheckTimer = setInterval(() => {
      if (this.progress.disposed) {
        this.stopMemoryMonitoring();
        return;
      }
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
}
