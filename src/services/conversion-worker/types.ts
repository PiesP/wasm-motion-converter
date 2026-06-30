// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

// Message protocol types for the conversion worker

import type { ConversionFormat, ConversionQuality, SmartFrameSkipMode } from '@t/conversion-types';

export type WorkerRequest =
  | {
      type: 'start';
      requestId: string;
      inputBuffer: ArrayBuffer;
      config: SerializedDecoderConfig;
      options: SerializedConversionOptions;
    }
  | { type: 'abort'; requestId: string };

export type WorkerResponse =
  | {
      type: 'progress';
      requestId: string;
      phase: string;
      percent: number;
      fps: number;
      memoryMB: number;
      currentFrame?: number;
      totalFrames?: number;
      elapsedMs?: number;
    }
  | {
      type: 'complete';
      requestId: string;
      outputBuffer: ArrayBuffer;
      durationMs: number;
    }
  | { type: 'error'; requestId: string; message: string; code: string }
  | { type: 'log'; requestId: string; level: string; message: string };

export interface SerializedDecoderConfig {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  displayAspectWidth?: number;
  displayAspectHeight?: number;
  hardwareAcceleration?: string;
  description?: string;
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
  forceDecimation?: number;
  /** Smart frame skip mode — similarity-based frame deduplication */
  smartFrameSkip?: SmartFrameSkipMode;
}
