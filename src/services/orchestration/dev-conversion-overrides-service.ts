import type { ConversionPath } from './types-service';

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

const DEV_STORAGE_VERSION = 2 as const;
const STORAGE_KEY = 'dev_conversion_overrides_v2' as const;
const FORCED_PATH_OPTIONS = ['auto', 'cpu', 'gpu'] as const;
const FORCED_GIF_ENCODERS = [
  'auto',
  'modern-gif',
  'ffmpeg-direct',
  'ffmpeg-palette',
  'ffmpeg-palette-frames',
] as const;
const FORCED_CAPTURE_MODES = ['auto', 'demuxer', 'track', 'frame-callback', 'seek'] as const;
const FORCED_STRATEGY_CODECS = ['auto', 'h264', 'hevc', 'av1', 'vp8', 'vp9', 'unknown'] as const;

const DEFAULT_OVERRIDES: DevConversionOverrides = {
  forcedPath: 'auto',
  disableFallback: false,
  forcedGifEncoder: 'auto',
  forcedCaptureMode: 'auto',
  disableDemuxerInAuto: false,
  forcedStrategyCodec: 'auto',
};

function resolveOverride<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value !== 'string') return fallback;
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function resolveBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function sanitizeOverrides(
  input: Partial<DevConversionOverrides> | undefined
): DevConversionOverrides {
  return {
    forcedPath: resolveOverride(
      input?.forcedPath,
      FORCED_PATH_OPTIONS,
      DEFAULT_OVERRIDES.forcedPath
    ),
    disableFallback: resolveBoolean(input?.disableFallback, DEFAULT_OVERRIDES.disableFallback),
    forcedGifEncoder: resolveOverride(
      input?.forcedGifEncoder,
      FORCED_GIF_ENCODERS,
      DEFAULT_OVERRIDES.forcedGifEncoder
    ),
    forcedCaptureMode: resolveOverride(
      input?.forcedCaptureMode,
      FORCED_CAPTURE_MODES,
      DEFAULT_OVERRIDES.forcedCaptureMode
    ),
    disableDemuxerInAuto: resolveBoolean(
      input?.disableDemuxerInAuto,
      DEFAULT_OVERRIDES.disableDemuxerInAuto
    ),
    forcedStrategyCodec: resolveOverride(
      input?.forcedStrategyCodec,
      FORCED_STRATEGY_CODECS,
      DEFAULT_OVERRIDES.forcedStrategyCodec
    ),
  };
}

function isDevMode(): boolean {
  return import.meta.env.DEV;
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined';
}

function readOverridesFromStorage(): DevConversionOverrides | null {
  if (!canUseStorage()) return null;

  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as DevConversionOverridesStorage;
    if (!parsed || parsed.version !== DEV_STORAGE_VERSION) return null;

    return sanitizeOverrides(parsed.overrides);
  } catch {
    return null;
  }
}

function writeOverridesToStorage(overrides: DevConversionOverrides): void {
  if (!canUseStorage()) return;

  try {
    const storage: DevConversionOverridesStorage = {
      version: DEV_STORAGE_VERSION,
      updatedAt: Date.now(),
      overrides,
    };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
  } catch {
    // ignore
  }
}

export function getDevConversionOverrides(): DevConversionOverrides {
  if (!isDevMode()) return DEFAULT_OVERRIDES;
  return readOverridesFromStorage() ?? DEFAULT_OVERRIDES;
}

export function setDevConversionOverrides(
  patch: Partial<DevConversionOverrides>
): DevConversionOverrides {
  if (!isDevMode()) return DEFAULT_OVERRIDES;

  const current = getDevConversionOverrides();
  const next = sanitizeOverrides({ ...current, ...patch });

  writeOverridesToStorage(next);
  return next;
}

export function clearDevConversionOverrides(): void {
  if (!isDevMode()) return;
  if (!canUseStorage()) return;

  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
