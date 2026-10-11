// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Half-open, source-timestamp interval after trimming. Values are integer microseconds. */
export interface PresentationInterval {
  startUs: number;
  endUs: number;
}

/**
 * Select the first source frame at or after each requested presentation boundary.
 * Boundaries stay anchored to the first visible frame, including across VFR gaps.
 * An integer ratio also enforces its source-frame floor when timestamps are dense.
 */
export function createPresentationSampler(sourceFps: number, decimation: number) {
  const ratio = Number.isFinite(decimation) && decimation > 1 ? decimation : 1;
  const fps = Number.isFinite(sourceFps) && sourceFps > 0 ? sourceFps : 1;
  const periodUs = (ratio * 1_000_000) / fps;
  const minimumFrameGap = Math.max(1, Math.floor(ratio));
  let anchorUs: number | null = null;
  let nextBoundaryUs = 0;
  let nextBoundaryIndex = 0;
  let lastSelectedFrame = Number.NEGATIVE_INFINITY;

  return (startUs: number, frameNumber: number): boolean => {
    if (ratio === 1) return true;
    if (anchorUs === null) {
      anchorUs = startUs;
      nextBoundaryIndex = 1;
      nextBoundaryUs = startUs + Math.round(periodUs);
      lastSelectedFrame = frameNumber;
      return true;
    }
    if (frameNumber - lastSelectedFrame < minimumFrameGap || startUs < nextBoundaryUs) {
      return false;
    }
    lastSelectedFrame = frameNumber;
    nextBoundaryIndex = Math.max(
      nextBoundaryIndex + 1,
      Math.floor((startUs - anchorUs) / periodUs) + 1
    );
    nextBoundaryUs = anchorUs + Math.round(nextBoundaryIndex * periodUs);
    // A rounded microsecond PTS can equal the rounded boundary even when its
    // floating ratio is a fraction below the exact boundary.
    while (nextBoundaryUs <= startUs) {
      nextBoundaryIndex++;
      nextBoundaryUs = anchorUs + Math.round(nextBoundaryIndex * periodUs);
    }
    return true;
  };
}
