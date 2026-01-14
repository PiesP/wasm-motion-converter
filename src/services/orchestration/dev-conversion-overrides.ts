import type { ConversionPath } from './types';

/**
 * Dev Conversion Overrides
 *
 * A tiny dev-only persistence layer that allows forcing a conversion path
 * (e.g., CPU/FFmpeg vs GPU/WebCodecs) for testing.
 *
 * Notes:
 * - This is intentionally disabled in production builds.
 * - Stored in sessionStorage to avoid long-lived sticky overrides.
 */

export type DevForcedPath = 'auto' | Exclude<ConversionPath, 'webav'>;

export type DevForcedGifEncoder =
  | 'auto'
  | 'modern-gif'
  | 'ffmpeg-direct'
  | 'ffmpeg-palette'
  | 'ffmpeg-palette-frames';

export type DevForcedCaptureMode = 'auto' | 'demuxer' | 'track' | 'frame-callback' | 'seek';

export type DevForcedStrategyCodec = 'auto' | 'h264' | 'hevc' | 'av1' | 'vp8' | 'vp9' | 'unknown';

export interface DevConversionOverrides {
  forcedPath: DevForcedPath;
  /** When true, forced-path runs will fail instead of falling back. */
  disableFallback: boolean;

  /** Dev-only: force which GIF encoder backend should be exercised. */
  forcedGifEncoder: DevForcedGifEncoder;

  /** Dev-only: force a WebCodecs capture mode sequence (best-effort). */
  forcedCaptureMode: DevForcedCaptureMode;

  /** Dev-only: disable demuxer usage when captureMode is auto. */
  disableDemuxerInAuto: boolean;

  /** Dev-only: override codec used for strategy planning (does not change actual decoding). */
  forcedStrategyCodec: DevForcedStrategyCodec;
}

interface DevConversionOverridesStorage {
  version: 2;
  updatedAt: number;
  overrides: DevConversionOverrides;
}

const STORAGE_KEY = 'dev_conversion_overrides_v2' as const;

const DEFAULT_OVERRIDES: DevConversionOverrides = {
  forcedPath: 'auto',
  disableFallback: false,
  forcedGifEncoder: 'auto',
  forcedCaptureMode: 'auto',
  disableDemuxerInAuto: false,
  forcedStrategyCodec: 'auto',
};

function sanitizeOverrides(
  input: Partial<DevConversionOverrides> | undefined
): DevConversionOverrides {
  const forcedPath = input?.forcedPath;
  const safeForcedPath: DevForcedPath =
    forcedPath === 'auto' || forcedPath === 'cpu' || forcedPath === 'gpu'
      ? forcedPath
      : DEFAULT_OVERRIDES.forcedPath;

  const forcedGifEncoder = input?.forcedGifEncoder;
  const safeForcedGifEncoder: DevForcedGifEncoder =
    forcedGifEncoder === 'auto' ||
    forcedGifEncoder === 'modern-gif' ||
    forcedGifEncoder === 'ffmpeg-direct' ||
    forcedGifEncoder === 'ffmpeg-palette' ||
    forcedGifEncoder === 'ffmpeg-palette-frames'
      ? forcedGifEncoder
      : DEFAULT_OVERRIDES.forcedGifEncoder;

  const forcedCaptureMode = input?.forcedCaptureMode;
  const safeForcedCaptureMode: DevForcedCaptureMode =
    forcedCaptureMode === 'auto' ||
    forcedCaptureMode === 'demuxer' ||
    forcedCaptureMode === 'track' ||
    forcedCaptureMode === 'frame-callback' ||
    forcedCaptureMode === 'seek'
      ? forcedCaptureMode
      : DEFAULT_OVERRIDES.forcedCaptureMode;

  const forcedStrategyCodec = input?.forcedStrategyCodec;
  const safeForcedStrategyCodec: DevForcedStrategyCodec =
    forcedStrategyCodec === 'auto' ||
    forcedStrategyCodec === 'h264' ||
    forcedStrategyCodec === 'hevc' ||
    forcedStrategyCodec === 'av1' ||
    forcedStrategyCodec === 'vp8' ||
    forcedStrategyCodec === 'vp9' ||
    forcedStrategyCodec === 'unknown'
      ? forcedStrategyCodec
      : DEFAULT_OVERRIDES.forcedStrategyCodec;

  return {
    forcedPath: safeForcedPath,
    disableFallback: input?.disableFallback === true,
    forcedGifEncoder: safeForcedGifEncoder,
    forcedCaptureMode: safeForcedCaptureMode,
    disableDemuxerInAuto: input?.disableDemuxerInAuto === true,
    forcedStrategyCodec: safeForcedStrategyCodec,
  };
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined';
}

export function getDevConversionOverrides(): DevConversionOverrides {
  if (!import.meta.env.DEV) return DEFAULT_OVERRIDES;
  if (!canUseStorage()) return DEFAULT_OVERRIDES;

  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_OVERRIDES;

    const parsed = JSON.parse(raw) as DevConversionOverridesStorage;
    if (!parsed || parsed.version !== 2) return DEFAULT_OVERRIDES;
    return sanitizeOverrides(parsed.overrides);
  } catch {
    return DEFAULT_OVERRIDES;
  }
}

export function setDevConversionOverrides(
  patch: Partial<DevConversionOverrides>
): DevConversionOverrides {
  if (!import.meta.env.DEV) return DEFAULT_OVERRIDES;

  const current = getDevConversionOverrides();
  const next = sanitizeOverrides({ ...current, ...patch });

  if (!canUseStorage()) return next;

  try {
    const storage: DevConversionOverridesStorage = {
      version: 2,
      updatedAt: Date.now(),
      overrides: next,
    };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
  } catch {
    // ignore
  }

  return next;
}

export function clearDevConversionOverrides(): void {
  if (!import.meta.env.DEV) return;
  if (!canUseStorage()) return;

  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
