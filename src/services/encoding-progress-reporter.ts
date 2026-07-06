// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { ProgressCallback } from '@t/conversion-types';

/**
 * Report encoding progress with the standard formula used by all encoders.
 *
 * @param onProgress - The parent progress callback (no-op if undefined)
 * @param currentCount - Number of frames encoded so far
 * @param totalCount - Total frames to encode
 */
export function reportEncodingProgress(
  onProgress: ProgressCallback | undefined,
  currentCount: number,
  totalCount: number
): void {
  if (!onProgress || currentCount === 0) return;
  const encodePct = totalCount > 0 ? Math.round((currentCount / totalCount) * 40) : 0;
  onProgress({
    phase: 'encoding',
    progress: 50 + Math.min(40, encodePct),
    fps: 0,
    etaSeconds: null,
    memoryMB: 0,
    currentFrame: currentCount,
    totalFrames: totalCount,
  });
}

/**
 * Creates an `onFrameDecoded` callback that reports encoding progress.
 *
 * Used where the callback is passed to a streaming decoder that invokes it
 * with `(frameNum, total)` on each decoded frame.
 *
 * @param onProgress - The parent progress callback (no-op if undefined)
 * @param getEncodedCount - Lazy accessor for current encoded frame count
 */
export function createEncodingProgressReporter(
  onProgress: ProgressCallback | undefined,
  getEncodedCount: () => number
): (frameNum: number, total: number) => void {
  return (_frameNum: number, total: number) => {
    reportEncodingProgress(onProgress, getEncodedCount(), total);
  };
}
