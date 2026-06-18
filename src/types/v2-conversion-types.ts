// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * V2 Conversion Types
 *
 * Type definitions for the WebCodecs-based conversion pipeline.
 * Reuses canonical format/quality types from conversion-types.ts.
 */
import type { ConversionFormat, ConversionQuality } from '@t/conversion-types';

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
  /** Force frame decimation (overrides auto-decimation for GIF) */
  forceDecimation?: number;
}

export type ConversionPhase = 'demuxing' | 'decoding' | 'encoding' | 'assembling';

export interface ConversionProgress {
  phase: ConversionPhase;
  progress: number;
  fps: number;
  etaSeconds: number | null;
  memoryMB: number;
  currentFrame?: number;
  totalFrames?: number;
  elapsedMs?: number;
}
