// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

// Message protocol types for the conversion worker

import type { ConversionProfileReport } from '@services/conversion-profiler';
import type { GifOutputPart } from '@services/gif-encoder-service';
import type { OwnedInputIndexSnapshot } from '@services/owned-input-index-cache';
import type { OwnedVp8FailureKind } from '@services/owned-vp8-errors';
import type {
  ConversionFormat,
  ConversionQuality,
  SmartFrameSkipMode,
  VideoRotation,
} from '@t/conversion-types';

export const WORKER_LOG_MAX_EVENTS = 16;
export const WORKER_LOG_MAX_MESSAGE_CHARS = 512;
export const WORKER_LOG_MAX_REQUEST_ID_CHARS = 64;
export type WorkerLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type WorkerLogCategory = 'conversion' | 'general' | 'demuxer' | 'encoders' | 'decoders';
export const OWNED_DEMUX_FAILURE_KINDS = [
  'load',
  'abi',
  'resource',
  'parse',
  'conversion',
] as const;
export type OwnedDemuxFailureKind = (typeof OWNED_DEMUX_FAILURE_KINDS)[number];

type WorkerInput =
  | { inputBuffer: ArrayBuffer; inputBlob?: never }
  | { inputBlob: Blob; inputBuffer?: never };

export type WorkerRequest =
  | ({
      type: 'start';
      outputMode?: 'gif-parts';
      requestId: string;
      config: SerializedDecoderConfig;
      options: SerializedConversionOptions;
      /** Pre-computed metadata to skip redundant extractVideoMetadata in worker */
      duration?: number;
      framerate?: number;
      /** Checked logical index copied from the exact selected Blob. */
      indexSnapshot?: OwnedInputIndexSnapshot;
    } & WorkerInput)
  | { type: 'gif-part-saved'; requestId: string; index: number }
  | { type: 'abort'; requestId: string };

export interface GifPartsSummary {
  partCount: number;
  frameCount: number;
}

export type WorkerResponse =
  | { type: 'gif-part'; requestId: string; part: GifOutputPart }
  | ({ type: 'gif-parts-complete'; requestId: string } & GifPartsSummary)
  | { type: 'ready'; requestId: '' }
  | {
      type: 'progress';
      requestId: string;
      phase: 'demuxing' | 'decoding' | 'encoding' | 'assembling';
      percent: number;
      /** Rate for the currently reported decode or encode count. */
      fps: number;
      /** Measured JS heap is unavailable inside this Worker. */
      memoryMB: number | null;
      /** Conversion-owned input, pool, and output estimate, separate from JS heap. */
      accountedMemoryMB?: number;
      consumedChunks?: number;
      decodedFrames?: number;
      selectedFrames?: number;
      encodedFrames?: number;
      emittedFrames?: number;
      gifRetainedMappedFrames?: number;
      gifRetainedImageDataWrites?: number;
      gifRetainedWasmCapacityBytes?: number;
      currentFrame?: number;
      /** Source or output planning denominator; VFR media may differ. */
      totalFrames?: number;
      /** Physical emitted frames, only after an encoder reports the exact count. */
      outputFrames?: number | undefined;
      etaSeconds: number | null;
      elapsedMs?: number | undefined;
    }
  | {
      type: 'complete';
      requestId: string;
      outputBuffer: ArrayBuffer | Blob;
      durationMs: number;
      /** Development-only profile captured inside the Worker realm. */
      profile?: ConversionProfileReport;
    }
  | {
      type: 'error';
      requestId: string;
      message: string;
      code: string;
      /** Checked diagnostic for a typed owned-demux failure across the Worker boundary. */
      demuxFailureKind?: OwnedDemuxFailureKind;
      /** Checked diagnostic for a typed owned VP8 failure. */
      ownedVp8FailureKind?: OwnedVp8FailureKind;
    }
  | {
      type: 'log';
      requestId: string;
      level: WorkerLogLevel;
      category: WorkerLogCategory;
      message: string;
    };

export interface SerializedDecoderConfig {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  displayAspectWidth?: number | undefined;
  displayAspectHeight?: number | undefined;
  hardwareAcceleration?: string | undefined;
  colorSpace?: VideoDecoderConfig['colorSpace'] | undefined;
  description?: ArrayBuffer | undefined;
  rotation?: VideoRotation | undefined;
}

export interface SerializedConversionOptions {
  format: ConversionFormat;
  quality: ConversionQuality;
  fps: number;
  scale: number;
  trimStart: number;
  trimEnd: number;
  maxFrames: number;
  maxOutputBytes: number;
  /** Explicit integer source-frame gap (overrides automatic cadence). */
  forceDecimation?: number | undefined;
  /** Additional fractional presentation-time restriction from critical memory pressure. */
  memoryPressureCadenceRatio?: number | undefined;
  /** Smart frame skip mode — similarity-based frame deduplication */
  smartFrameSkip?: SmartFrameSkipMode | undefined;
  /** Total plays (zero or omitted means forever). */
  playCount?: number | undefined;
  /** Dynamic memory limit (MB) forwarded from main thread */
  maxMemoryMB?: number | undefined;
}
