// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ConversionProgress } from '@t/conversion-types';
import { PROGRESS_PHASE, PROGRESS_PHASE_RANGES } from '@utils/constants';

interface EncodingProgressInput {
  progressFrame: number;
  currentFrame: number;
  etaFrame: number | null;
  totalFrames: number;
  fps: number;
  memoryMB: number;
  elapsedMs: number;
}

export function buildEncodingProgress(input: EncodingProgressInput): ConversionProgress {
  const encodePercent =
    input.totalFrames > 0
      ? Math.round((input.progressFrame / input.totalFrames) * PROGRESS_PHASE_RANGES.ENCODE_RANGE)
      : 0;

  return {
    phase: 'encoding',
    progress: Math.min(PROGRESS_PHASE.ENCODE_MAX, PROGRESS_PHASE.DECODE_MAX + encodePercent),
    fps: input.fps,
    etaSeconds:
      input.fps > 0 && input.etaFrame !== null
        ? Math.round((input.totalFrames - input.etaFrame) / input.fps)
        : null,
    memoryMB: input.memoryMB,
    currentFrame: input.currentFrame,
    totalFrames: input.totalFrames,
    elapsedMs: input.elapsedMs,
  };
}
