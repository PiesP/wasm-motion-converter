/**
 * Frame requirement helpers
 *
 * These utilities centralize the (duplicated) math used to estimate how many frames
 * we expect to capture from a video based on duration and sampling FPS.
 */

export function computeExpectedFramesFromDuration(params: {
  durationSeconds: number;
  fps: number;
  maxFrames?: number;
}): number {
  const { durationSeconds, fps, maxFrames } = params;

  const expected = Math.max(1, Math.ceil(Math.max(0, durationSeconds) * Math.max(1, fps)));

  if (typeof maxFrames === 'number' && Number.isFinite(maxFrames)) {
    return Math.min(maxFrames, expected);
  }

  return expected;
}

export function computeRequiredFramesFromExpected(expectedFrames: number): number {
  return Math.max(1, expectedFrames - 1);
}
