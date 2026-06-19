// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * V2 Conversion Types
 *
 * Type definitions for the WebCodecs-based conversion pipeline.
 * Reuses canonical format/quality types from conversion-types.ts.
 */
import type { ConversionFormat, ConversionQuality, SmartFrameSkipMode } from '@t/conversion-types';

export type { ConversionFormat, ConversionQuality };

/** Callback type for conversion progress updates (shared across all encoders) */
export type ProgressCallback = (progress: ConversionProgress) => void;

export interface ConversionRequest {
  inputBuffer: ArrayBuffer;
  fileName: string;
  format: ConversionFormat;
  quality: ConversionQuality;
  scale: number;
  trimStart: number;
  trimEnd: number;
  maxMemoryMB: number;
  /** Force frame decimation (overrides auto-decimation) */
  forceDecimation?: number;
  /** Smart frame skip mode — similarity-based frame deduplication */
  smartFrameSkip?: SmartFrameSkipMode;
}

/** Pipeline phase identifier (short form for internal use) */
export type ConversionPhase = 'demux' | 'decode' | 'encode' | 'assemble';

/** Human-readable phase labels for UI display */
export const PHASE_LABELS: Record<ConversionPhase, string> = {
  demux: 'Demux',
  decode: 'Decode',
  encode: 'Encode',
  assemble: 'Final',
} as const;

/** Progress callback phase — maps to the same values but typed separately for UI */
export type ProgressPhase = 'demuxing' | 'decoding' | 'encoding' | 'assembling';

/** Map internal phase to progress display name */
export function toProgressPhase(phase: ConversionPhase): ProgressPhase {
  switch (phase) {
    case 'demux':
      return 'demuxing';
    case 'decode':
      return 'decoding';
    case 'encode':
      return 'encoding';
    case 'assemble':
      return 'assembling';
  }
}

/** Map progress display name to internal phase */
export function fromProgressPhase(phase: ProgressPhase): ConversionPhase {
  switch (phase) {
    case 'demuxing':
      return 'demux';
    case 'decoding':
      return 'decode';
    case 'encoding':
      return 'encode';
    case 'assembling':
      return 'assemble';
  }
}

export interface ConversionProgress {
  phase: ProgressPhase;
  progress: number;
  fps: number;
  etaSeconds: number | null;
  memoryMB: number;
  currentFrame?: number;
  totalFrames?: number;
  outputFrames?: number;
  elapsedMs?: number;
}
