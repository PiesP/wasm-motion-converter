// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { BYTES_PER_MB } from '@utils/constants';
import { getMemoryUsageMB } from '@utils/memory-monitor';

/**
 * Conversion profiler for the pipeline's real, non-overlapping wall-clock
 * stages. Decode and encode are intentionally one transcoding stage because
 * the streaming pipeline overlaps them and cannot attribute their elapsed
 * time independently.
 */

export type ProfileStage = 'demuxing' | 'transcoding' | 'finalizing';

export const PROFILE_OPERATIONS = [
  'pixelCopy',
  'motionFeatures',
  'motionDecision',
  'gifPixelPreparation',
  'gifQuantization',
  'gifPaletteMapping',
  'gifFrameWrite',
  'webpEncoding',
  'encoderQueueWait',
  'webpMuxing',
  'muxFinalization',
  'outputCopy',
] as const;

export const PROFILE_ENCODER_ROUTES = [
  'gif-worker',
  'gif-main',
  'webp-parallel-canvas',
  'webp-serial-canvas',
  'webp-wasm',
] as const;

export const PROFILE_COPY_PATHS = ['RGBX', 'RGBA', 'BGRA', 'BGRX', 'canvas', 'unknown'] as const;

export type ProfileOperation = (typeof PROFILE_OPERATIONS)[number];
export type ProfileEncoderRoute = (typeof PROFILE_ENCODER_ROUTES)[number];
export type ProfileCopyPath = (typeof PROFILE_COPY_PATHS)[number];
export type ProfileOperationRecorder = (operation: ProfileOperation, wallMs: number) => void;
export type ProfileCopyPathRecorder = (path: ProfileCopyPath) => void;

export interface ProfileOperationTotal {
  /** Accumulated elapsed wall time. These operations may overlap each other. */
  wallMs: number;
  samples: number;
}

export type ProfileOperationTotals = Readonly<Record<ProfileOperation, ProfileOperationTotal>>;

interface CommonStageMetrics {
  stage: ProfileStage;
  startMs: number;
  endMs: number;
  durationMs: number;
  heapStartMB: number | null;
  heapEndMB: number | null;
  heapPeakMB: number | null;
}

export interface DemuxStageMetrics extends CommonStageMetrics {
  stage: 'demuxing';
  framesProcessed: number | null;
  fps: number | null;
}

export interface TranscodingStageMetrics extends CommonStageMetrics {
  stage: 'transcoding';
  mode: 'streaming-decode-encode';
  attribution: 'combined';
  /** Explicit observations only; null means this route did not report the count. */
  consumedChunks: number | null;
  decodedFrames: number | null;
  selectedFrames: number | null;
  encodedFrames: number | null;
  emittedFrames: number | null;
  decodeFps: number | null;
  encodeFps: number | null;
  outputBytes: number | null;
  throughputMBps: number | null;
}

export interface FinalizationStageMetrics extends CommonStageMetrics {
  stage: 'finalizing';
}

export type StageMetrics = DemuxStageMetrics | TranscodingStageMetrics | FinalizationStageMetrics;

interface StageObservations {
  demuxing: { frames: number };
  transcoding: {
    consumedChunks: number;
    decodedFrames: number;
    selectedFrames: number;
    encodedFrames: number;
    emittedFrames: number;
    outputBytes: number;
  };
  finalizing: Record<string, never>;
}

export interface ProfileSpan<S extends ProfileStage> {
  update(observations: Partial<StageObservations[S]>): void;
  end(observations?: Partial<StageObservations[S]>): void;
}

export interface ConversionProfileReport {
  schemaVersion: 4;
  totalDurationMs: number;
  heapStartMB: number | null;
  heapEndMB: number | null;
  heapPeakMB: number | null;
  encoderRoute: ProfileEncoderRoute | null;
  stages: readonly StageMetrics[];
  /** Fine-grained operation wall time. These totals may overlap and are not stage percentages. */
  operationTotals: ProfileOperationTotals;
  /** Count of the pixel-copy strategy chosen by FrameProcessingContext. */
  copyPathCounts: Readonly<Record<ProfileCopyPath, number>>;
  stageWallTimePct: Readonly<Record<ProfileStage, number>>;
  /** Longest observed wall-clock stage; this is not a causal bottleneck claim. */
  dominantStage: ProfileStage | null;
  summary: string;
}

interface ActiveStage {
  stage: ProfileStage;
  startMs: number;
  heapStartMB: number | null;
  heapPeakMB: number | null;
  observations: Record<string, number>;
}

const STAGE_ORDER: readonly ProfileStage[] = ['demuxing', 'transcoding', 'finalizing'];

function maxKnown(first: number | null, second: number | null): number | null {
  if (first === null) return second;
  if (second === null) return first;
  return Math.max(first, second);
}

function roundRate(count: number | null, durationMs: number): number | null {
  if (count === null) return null;
  return durationMs > 0 ? Math.round((count / durationMs) * 1000) : 0;
}

function roundThroughput(outputBytes: number | null, durationMs: number): number | null {
  if (outputBytes === null) return null;
  return durationMs > 0 && outputBytes > 0
    ? Math.round((outputBytes / BYTES_PER_MB / (durationMs / 1000)) * 100) / 100
    : 0;
}

export class ConversionProfiler {
  private readonly pipelineStartMs = performance.now();
  private readonly heapStartMB = ConversionProfiler.getHeapMB();
  private heapPeakMB = this.heapStartMB;
  private readonly stages = new Map<ProfileStage, StageMetrics>();
  private readonly operationTotals = new Map<ProfileOperation, { wallMs: number; samples: number }>(
    PROFILE_OPERATIONS.map((operation) => [operation, { wallMs: 0, samples: 0 }])
  );
  private readonly copyPathCounts = new Map<ProfileCopyPath, number>(
    PROFILE_COPY_PATHS.map((path) => [path, 0])
  );
  private active: ActiveStage | null = null;
  private encoderRoute: ProfileEncoderRoute | null = null;
  private finishedReport: ConversionProfileReport | null = null;

  setEncoderRoute(route: ProfileEncoderRoute): void {
    if (!this.finishedReport) this.encoderRoute = route;
  }

  readonly recordOperation: ProfileOperationRecorder = (operation, wallMs) => {
    if (this.finishedReport || !Number.isFinite(wallMs) || wallMs < 0) return;
    const current = this.operationTotals.get(operation);
    if (!current) return;
    this.operationTotals.set(operation, {
      wallMs: current.wallMs + wallMs,
      samples: current.samples + 1,
    });
  };

  readonly recordCopyPath: ProfileCopyPathRecorder = (path) => {
    if (this.finishedReport) return;
    const current = this.copyPathCounts.get(path);
    if (current === undefined) return;
    this.copyPathCounts.set(path, current + 1);
  };

  begin<S extends ProfileStage>(stage: S): ProfileSpan<S> {
    if (this.finishedReport || this.active || this.stages.has(stage)) {
      return { update: () => undefined, end: () => undefined };
    }

    const heapStartMB = ConversionProfiler.getHeapMB();
    this.heapPeakMB = maxKnown(this.heapPeakMB, heapStartMB);
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
    this.heapPeakMB = maxKnown(this.heapPeakMB, heapEndMB);
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
    const operationTotals = Object.fromEntries(
      PROFILE_OPERATIONS.map((operation) => {
        const total = this.operationTotals.get(operation)!;
        return [
          operation,
          Object.freeze({ wallMs: Math.round(total.wallMs * 100) / 100, samples: total.samples }),
        ];
      })
    ) as Record<ProfileOperation, ProfileOperationTotal>;
    const copyPathCounts = Object.fromEntries(
      PROFILE_COPY_PATHS.map((path) => [path, this.copyPathCounts.get(path)!])
    ) as Record<ProfileCopyPath, number>;
    const summary = [
      `[${totalDurationMs}ms total]`,
      `encoder route: ${this.encoderRoute ?? 'unavailable'}`,
      ...stageSummary,
      `operation wall time: ${
        PROFILE_OPERATIONS.filter((operation) => operationTotals[operation].samples > 0)
          .map(
            (operation) =>
              `${operation}=${operationTotals[operation].wallMs}ms/${operationTotals[operation].samples}`
          )
          .join(', ') || 'unavailable'
      }`,
      `dominant stage: ${dominantStage ?? 'unavailable'}`,
    ].join(' | ');

    const frozenStages = Object.freeze(stages.map((stage) => Object.freeze({ ...stage })));
    this.finishedReport = Object.freeze({
      schemaVersion: 4 as const,
      totalDurationMs,
      heapStartMB: this.heapStartMB,
      heapEndMB,
      heapPeakMB: this.heapPeakMB,
      encoderRoute: this.encoderRoute,
      stages: frozenStages,
      operationTotals: Object.freeze(operationTotals),
      copyPathCounts: Object.freeze(copyPathCounts),
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
      // Counters are cumulative observations. Ignore invalid or stale updates.
      if (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value >= (state.observations[key] ?? 0)
      ) {
        state.observations[key] = value;
      }
    }
  }

  private sampleHeap(state: ActiveStage): void {
    const heapMB = ConversionProfiler.getHeapMB();
    state.heapPeakMB = maxKnown(state.heapPeakMB, heapMB);
    this.heapPeakMB = maxKnown(this.heapPeakMB, heapMB);
  }

  private endStage(state: ActiveStage): void {
    if (this.active !== state || this.finishedReport) return;
    const heapEndMB = ConversionProfiler.getHeapMB();
    state.heapPeakMB = maxKnown(state.heapPeakMB, heapEndMB);
    this.heapPeakMB = maxKnown(this.heapPeakMB, heapEndMB);
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
      const framesProcessed = state.observations.frames ?? null;
      this.stages.set('demuxing', {
        ...common,
        stage: 'demuxing',
        framesProcessed,
        fps: roundRate(framesProcessed, durationMs),
      });
    } else if (state.stage === 'transcoding') {
      const consumedChunks = state.observations.consumedChunks ?? null;
      const decodedFrames = state.observations.decodedFrames ?? null;
      const selectedFrames = state.observations.selectedFrames ?? null;
      const encodedFrames = state.observations.encodedFrames ?? null;
      const emittedFrames = state.observations.emittedFrames ?? null;
      const outputBytes = state.observations.outputBytes ?? null;
      this.stages.set('transcoding', {
        ...common,
        stage: 'transcoding',
        mode: 'streaming-decode-encode',
        attribution: 'combined',
        consumedChunks,
        decodedFrames,
        selectedFrames,
        encodedFrames,
        emittedFrames,
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
    const memory = stage.heapPeakMB !== null ? ` (peak ${stage.heapPeakMB}MB)` : '';
    if (stage.stage === 'demuxing') {
      return `${base} @ ${stage.fps ?? 'unknown'}fps${memory}`;
    }
    if (stage.stage === 'transcoding') {
      return (
        `${base} (streaming decode+encode; attribution unavailable; ` +
        `${stage.decodedFrames ?? 'unknown'} decoded/${stage.encodedFrames ?? 'unknown'} encoded) ` +
        `@ ${stage.encodeFps ?? 'unknown'}fps, ${stage.throughputMBps ?? 'unknown'}MB/s${memory}`
      );
    }
    return `${base}${memory}`;
  }

  private static getHeapMB(): number | null {
    return getMemoryUsageMB();
  }
}
