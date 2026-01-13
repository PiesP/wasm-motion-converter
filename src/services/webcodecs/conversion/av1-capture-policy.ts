import type { ConversionOptions } from '@t/conversion-types';

export const AV1_FRAME_CALLBACK_FAILURE_KEY =
  'dropconvert:captureReliability:av1:frame-callback:failures';

type Quality = ConversionOptions['quality'];

export function supportsRequestVideoFrameCallback(): boolean {
  // Feature detect without requiring the element to be attached.
  return (
    typeof document !== 'undefined' &&
    typeof HTMLVideoElement !== 'undefined' &&
    'requestVideoFrameCallback' in document.createElement('video')
  );
}

export function readSessionStorageNumber(key: string): number {
  try {
    if (typeof sessionStorage === 'undefined') return 0;

    const raw = sessionStorage.getItem(key);
    if (!raw) return 0;

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

export function writeSessionStorageNumber(key: string, value: number): void {
  try {
    if (typeof sessionStorage === 'undefined') return;

    sessionStorage.setItem(key, String(value));
  } catch {
    // Ignore storage failures (privacy modes / disabled storage).
  }
}

export function getAv1CaptureFpsCap(params: {
  durationSeconds: number | undefined;
  quality: Quality;
}): number {
  const { durationSeconds, quality } = params;

  // AV1 frame extraction is often dominated by canvas encoding (PNG) rather than FFmpeg.
  // Capping extraction FPS significantly reduces total time while preserving overall
  // animation duration via duration-aligned timestamps.
  const isShort = !durationSeconds || durationSeconds < 4;
  const isMedium =
    typeof durationSeconds === 'number' &&
    Number.isFinite(durationSeconds) &&
    durationSeconds >= 4 &&
    durationSeconds < 30;

  if (isShort) {
    // Short clips: keep motion smooth.
    return 15;
  }

  if (isMedium) {
    // Medium clips: balance speed and smoothness.
    if (quality === 'high') {
      return 12;
    }
    if (quality === 'medium') {
      return 10;
    }
    return 8;
  }

  // Long clips: prioritize speed.
  if (quality === 'high') {
    return 10;
  }
  if (quality === 'medium') {
    return 8;
  }
  return 6;
}

export function getAv1SeekFpsCap(params: {
  durationSeconds: number | undefined;
  quality: Quality;
}): number {
  const { durationSeconds, quality } = params;

  // Adaptive FPS capping for mixed workload
  // Short clips: prioritize quality, medium/long: prioritize speed
  const isShort = !durationSeconds || durationSeconds < 4;
  const isMedium =
    typeof durationSeconds === 'number' &&
    Number.isFinite(durationSeconds) &&
    durationSeconds >= 4 &&
    durationSeconds < 30;

  if (isShort) {
    return 12; // Short clips: maintain quality
  }
  if (isMedium) {
    return quality === 'high' ? 10 : 8; // Medium: balance speed/quality
  }
  // Long videos (>=30s): aggressive FPS capping for speed
  return quality === 'high' ? 8 : 6;
}
