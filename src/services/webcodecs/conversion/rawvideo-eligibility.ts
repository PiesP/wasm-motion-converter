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

import type { VideoMetadata } from '@t/conversion-types';
import { isMemoryCritical } from '@utils/memory-monitor';

import { computeExpectedFramesFromDuration } from '@services/webcodecs/conversion/frame-requirements';

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

function getJsHeapSizeLimitMB(): number | null {
  const jsHeapSizeLimitBytes = (
    performance as Performance & { memory?: { jsHeapSizeLimit?: number } }
  ).memory?.jsHeapSizeLimit;
  return jsHeapSizeLimitBytes ? Math.floor(jsHeapSizeLimitBytes / MB) : null;
}

function getDeviceMemoryGB(): number | undefined {
  const deviceMemoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof deviceMemoryGB === 'number' && Number.isFinite(deviceMemoryGB)
    ? deviceMemoryGB
    : undefined;
}

function computeRawvideoMaxBytes(params: {
  jsHeapSizeLimitMB: number | null;
  deviceMemoryGB: number | undefined;
}): number {
  const { jsHeapSizeLimitMB, deviceMemoryGB } = params;

  // Conservative cap because the raw buffer lives in JS and is then copied into FFmpeg's WASM VFS
  // (peak memory can be ~2x the raw frame bytes).
  if (jsHeapSizeLimitMB) {
    // Allow up to 15% of the JS heap limit (clamped).
    const bytes = Math.floor(jsHeapSizeLimitMB * MB * 0.15);
    return Math.min(512 * MB, Math.max(192 * MB, bytes));
  }

  if (typeof deviceMemoryGB === 'number') {
    const deviceMemoryMB = Math.floor(deviceMemoryGB * 1024);
    if (deviceMemoryMB >= 8192) return 512 * MB;
    if (deviceMemoryMB >= 4096) return 384 * MB;
    if (deviceMemoryMB >= 2048) return 256 * MB;
    return 192 * MB;
  }

  // Baseline fallback: conservative, but not so low that rawvideo never triggers.
  return 320 * MB;
}

function applyIntentBudgetFactor(params: {
  rawvideoMaxBytes: number;
  intent: RawvideoEligibilityIntent;
}): number {
  const { rawvideoMaxBytes, intent } = params;

  // Auto-selection must be more conservative than an explicit user preference.
  // Fallback should be the most conservative to reduce OOM risk when the pipeline
  // is already in a degraded state.
  const factor = intent === 'preferred' ? 1.0 : intent === 'auto' ? 0.85 : 0.7;

  // Keep a small minimum so short clips can still benefit.
  const minBytes = 128 * MB;
  return Math.max(minBytes, Math.floor(rawvideoMaxBytes * factor));
}

export function computeRawvideoEligibility(params: {
  metadata?: VideoMetadata;
  targetFps: number;
  scale: number;
  format: 'gif' | 'webp';
  intent: RawvideoEligibilityIntent;
}): RawvideoEligibilityResult {
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

  const estimatedScaledWidth = params.metadata?.width
    ? Math.max(1, Math.round(params.metadata.width * params.scale))
    : null;
  const estimatedScaledHeight = params.metadata?.height
    ? Math.max(1, Math.round(params.metadata.height * params.scale))
    : null;

  const estimatedFramesForRaw = params.metadata?.duration
    ? computeExpectedFramesFromDuration({
        durationSeconds: params.metadata.duration,
        fps: params.targetFps,
      })
    : null;

  const estimatedRawBytes =
    estimatedScaledWidth && estimatedScaledHeight && estimatedFramesForRaw
      ? estimatedScaledWidth * estimatedScaledHeight * 4 * estimatedFramesForRaw
      : null;

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
