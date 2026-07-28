// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

// Message protocol types for the conversion worker

import type { ConversionProfileReport } from '@services/conversion-profiler';
import type { ConversionFormat, ConversionQuality, SmartFrameSkipMode } from '@t/conversion-types';

export type WorkerRequest =
  | {
      type: 'start';
      requestId: string;
      inputBuffer: ArrayBuffer;
      config: SerializedDecoderConfig;
      options: SerializedConversionOptions;
      /** Pre-computed metadata to skip redundant extractVideoMetadata in worker */
      duration?: number;
      framerate?: number;
    }
  | { type: 'abort'; requestId: string };

export type WorkerResponse =
  | {
      type: 'progress';
      requestId: string;
      phase: 'demuxing' | 'decoding' | 'encoding' | 'assembling';
      percent: number;
      fps: number;
      memoryMB: number;
      currentFrame?: number;
      totalFrames?: number;
      outputFrames?: number | undefined;
      etaSeconds: number;
      elapsedMs?: number | undefined;
    }
  | {
      type: 'complete';
      requestId: string;
      outputBuffer: ArrayBuffer;
      durationMs: number;
      /** Development-only profile captured inside the Worker realm. */
      profile?: ConversionProfileReport;
    }
  | { type: 'error'; requestId: string; message: string; code: string }
  | { type: 'log'; requestId: string; level: string; message: string };

export interface SerializedDecoderConfig {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  displayAspectWidth?: number | undefined;
  displayAspectHeight?: number | undefined;
  hardwareAcceleration?: string | undefined;
  description?: string | undefined;
}

export interface SerializedConversionOptions {
  format: ConversionFormat;
  quality: ConversionQuality;
  fps: number;
  scale: number;
  trimStart: number;
  trimEnd: number;
  maxFrames: number;
  /** Force frame decimation (overrides auto-decimation) */
  forceDecimation?: number | undefined;
  /** Smart frame skip mode — similarity-based frame deduplication */
  smartFrameSkip?: SmartFrameSkipMode | undefined;
  /** Dynamic memory limit (MB) forwarded from main thread */
  maxMemoryMB?: number | undefined;
}
