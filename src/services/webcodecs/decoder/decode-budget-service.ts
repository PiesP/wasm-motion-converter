import type { WebCodecsCaptureMode } from '@services/webcodecs/decoder/types-service';

export function computeMaxTotalDecodeMs(params: {
  captureMode: WebCodecsCaptureMode;
  totalFrames: number;
  baseMaxTotalDecodeMs: number;
}): number {
  const { captureMode, totalFrames, baseMaxTotalDecodeMs } = params;

  if (captureMode !== 'seek') {
    return baseMaxTotalDecodeMs;
  }

  // Conservative per-frame budget for seek-based capture.
  // Example: 115 frames -> ~230s budget (2s/frame), capped to 240s.
  const perFrameBudgetMs = 2000;
  const estimatedMs = totalFrames * perFrameBudgetMs;
  const upperBoundMs = 240_000;

  return Math.min(upperBoundMs, Math.max(baseMaxTotalDecodeMs, estimatedMs));
}
