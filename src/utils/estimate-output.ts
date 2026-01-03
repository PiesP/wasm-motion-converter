import type { ConversionSettings } from '../types/conversion-types';
import { formatBytes } from './format-bytes';
import { formatDuration } from './format-duration';

const QUALITY_FACTORS: Record<string, { size: number; time: number }> = {
  low: { size: 0.35, time: 0.9 },
  medium: { size: 0.55, time: 1.0 },
  high: { size: 0.8, time: 1.25 },
};

function clampRange(min: number, max: number, floor: number, ceil: number): [number, number] {
  return [Math.max(min, floor), Math.min(max, ceil)];
}

export function estimateOutputSizeRange(
  inputSizeBytes: number,
  settings: ConversionSettings,
  resolutionScaleFactor: number
): { minBytes: number; maxBytes: number; label: string } {
  const quality = QUALITY_FACTORS[settings.quality];
  const base = inputSizeBytes * quality.size * resolutionScaleFactor;
  // Provide a range to set expectation; widen a bit for GIF variability.
  const minBytes = base * 0.6;
  const maxBytes = base * 1.4;
  const [minClamped, maxClamped] = clampRange(minBytes, maxBytes, 500_000, inputSizeBytes * 1.2);
  return {
    minBytes: minClamped,
    maxBytes: maxClamped,
    label: `${formatBytes(minClamped)} – ${formatBytes(maxClamped)}`,
  };
}

export function estimateEtaRange(
  durationSeconds: number,
  megapixels: number,
  settings: ConversionSettings
): { minSeconds: number; maxSeconds: number; label: string } {
  const quality = QUALITY_FACTORS[settings.quality];
  const complexity = durationSeconds * megapixels * quality.time;
  // heuristic: baseline 720p 30s medium ≈ 12s; scale linearly and widen.
  const baseline = 12;
  const eta = baseline * (complexity / (1.0 * 30));
  const minSeconds = Math.max(5, eta * 0.7);
  const maxSeconds = Math.min(300, eta * 1.6);
  return {
    minSeconds,
    maxSeconds,
    label: `${formatDuration(minSeconds)} – ${formatDuration(maxSeconds)}`,
  };
}
