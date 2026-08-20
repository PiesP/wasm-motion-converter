// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ConversionFormat } from '@t/conversion-types';
import {
  GIF_MAX_OUTPUT_BYTES,
  GIF_MAX_OUTPUT_FRAMES,
  WEBP_MAX_FRAMES,
  WEBP_MAX_OUTPUT_BYTES,
} from '@utils/constants';

export interface OutputLimits {
  maxFrames: number;
  maxOutputBytes: number;
}

export interface OutputLimitOverrides {
  maxFrames?: number | undefined;
  maxOutputBytes?: number | undefined;
}

const FORMAT_OUTPUT_LIMITS: Readonly<Record<ConversionFormat, OutputLimits>> = {
  gif: {
    maxFrames: GIF_MAX_OUTPUT_FRAMES,
    maxOutputBytes: GIF_MAX_OUTPUT_BYTES,
  },
  webp: {
    maxFrames: WEBP_MAX_FRAMES,
    maxOutputBytes: WEBP_MAX_OUTPUT_BYTES,
  },
};

function clampRequestedLimit(requested: number | undefined, hardLimit: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return hardLimit;
  return Math.min(hardLimit, Math.floor(requested));
}

/** Resolve caller limits without allowing a request to exceed the format hard ceiling. */
export function resolveOutputLimits(
  format: ConversionFormat,
  requested?: OutputLimitOverrides
): OutputLimits {
  const hardLimits = FORMAT_OUTPUT_LIMITS[format];
  return {
    maxFrames: clampRequestedLimit(requested?.maxFrames, hardLimits.maxFrames),
    maxOutputBytes: clampRequestedLimit(requested?.maxOutputBytes, hardLimits.maxOutputBytes),
  };
}

export class OutputLimitError extends Error {
  constructor(format: ConversionFormat, kind: 'frame' | 'byte', limit: number) {
    super(`${format === 'gif' ? 'GIF' : 'WebP'} output ${kind} limit exceeded (${limit})`);
    this.name = 'OutputLimitError';
  }
}
