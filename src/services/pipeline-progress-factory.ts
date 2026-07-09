// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { ConversionProgress, ProgressCallback, ProgressPhase } from '@t/conversion-types';

/**
 * Factory for the pipeline's encode-progress callback.
 *
 * The inline `(p) => { ... }` callback passed to all encoder functions is
 * identical across encoder branches. Extracted here to eliminate duplication.
 *
 * The factory encapsulates the `let encodedFrames = 0` state internally and
 * returns a callback closure that builds a throttled progress update from the
 * encoder's current-frame signal. After the encoder completes, call
 * `result.getEncodedFrames()` to obtain the final frame count.
 */
export function createPipelineProgressCallback(
  throttled: { callback: (progress: ConversionProgress) => void },
  buildProgressData: (
    phase: ProgressPhase,
    progress: number,
    fps: number,
    etaSeconds: number | null,
    memoryMB: number,
    currentFrame: number,
    totalFrames: number
  ) => ConversionProgress,
  fpsTracker: { current: number },
  estimatedOutputFrames: number,
  decodeMax: number,
  encodeRange: number,
  encodeMax: number,
  sampleMemory: () => number
): { callback: ProgressCallback; getEncodedFrames: () => number } {
  let encodedFrames = 0;

  const callback: ProgressCallback = (p) => {
    encodedFrames = p.currentFrame ?? encodedFrames;

    const encodePct =
      estimatedOutputFrames > 0
        ? Math.round((encodedFrames / estimatedOutputFrames) * encodeRange)
        : 0;

    throttled.callback(
      buildProgressData(
        'encoding',
        Math.min(encodeMax, decodeMax + encodePct),
        fpsTracker.current,
        fpsTracker.current > 0 && p.currentFrame != null
          ? Math.round((estimatedOutputFrames - p.currentFrame) / fpsTracker.current)
          : null,
        sampleMemory(),
        p.currentFrame ?? 0,
        estimatedOutputFrames
      )
    );
  };

  return { callback, getEncodedFrames: () => encodedFrames };
}
