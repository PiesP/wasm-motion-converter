// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { resolveOutputLimits } from '@services/output-limits';
import type { ConversionRequest, PrecomputedVideoMetadata } from '@t/conversion-types';
import { DEFAULT_FPS, WORKER_MAX_MEMORY_MB } from '@utils/constants';

import type { SerializedConversionOptions, SerializedDecoderConfig } from './types';

/** Reconstruct only what demux consumes from the existing serialized decoder input. */
function toPrecomputedVideoMetadata(
  config: SerializedDecoderConfig | undefined,
  duration: number | undefined,
  framerate: number | undefined
): PrecomputedVideoMetadata | undefined {
  if (!config) return undefined;
  return {
    duration: duration ?? 0,
    framerate: framerate ?? DEFAULT_FPS,
    config: {
      codec: config.codec,
      codedWidth: config.codedWidth,
      codedHeight: config.codedHeight,
      ...(config.displayAspectWidth !== undefined
        ? { displayAspectWidth: config.displayAspectWidth }
        : {}),
      ...(config.displayAspectHeight !== undefined
        ? { displayAspectHeight: config.displayAspectHeight }
        : {}),
      ...(config.hardwareAcceleration !== undefined
        ? { hardwareAcceleration: config.hardwareAcceleration as HardwareAcceleration }
        : {}),
      ...(config.colorSpace !== undefined ? { colorSpace: config.colorSpace } : {}),
      ...(config.description !== undefined ? { description: config.description } : {}),
    },
    ...(config.rotation !== undefined ? { rotation: config.rotation } : {}),
  };
}

/**
 * Build the request consumed by both the Worker and its main-thread fallback.
 *
 * An omitted forceDecimation means "use the format's automatic target FPS".
 * It must not be normalized to 1 here: 1 is an explicit keep-every-frame
 * override and can be unsafe for high-resolution conversions.
 */
export function buildConversionRequest(
  inputBuffer: ArrayBuffer | undefined,
  options: SerializedConversionOptions,
  maxMemoryMB = WORKER_MAX_MEMORY_MB,
  inputBlob?: Blob,
  fileName = 'input.webm',
  config?: SerializedDecoderConfig,
  duration?: number,
  framerate?: number
): ConversionRequest {
  const outputLimits = resolveOutputLimits(options.format, {
    maxFrames: options.maxFrames,
    maxOutputBytes: options.maxOutputBytes,
  });
  return {
    ...(inputBuffer !== undefined ? { inputBuffer } : {}),
    ...(inputBlob !== undefined ? { inputBlob } : {}),
    ...(config !== undefined
      ? { preComputedMetadata: toPrecomputedVideoMetadata(config, duration, framerate) }
      : {}),
    fileName,
    format: options.format,
    quality: options.quality,
    scale: options.scale,
    trimStart: options.trimStart,
    trimEnd: options.trimEnd,
    maxMemoryMB,
    ...outputLimits,
    forceDecimation: options.forceDecimation,
    memoryPressureCadenceRatio: options.memoryPressureCadenceRatio,
    smartFrameSkip: options.smartFrameSkip ?? 'off',
  };
}
