// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { BYTES_PER_MB } from '../utils/constants.js';
import { getMemoryUsageMB } from '../utils/memory-monitor.js';

/**
 * Conversion profiler for the pipeline's real, non-overlapping wall-clock
 * stages. Decode and encode are intentionally one transcoding stage because
 * the streaming pipeline overlaps them and cannot attribute their elapsed
 * time independently.
 */

export type ProfileStage = 'demuxing' | 'transcoding' | 'finalizing';

interface CommonStageMetrics {
  stage: ProfileStage;
  startMs: number;
  endMs: number;
  durationMs: number;
  heapStartMB: number;
  heapEndMB: number;
  heapPeakMB: number;
}

export interface DemuxStageMetrics extends CommonStageMetrics {
  stage: 'demuxing';
  framesProcessed: number;
  fps: number;
}

export interface TranscodingStageMetrics extends CommonStageMetrics {
  stage: 'transcoding';
  mode: 'streaming-decode-encode';
  attribution: 'combined';
  decodedFrames: number;
  encodedFrames: number;
  decodeFps: number;
  encodeFps: number;
  outputBytes: number;
  throughputMBps: number;
}

export interface FinalizationStageMetrics extends CommonStageMetrics {
  stage: 'finalizing';
}

export type StageMetrics = DemuxStageMetrics | TranscodingStageMetrics | FinalizationStageMetrics;

interface StageObservations {
  demuxing: { frames: number };
  transcoding: { decodedFrames: number; encodedFrames: number; outputBytes: number };
  finalizing: Record<string, never>;
}

export interface ProfileSpan<S extends ProfileStage> {
  update(observations: Partial<StageObservations[S]>): void;
  end(observations?: Partial<StageObservations[S]>): void;
}

export interface ConversionProfileReport {
  schemaVersion: 2;
  totalDurationMs: number;
  heapStartMB: number;
  heapEndMB: number;
  heapPeakMB: number;
  stages: readonly StageMetrics[];
  stageWallTimePct: Readonly<Record<ProfileStage, number>>;
  /** Longest observed wall-clock stage; this is not a causal bottleneck claim. */
  dominantStage: ProfileStage | null;
  summary: string;
}

interface ActiveStage {
  stage: ProfileStage;
  startMs: number;
  heapStartMB: number;
  heapPeakMB: number;
  observations: Record<string, number>;
}

const STAGE_ORDER: readonly ProfileStage[] = ['demuxing', 'transcoding', 'finalizing'];

function roundRate(count: number, durationMs: number): number {
  return durationMs > 0 ? Math.round((count / durationMs) * 1000) : 0;
}

function roundThroughput(outputBytes: number, durationMs: number): number {
  return durationMs > 0 && outputBytes > 0
    ? Math.round((outputBytes / BYTES_PER_MB / (durationMs / 1000)) * 100) / 100
    : 0;
}

export class ConversionProfiler {
  private readonly pipelineStartMs = performance.now();
  private readonly heapStartMB = ConversionProfiler.getHeapMB();
  private heapPeakMB = this.heapStartMB;
  private readonly stages = new Map<ProfileStage, StageMetrics>();
  private active: ActiveStage | null = null;
  private finishedReport: ConversionProfileReport | null = null;

  begin<S extends ProfileStage>(stage: S): ProfileSpan<S> {
    if (this.finishedReport || this.active || this.stages.has(stage)) {
      return { update: () => undefined, end: () => undefined };
    }

    const heapStartMB = ConversionProfiler.getHeapMB();
    this.heapPeakMB = Math.max(this.heapPeakMB, heapStartMB);
    const state: ActiveStage = {
      stage,
      startMs: performance.now(),
      heapStartMB,
      heapPeakMB: heapStartMB,
      observations: {},
    };
    this.active = state;

    let ended = false;
    const update = (observations: Partial<StageObservations[S]>): void => {
      if (ended || this.active !== state || this.finishedReport) return;
      this.mergeObservations(state, observations);
      this.sampleHeap(state);
    };

    return {
      update,
      end: (observations = {}) => {
        if (ended) return;
        update(observations);
        ended = true;
        this.endStage(state);
      },
    };
  }

  finish(): ConversionProfileReport {
    if (this.finishedReport) return this.finishedReport;
    if (this.active) this.endStage(this.active);

    const totalDurationMs = Math.max(0, Math.round(performance.now() - this.pipelineStartMs));
    const heapEndMB = ConversionProfiler.getHeapMB();
    this.heapPeakMB = Math.max(this.heapPeakMB, heapEndMB);
    const stages = STAGE_ORDER.flatMap((stage) => {
      const metrics = this.stages.get(stage);
      return metrics ? [metrics] : [];
    });
    const stageWallTimePct: Record<ProfileStage, number> = {
      demuxing: 0,
      transcoding: 0,
      finalizing: 0,
    };
    let dominantStage: ProfileStage | null = null;
    let dominantDurationMs = -1;

    for (const stage of stages) {
      stageWallTimePct[stage.stage] =
        totalDurationMs > 0 ? Math.round((stage.durationMs / totalDurationMs) * 1000) / 10 : 0;
      if (stage.durationMs > dominantDurationMs) {
        dominantDurationMs = stage.durationMs;
        dominantStage = stage.stage;
      }
    }

    const stageSummary = stages.map((stage) => this.summarizeStage(stage, stageWallTimePct));
    const summary = [
      `[${totalDurationMs}ms total]`,
      ...stageSummary,
      `dominant stage: ${dominantStage ?? 'unavailable'}`,
    ].join(' | ');

    const frozenStages = Object.freeze(stages.map((stage) => Object.freeze({ ...stage })));
    this.finishedReport = Object.freeze({
      schemaVersion: 2 as const,
      totalDurationMs,
      heapStartMB: this.heapStartMB,
      heapEndMB,
      heapPeakMB: this.heapPeakMB,
      stages: frozenStages,
      stageWallTimePct: Object.freeze({ ...stageWallTimePct }),
      dominantStage,
      summary,
    });
    return this.finishedReport;
  }

  private mergeObservations<S extends ProfileStage>(
    state: ActiveStage,
    observations: Partial<StageObservations[S]>
  ): void {
    for (const [key, value] of Object.entries(observations)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        state.observations[key] = value;
      }
    }
  }

  private sampleHeap(state: ActiveStage): void {
    const heapMB = ConversionProfiler.getHeapMB();
    state.heapPeakMB = Math.max(state.heapPeakMB, heapMB);
    this.heapPeakMB = Math.max(this.heapPeakMB, heapMB);
  }

  private endStage(state: ActiveStage): void {
    if (this.active !== state || this.finishedReport) return;
    const heapEndMB = ConversionProfiler.getHeapMB();
    state.heapPeakMB = Math.max(state.heapPeakMB, heapEndMB);
    this.heapPeakMB = Math.max(this.heapPeakMB, heapEndMB);
    const endMs = performance.now();
    const durationMs = Math.max(0, Math.round(endMs - state.startMs));
    const common = {
      startMs: Math.max(0, Math.round(state.startMs - this.pipelineStartMs)),
      endMs: Math.max(0, Math.round(endMs - this.pipelineStartMs)),
      durationMs,
      heapStartMB: state.heapStartMB,
      heapEndMB,
      heapPeakMB: state.heapPeakMB,
    };

    if (state.stage === 'demuxing') {
      const framesProcessed = state.observations.frames ?? 0;
      this.stages.set('demuxing', {
        ...common,
        stage: 'demuxing',
        framesProcessed,
        fps: roundRate(framesProcessed, durationMs),
      });
    } else if (state.stage === 'transcoding') {
      const decodedFrames = state.observations.decodedFrames ?? 0;
      const encodedFrames = state.observations.encodedFrames ?? 0;
      const outputBytes = state.observations.outputBytes ?? 0;
      this.stages.set('transcoding', {
        ...common,
        stage: 'transcoding',
        mode: 'streaming-decode-encode',
        attribution: 'combined',
        decodedFrames,
        encodedFrames,
        decodeFps: roundRate(decodedFrames, durationMs),
        encodeFps: roundRate(encodedFrames, durationMs),
        outputBytes,
        throughputMBps: roundThroughput(outputBytes, durationMs),
      });
    } else {
      this.stages.set('finalizing', { ...common, stage: 'finalizing' });
    }
    this.active = null;
  }

  private summarizeStage(
    stage: StageMetrics,
    percentages: Readonly<Record<ProfileStage, number>>
  ): string {
    const base = `${stage.stage}: ${stage.durationMs}ms (${percentages[stage.stage]}%)`;
    const memory = stage.heapPeakMB > 0 ? ` (peak ${stage.heapPeakMB}MB)` : '';
    if (stage.stage === 'demuxing') {
      return `${base} @ ${stage.fps}fps${memory}`;
    }
    if (stage.stage === 'transcoding') {
      return (
        `${base} (streaming decode+encode; attribution unavailable; ` +
        `${stage.decodedFrames} decoded/${stage.encodedFrames} encoded) ` +
        `@ ${stage.encodeFps}fps, ${stage.throughputMBps}MB/s${memory}`
      );
    }
    return `${base}${memory}`;
  }

  private static getHeapMB(): number {
    return getMemoryUsageMB() ?? 0;
  }
}
