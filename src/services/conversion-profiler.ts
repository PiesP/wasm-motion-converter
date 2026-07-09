// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { BYTES_PER_MB } from '../utils/constants.js';
import { getMemoryUsageMB } from '../utils/memory-monitor.js';

/**
 * Conversion Profiler — per-phase timing, memory, and throughput measurement.
 *
 * Tracks each pipeline phase (demux, decode, encode, assemble) independently
 * with high-resolution timestamps, JS heap snapshots, and derived metrics
 * (fps, throughput MB/s, time distribution).
 *
 * Usage:
 *   const profiler = new ConversionProfiler();
 *   profiler.startPhase('demuxing');
 *   // ... demux work ...
 *   profiler.endPhase('demuxing', { frames: 150 });
 *   // ... decode/encode ...
 *   profiler.endPhase('encoding', { frames: 75, outputBytes: 1024000 });
 *   const report = profiler.finish();
 *   logger.performance('Pipeline profile', report);
 */

import type { ProgressPhase } from '@t/conversion-types';

export interface PhaseMetrics {
  phase: ProgressPhase;
  startMs: number;
  endMs: number;
  durationMs: number;
  /** JS heap at phase start (MB) */
  heapStartMB: number;
  /** JS heap at phase end (MB) */
  heapEndMB: number;
  /** Peak JS heap during phase (MB) */
  heapPeakMB: number;
  /** Frames processed in this phase */
  framesProcessed: number;
  /** Frames per second (decode/encode only) */
  fps: number;
  /** Output bytes (encode phase only) */
  outputBytes: number;
  /** Throughput in MB/s (encode phase only) */
  throughputMBps: number;
}

export interface ConversionProfileReport {
  /** Total pipeline duration (ms) */
  totalDurationMs: number;
  /** JS heap at pipeline start (MB) */
  heapStartMB: number;
  /** JS heap at pipeline end (MB) */
  heapEndMB: number;
  /** Peak JS heap across all phases (MB) */
  heapPeakMB: number;
  /** Phase breakdown */
  phases: PhaseMetrics[];
  /** Percentage of total time per phase */
  phaseTimePct: Record<ProgressPhase, number>;
  /** Bottleneck phase (longest duration) */
  bottleneck: ProgressPhase;
  /** Summary string for quick inspection */
  summary: string;
}

interface PhaseState {
  startMs: number;
  heapStartMB: number;
  heapPeakMB: number;
  framesProcessed: number;
  outputBytes: number;
}

export class ConversionProfiler {
  private phases: Map<ProgressPhase, PhaseMetrics> = new Map();
  private active: Map<ProgressPhase, PhaseState> = new Map();
  private pipelineStartMs: number = 0;
  private heapStartMB: number = 0;
  private heapPeakMB: number = 0;
  private finished = false;

  /** Start profiling a pipeline. Call once before any phase. */
  start(): void {
    this.pipelineStartMs = performance.now();
    this.heapStartMB = ConversionProfiler.getHeapMB();
    this.heapPeakMB = this.heapStartMB;
    this.phases.clear();
    this.active.clear();
    this.finished = false;
  }

  /** Mark the beginning of a phase. */
  startPhase(phase: ProgressPhase): void {
    if (this.active.has(phase)) {
      // Phase already started (shouldn't happen in normal flow)
      return;
    }
    const heapMB = ConversionProfiler.getHeapMB();
    if (heapMB > this.heapPeakMB) this.heapPeakMB = heapMB;
    this.active.set(phase, {
      startMs: performance.now(),
      heapStartMB: heapMB,
      heapPeakMB: heapMB,
      framesProcessed: 0,
      outputBytes: 0,
    });
  }

  /**
   * Update mid-phase metrics (for long-running phases).
   * Call periodically to track frame progress and heap peaks.
   */
  updatePhase(phase: ProgressPhase, framesProcessed: number): void {
    const state = this.active.get(phase);
    if (!state) return;
    state.framesProcessed = framesProcessed;
    const heapMB = ConversionProfiler.getHeapMB();
    if (heapMB > state.heapPeakMB) state.heapPeakMB = heapMB;
    if (heapMB > this.heapPeakMB) this.heapPeakMB = heapMB;
  }

  /**
   * Mark the end of a phase with final metrics.
   */
  endPhase(phase: ProgressPhase, opts?: { frames?: number; outputBytes?: number }): void {
    const state = this.active.get(phase);
    if (!state) return;

    const endMs = performance.now();
    const heapEndMB = ConversionProfiler.getHeapMB();
    const frames = opts?.frames ?? state.framesProcessed;
    const outputBytes = opts?.outputBytes ?? state.outputBytes;
    const durationMs = Math.round(endMs - state.startMs);

    if (heapEndMB > state.heapPeakMB) state.heapPeakMB = heapEndMB;
    if (state.heapPeakMB > this.heapPeakMB) this.heapPeakMB = state.heapPeakMB;

    const fps = durationMs > 0 ? Math.round((frames / durationMs) * 1000) : 0;
    const throughputMBps =
      durationMs > 0 && outputBytes > 0
        ? Math.round((outputBytes / BYTES_PER_MB / (durationMs / 1000)) * 100) / 100
        : 0;

    this.phases.set(phase, {
      phase,
      startMs: Math.round(state.startMs - this.pipelineStartMs),
      endMs: Math.round(endMs - this.pipelineStartMs),
      durationMs,
      heapStartMB: state.heapStartMB,
      heapEndMB,
      heapPeakMB: state.heapPeakMB,
      framesProcessed: frames,
      fps,
      outputBytes,
      throughputMBps,
    });

    this.active.delete(phase);
  }

  /**
   * Get the report without marking as finished.
   * Safe to call multiple times after all phases are ended.
   */
  getReport(): ConversionProfileReport {
    return this.buildReport();
  }

  /**
   * Finish profiling and generate a structured report.
   * Stores the report for later retrieval via getLastReport().
   */
  finish(): ConversionProfileReport {
    if (!this.finished) {
      this.finished = true;
      this.lastReport = this.buildReport();
    }
    return this.lastReport!;
  }

  /** Get the last finished report, or null if finish() was never called. */
  getLastReport(): ConversionProfileReport | null {
    return this.lastReport;
  }

  private lastReport: ConversionProfileReport | null = null;

  private buildReport(): ConversionProfileReport {
    const totalDurationMs = Math.round(performance.now() - this.pipelineStartMs);
    const heapEndMB = ConversionProfiler.getHeapMB();

    const phaseList = Array.from(this.phases.values());
    const phaseTimePct: Record<ProgressPhase, number> = {
      demuxing: 0,
      decoding: 0,
      encoding: 0,
      assembling: 0,
    };

    let bottleneck: ProgressPhase = 'demuxing';
    let maxDuration = 0;

    for (const p of phaseList) {
      phaseTimePct[p.phase] =
        totalDurationMs > 0 ? Math.round((p.durationMs / totalDurationMs) * 1000) / 10 : 0;
      if (p.durationMs > maxDuration) {
        maxDuration = p.durationMs;
        bottleneck = p.phase;
      }
    }

    const summary = phaseList
      .map((p) => {
        const extra = p.fps > 0 ? ` @ ${p.fps}fps` : '';
        const mem = p.heapPeakMB > 0 ? ` (peak ${p.heapPeakMB}MB)` : '';
        return `${p.phase}: ${p.durationMs}ms (${phaseTimePct[p.phase]}%)${extra}${mem}`;
      })
      .join(' | ');

    return {
      totalDurationMs,
      heapStartMB: this.heapStartMB,
      heapEndMB,
      heapPeakMB: this.heapPeakMB,
      phases: phaseList,
      phaseTimePct,
      bottleneck,
      summary: `[${totalDurationMs}ms total] ${summary} | bottleneck: ${bottleneck}`,
    };
  }

  /** Get current JS heap usage in MB (best-effort, returns 0 if unavailable) */
  private static getHeapMB(): number {
    const heapMB = getMemoryUsageMB();
    return heapMB ?? 0;
  }
}
