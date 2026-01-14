import type { Component } from 'solid-js';
import { createSignal, Show } from 'solid-js';

import {
  clearDevConversionOverrides,
  getDevConversionOverrides,
  setDevConversionOverrides,
  type DevForcedCaptureMode,
  type DevForcedGifEncoder,
  type DevForcedPath,
  type DevForcedStrategyCodec,
} from '@services/orchestration/dev-conversion-overrides';

interface DevRouteOverridesProps {
  disabled?: boolean;
}

const DevRouteOverrides: Component<DevRouteOverridesProps> = (props) => {
  const [forcedPath, setForcedPath] = createSignal<DevForcedPath>(
    getDevConversionOverrides().forcedPath
  );
  const [disableFallback, setDisableFallback] = createSignal<boolean>(
    getDevConversionOverrides().disableFallback
  );

  const [forcedGifEncoder, setForcedGifEncoder] = createSignal<DevForcedGifEncoder>(
    getDevConversionOverrides().forcedGifEncoder
  );
  const [forcedCaptureMode, setForcedCaptureMode] = createSignal<DevForcedCaptureMode>(
    getDevConversionOverrides().forcedCaptureMode
  );
  const [disableDemuxerInAuto, setDisableDemuxerInAuto] = createSignal<boolean>(
    getDevConversionOverrides().disableDemuxerInAuto
  );
  const [forcedStrategyCodec, setForcedStrategyCodec] = createSignal<DevForcedStrategyCodec>(
    getDevConversionOverrides().forcedStrategyCodec
  );

  const handleChange = (value: DevForcedPath): void => {
    setForcedPath(value);
    setDevConversionOverrides({ forcedPath: value });
  };

  const handleToggleDisableFallback = (value: boolean): void => {
    setDisableFallback(value);
    setDevConversionOverrides({ disableFallback: value });
  };

  const handleChangeGifEncoder = (value: DevForcedGifEncoder): void => {
    setForcedGifEncoder(value);
    setDevConversionOverrides({ forcedGifEncoder: value });
  };

  const handleChangeCaptureMode = (value: DevForcedCaptureMode): void => {
    setForcedCaptureMode(value);
    setDevConversionOverrides({ forcedCaptureMode: value });
  };

  const handleToggleDisableDemuxerInAuto = (value: boolean): void => {
    setDisableDemuxerInAuto(value);
    setDevConversionOverrides({ disableDemuxerInAuto: value });
  };

  const handleChangeStrategyCodec = (value: DevForcedStrategyCodec): void => {
    setForcedStrategyCodec(value);
    setDevConversionOverrides({ forcedStrategyCodec: value });
  };

  const handleReset = (): void => {
    clearDevConversionOverrides();
    setForcedPath('auto');
    setDisableFallback(false);
    setForcedGifEncoder('auto');
    setForcedCaptureMode('auto');
    setDisableDemuxerInAuto(false);
    setForcedStrategyCodec('auto');
  };

  const hasAnyForce = (): boolean => {
    return (
      forcedPath() !== 'auto' ||
      forcedGifEncoder() !== 'auto' ||
      forcedCaptureMode() !== 'auto' ||
      forcedStrategyCodec() !== 'auto' ||
      disableDemuxerInAuto() === true
    );
  };

  return (
    <Show when={import.meta.env.DEV}>
      <div class="mt-6 rounded-lg border border-dashed border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-900/10 p-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-sm font-semibold text-amber-900 dark:text-amber-200">
              Dev Overrides
            </div>
            <div class="mt-1 text-xs text-amber-800/80 dark:text-amber-200/80">
              Force a conversion path for testing. This panel is only visible in dev builds and is
              stored per-session.
            </div>
          </div>
          <button
            type="button"
            class="shrink-0 inline-flex items-center rounded-md border border-amber-300 dark:border-amber-700 px-3 py-1.5 text-xs font-medium text-amber-900 dark:text-amber-200 bg-white/70 dark:bg-gray-900/40 hover:bg-white dark:hover:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleReset}
            disabled={props.disabled}
          >
            Reset
          </button>
        </div>

        <div class="mt-4">
          <label
            for="dev-forced-path"
            class="block text-xs font-medium text-amber-900 dark:text-amber-200"
          >
            Forced path
          </label>
          <select
            id="dev-forced-path"
            class="mt-1 block w-full rounded-md border border-amber-300 dark:border-amber-700 bg-white dark:bg-gray-950 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-50 disabled:cursor-not-allowed"
            value={forcedPath()}
            onChange={(e) => handleChange(e.currentTarget.value as DevForcedPath)}
            disabled={props.disabled}
          >
            <option value="auto">Auto (strategy registry)</option>
            <option value="gpu">GPU (WebCodecs decode)</option>
            <option value="cpu">CPU (FFmpeg direct)</option>
          </select>

          <p class="mt-2 text-xs text-amber-800/80 dark:text-amber-200/80">
            Note: forcing GPU may still fall back to CPU on runtime failures.
          </p>
        </div>

        <div class="mt-4">
          <label
            for="dev-forced-gif-encoder"
            class="block text-xs font-medium text-amber-900 dark:text-amber-200"
          >
            Forced GIF encoder
          </label>
          <select
            id="dev-forced-gif-encoder"
            class="mt-1 block w-full rounded-md border border-amber-300 dark:border-amber-700 bg-white dark:bg-gray-950 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-50 disabled:cursor-not-allowed"
            value={forcedGifEncoder()}
            onChange={(e) => handleChangeGifEncoder(e.currentTarget.value as DevForcedGifEncoder)}
            disabled={props.disabled}
          >
            <option value="auto">Auto (default behavior)</option>
            <option value="modern-gif">modern-gif (GPU/WebCodecs path)</option>
            <option value="ffmpeg-direct">FFmpeg direct (CPU)</option>
            <option value="ffmpeg-palette">FFmpeg palette (preference; CPU/hybrid)</option>
            <option value="ffmpeg-palette-frames">FFmpeg palette from frames (hybrid, dev)</option>
          </select>

          <p class="mt-2 text-xs text-amber-800/80 dark:text-amber-200/80">
            Tip: modern-gif and palette-from-frames are exercised via the GPU/WebCodecs pipeline.
          </p>
        </div>

        <div class="mt-4">
          <label
            for="dev-forced-capture-mode"
            class="block text-xs font-medium text-amber-900 dark:text-amber-200"
          >
            Forced capture mode
          </label>
          <select
            id="dev-forced-capture-mode"
            class="mt-1 block w-full rounded-md border border-amber-300 dark:border-amber-700 bg-white dark:bg-gray-950 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-50 disabled:cursor-not-allowed"
            value={forcedCaptureMode()}
            onChange={(e) => handleChangeCaptureMode(e.currentTarget.value as DevForcedCaptureMode)}
            disabled={props.disabled}
          >
            <option value="auto">Auto (demuxer → playback modes)</option>
            <option value="demuxer">Demuxer</option>
            <option value="track">MediaStreamTrackProcessor</option>
            <option value="frame-callback">requestVideoFrameCallback</option>
            <option value="seek">Seek</option>
          </select>
        </div>

        <div class="mt-4">
          <label class="flex items-start gap-2 text-xs text-amber-900 dark:text-amber-200">
            <input
              type="checkbox"
              class="mt-0.5 h-4 w-4 rounded border-amber-300 dark:border-amber-700 text-amber-600 focus:ring-amber-500 disabled:opacity-50"
              checked={disableDemuxerInAuto()}
              onChange={(e) => handleToggleDisableDemuxerInAuto(e.currentTarget.checked)}
              disabled={props.disabled || forcedCaptureMode() !== 'auto'}
            />
            <span>
              Disable demuxer in auto mode
              <span class="block text-[11px] text-amber-800/80 dark:text-amber-200/80">
                Only applies when capture mode is Auto.
              </span>
            </span>
          </label>
        </div>

        <div class="mt-4">
          <label
            for="dev-forced-strategy-codec"
            class="block text-xs font-medium text-amber-900 dark:text-amber-200"
          >
            Forced strategy codec
          </label>
          <select
            id="dev-forced-strategy-codec"
            class="mt-1 block w-full rounded-md border border-amber-300 dark:border-amber-700 bg-white dark:bg-gray-950 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-50 disabled:cursor-not-allowed"
            value={forcedStrategyCodec()}
            onChange={(e) =>
              handleChangeStrategyCodec(e.currentTarget.value as DevForcedStrategyCodec)
            }
            disabled={props.disabled}
          >
            <option value="auto">Auto (actual codec)</option>
            <option value="h264">h264</option>
            <option value="hevc">hevc</option>
            <option value="av1">av1</option>
            <option value="vp8">vp8</option>
            <option value="vp9">vp9</option>
            <option value="unknown">unknown</option>
          </select>

          <p class="mt-2 text-xs text-amber-800/80 dark:text-amber-200/80">
            Planning-only: does not change how the file is actually decoded.
          </p>
        </div>

        <div class="mt-4">
          <label class="flex items-start gap-2 text-xs text-amber-900 dark:text-amber-200">
            <input
              type="checkbox"
              class="mt-0.5 h-4 w-4 rounded border-amber-300 dark:border-amber-700 text-amber-600 focus:ring-amber-500 disabled:opacity-50"
              checked={disableFallback()}
              onChange={(e) => handleToggleDisableFallback(e.currentTarget.checked)}
              disabled={props.disabled || !hasAnyForce()}
            />
            <span>
              Disable fallback (fail-fast) when a forced path cannot proceed.
              <span class="block text-[11px] text-amber-800/80 dark:text-amber-200/80">
                Tip: choose GPU/CPU first. When enabled, failures will surface as errors instead of
                silently switching paths.
              </span>
            </span>
          </label>
        </div>
      </div>
    </Show>
  );
};

export default DevRouteOverrides;
