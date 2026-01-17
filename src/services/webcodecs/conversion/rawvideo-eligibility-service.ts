/**
 * Rawvideo Eligibility
 *
 * Shared helper for deciding whether we can stage decoded RGBA frames as a single
 * rawvideo file (e.g., frames.rgba) for FFmpeg.
 *
 * Motivation:
 * - Avoid expensive per-frame PNG/JPEG encoding + VFS writes
 * - Keep memory safe: raw bytes are held in JS and copied into FFmpeg's WASM VFS
 */

import { computeExpectedFramesFromDuration } from '@services/webcodecs/conversion/frame-requirements-service';
import type { VideoMetadata } from '@t/conversion-types';
import { isMemoryCritical } from '@utils/memory-monitor';

export type RawvideoEligibilityIntent = 'preferred' | 'fallback' | 'auto';

export interface RawvideoEligibilityResult {
  enabled: boolean;
  isMemoryCritical: boolean;
  estimatedScaledWidth: number | null;
  estimatedScaledHeight: number | null;
  estimatedFramesForRaw: number | null;
  estimatedRawBytes: number | null;
  rawvideoMaxBytes: number;
  jsHeapSizeLimitMB: number | null;
  deviceMemoryGB: number | undefined;
}

const MB = 1024 * 1024;
const MIN_BUDGET_BYTES = 128 * MB;
const BASELINE_MAX_BYTES = 320 * MB;
const JS_HEAP_BUDGET_FACTOR = 0.15;
const MAX_HEAP_BYTES = 512 * MB;
const MIN_HEAP_BYTES = 192 * MB;

const DEVICE_BUDGETS = [
  { thresholdMB: 8192, budget: 512 * MB },
  { thresholdMB: 4096, budget: 384 * MB },
  { thresholdMB: 2048, budget: 256 * MB },
] as const;

type RawvideoBudgetContext = {
  jsHeapSizeLimitMB: number | null;
  deviceMemoryGB: number | undefined;
};

type IntentBudgetParams = {
  rawvideoMaxBytes: number;
  intent: RawvideoEligibilityIntent;
};

const getJsHeapSizeLimitMB = (): number | null => {
  const jsHeapSizeLimitBytes = (
    performance as Performance & { memory?: { jsHeapSizeLimit?: number } }
  ).memory?.jsHeapSizeLimit;
  return jsHeapSizeLimitBytes ? Math.floor(jsHeapSizeLimitBytes / MB) : null;
};

const getDeviceMemoryGB = (): number | undefined => {
  const deviceMemoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof deviceMemoryGB === 'number' && Number.isFinite(deviceMemoryGB)
    ? deviceMemoryGB
    : undefined;
};

const resolveDeviceBudget = (deviceMemoryGB: number): number => {
  const deviceMemoryMB = Math.floor(deviceMemoryGB * 1024);

  for (const entry of DEVICE_BUDGETS) {
    if (deviceMemoryMB >= entry.thresholdMB) {
      return entry.budget;
    }
  }

  return MIN_HEAP_BYTES;
};

const computeRawvideoMaxBytes = (params: RawvideoBudgetContext): number => {
  const { jsHeapSizeLimitMB, deviceMemoryGB } = params;

  // Conservative cap because the raw buffer lives in JS and is then copied into FFmpeg's WASM VFS
  // (peak memory can be ~2x the raw frame bytes).
  if (jsHeapSizeLimitMB) {
    const bytes = Math.floor(jsHeapSizeLimitMB * MB * JS_HEAP_BUDGET_FACTOR);
    return Math.min(MAX_HEAP_BYTES, Math.max(MIN_HEAP_BYTES, bytes));
  }

  if (typeof deviceMemoryGB === 'number') {
    return resolveDeviceBudget(deviceMemoryGB);
  }

  // Baseline fallback: conservative, but not so low that rawvideo never triggers.
  return BASELINE_MAX_BYTES;
};

const applyIntentBudgetFactor = (params: IntentBudgetParams): number => {
  const { rawvideoMaxBytes, intent } = params;

  // Auto-selection must be more conservative than an explicit user preference.
  // Fallback should be the most conservative to reduce OOM risk when the pipeline
  // is already in a degraded state.
  const factor = intent === 'preferred' ? 1.0 : intent === 'auto' ? 0.85 : 0.7;

  return Math.max(MIN_BUDGET_BYTES, Math.floor(rawvideoMaxBytes * factor));
};

type RawvideoEligibilityParams = {
  metadata?: VideoMetadata;
  targetFps: number;
  scale: number;
  format: 'gif' | 'webp';
  intent: RawvideoEligibilityIntent;
};

const scaleDimension = (value: number | undefined, scale: number): number | null =>
  typeof value === 'number' ? Math.max(1, Math.round(value * scale)) : null;

const estimateRawBytes = (
  width: number | null,
  height: number | null,
  frames: number | null
): number | null => (width && height && frames ? width * height * 4 * frames : null);

export function computeRawvideoEligibility(
  params: RawvideoEligibilityParams
): RawvideoEligibilityResult {
  const jsHeapSizeLimitMB = getJsHeapSizeLimitMB();
  const deviceMemoryGB = getDeviceMemoryGB();

  const rawvideoMaxBytes = applyIntentBudgetFactor({
    rawvideoMaxBytes: computeRawvideoMaxBytes({
      jsHeapSizeLimitMB,
      deviceMemoryGB,
    }),
    intent: params.intent,
  });

  const critical = isMemoryCritical();

  const estimatedScaledWidth = scaleDimension(params.metadata?.width, params.scale);
  const estimatedScaledHeight = scaleDimension(params.metadata?.height, params.scale);

  const estimatedFramesForRaw = params.metadata?.duration
    ? computeExpectedFramesFromDuration({
        durationSeconds: params.metadata.duration,
        fps: params.targetFps,
      })
    : null;

  const estimatedRawBytes = estimateRawBytes(
    estimatedScaledWidth,
    estimatedScaledHeight,
    estimatedFramesForRaw
  );

  const enabled =
    params.format === 'gif' &&
    !critical &&
    estimatedRawBytes !== null &&
    estimatedRawBytes > 0 &&
    estimatedRawBytes <= rawvideoMaxBytes;

  return {
    enabled,
    isMemoryCritical: critical,
    estimatedScaledWidth,
    estimatedScaledHeight,
    estimatedFramesForRaw,
    estimatedRawBytes,
    rawvideoMaxBytes,
    jsHeapSizeLimitMB,
    deviceMemoryGB,
  };
}
