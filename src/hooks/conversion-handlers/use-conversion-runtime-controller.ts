// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { isMemoryCritical } from '@utils/memory-monitor';
import type { Setter } from 'solid-js';

import { useProgressState } from './use-progress-state';

const MEMORY_CHECK_INTERVAL = 5000;

interface ConversionRuntimeControllerDeps {
  setConversionStartTime: Setter<number>;
  setEstimatedSecondsRemaining: Setter<number | null>;
  setMemoryWarning: Setter<boolean>;
  setConversionPhase?: Setter<import('@t/conversion-types').ProgressPhase> | undefined;
}

export class ConversionRuntimeController {
  private memoryCheckTimer: ReturnType<typeof setInterval> | null = null;
  private activeConversionSeq = 0;

  readonly progress: ReturnType<typeof useProgressState>;

  constructor(private readonly deps: ConversionRuntimeControllerDeps) {
    this.progress = useProgressState(deps);
  }

  invalidateActiveConversions(): void {
    this.activeConversionSeq += 1;
  }

  getActiveConversionSeq(): number {
    return this.activeConversionSeq;
  }

  startNewRun(): { isActive: () => boolean; runId: string } {
    const seq = (this.activeConversionSeq += 1);
    const runId = `run-${seq}-${performance.now().toString(36)}`;
    this.progress.activeRunId = runId;

    return {
      isActive: () => seq === this.activeConversionSeq,
      runId,
    };
  }

  resetRuntimeState(): void {
    this.progress.resetProgressState();
    this.stopMemoryMonitoring();
  }

  /**
   * Full teardown — called by SolidJS onCleanup when the owner scope is disposed.
   * Stops memory monitoring and marks progress state as disposed so any
   * lingering interval callbacks become no-ops.
   */
  dispose(): void {
    this.stopMemoryMonitoring();
    this.progress.disposed = true;
  }

  prepareForNewConversion(startTimeMs: number): void {
    this.progress.prepareForConversion(startTimeMs);
  }

  /** Update the status message shown in the UI during conversion. */
  updateStatus(message: string): void {
    this.progress.updateStatus(message);
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
