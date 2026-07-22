// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { ConversionRequest } from '@t/conversion-types';
import { WORKER_MAX_MEMORY_MB } from '@utils/constants';
import type { SerializedConversionOptions } from './types';

/**
 * Build the request consumed by both the Worker and its main-thread fallback.
 *
 * An omitted forceDecimation means "use the format's automatic target FPS".
 * It must not be normalized to 1 here: 1 is an explicit keep-every-frame
 * override and is unsafe for high-resolution AVIF sequences.
 */
export function buildConversionRequest(
  inputBuffer: ArrayBuffer,
  options: SerializedConversionOptions,
  maxMemoryMB = WORKER_MAX_MEMORY_MB,
  inputBlob?: Blob,
  fileName = 'input.webm'
): ConversionRequest {
  return {
    inputBuffer,
    inputBlob,
    fileName,
    format: options.format,
    quality: options.quality,
    scale: options.scale,
    trimStart: options.trimStart,
    trimEnd: options.trimEnd,
    maxMemoryMB,
    forceDecimation: options.forceDecimation,
    smartFrameSkip: options.smartFrameSkip ?? 'off',
  };
}
