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

type DurationBucket = 'short' | 'medium' | 'long';

type DurationParams = {
  durationSeconds: number | undefined;
  quality: Quality;
};

const SHORT_DURATION_SECONDS = 4;
const LONG_DURATION_SECONDS = 30;

const hasSessionStorage = (): boolean => typeof sessionStorage !== 'undefined';

const getDurationBucket = (durationSeconds: number | undefined): DurationBucket => {
  if (!durationSeconds || !Number.isFinite(durationSeconds)) {
    return 'short';
  }
  if (durationSeconds < SHORT_DURATION_SECONDS) {
    return 'short';
  }
  if (durationSeconds < LONG_DURATION_SECONDS) {
    return 'medium';
  }
  return 'long';
};

export function readSessionStorageNumber(key: string): number {
  try {
    if (!hasSessionStorage()) return 0;

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
    if (!hasSessionStorage()) return;

    sessionStorage.setItem(key, String(value));
  } catch {
    // Ignore storage failures (privacy modes / disabled storage).
  }
}

export function getAv1CaptureFpsCap(params: DurationParams): number {
  const { durationSeconds, quality } = params;
  const bucket = getDurationBucket(durationSeconds);

  // AV1 frame extraction is often dominated by canvas encoding (PNG) rather than FFmpeg.
  // Capping extraction FPS significantly reduces total time while preserving overall
  // animation duration via duration-aligned timestamps.
  if (bucket === 'short') {
    return 15;
  }

  if (bucket === 'medium') {
    if (quality === 'high') {
      return 12;
    }
    if (quality === 'medium') {
      return 10;
    }
    return 8;
  }

  if (quality === 'high') {
    return 10;
  }
  if (quality === 'medium') {
    return 8;
  }
  return 6;
}

export function getAv1SeekFpsCap(params: DurationParams): number {
  const { durationSeconds, quality } = params;
  const bucket = getDurationBucket(durationSeconds);

  // Adaptive FPS capping for mixed workload
  // Short clips: prioritize quality, medium/long: prioritize speed
  if (bucket === 'short') {
    return 12;
  }
  if (bucket === 'medium') {
    return quality === 'high' ? 10 : 8;
  }
  return quality === 'high' ? 8 : 6;
}
