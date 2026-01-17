/**
 * Frame requirement helpers
 *
 * These utilities centralize the (duplicated) math used to estimate how many frames
 * we expect to capture from a video based on duration and sampling FPS.
 */

type FrameEstimateParams = {
  durationSeconds: number;
  fps: number;
  maxFrames?: number;
};

const clampMin = (value: number, minValue: number): number => Math.max(minValue, value);

const resolveMaxFrames = (expected: number, maxFrames?: number): number => {
  if (typeof maxFrames !== 'number' || !Number.isFinite(maxFrames)) {
    return expected;
  }

  return Math.min(maxFrames, expected);
};

export function computeExpectedFramesFromDuration(params: FrameEstimateParams): number {
  const { durationSeconds, fps, maxFrames } = params;

  const normalizedDuration = clampMin(durationSeconds, 0);
  const normalizedFps = clampMin(fps, 1);
  const expected = clampMin(Math.ceil(normalizedDuration * normalizedFps), 1);

  return resolveMaxFrames(expected, maxFrames);
}

export function computeRequiredFramesFromExpected(expectedFrames: number): number {
  return clampMin(expectedFrames - 1, 1);
}
