import type { Component } from 'solid-js';
import { createMemo, createSignal, Show } from 'solid-js';

import { runConversionMatrixTest } from '@services/dev/conversion-matrix-test';
import {
  conversionSettings,
  conversionStatusMessage,
  inputFile,
  videoMetadata,
} from '@stores/conversion-store';
import { logger } from '@utils/logger';

interface DevConversionMatrixTestProps {
  disabled?: boolean;
}

const DevConversionMatrixTest: Component<DevConversionMatrixTestProps> = (props) => {
  const [isRunning, setIsRunning] = createSignal(false);
  const [repeats, setRepeats] = createSignal<number>(3);
  const [includeGif, setIncludeGif] = createSignal(true);
  const [includeWebp, setIncludeWebp] = createSignal(true);
  const [includeStrategyCodecScenarios, setIncludeStrategyCodecScenarios] = createSignal(false);

  const canRun = createMemo(() => {
    return !!inputFile() && !props.disabled && !isRunning();
  });

  const formatSummary = createMemo(() => {
    const formats: Array<'gif' | 'webp'> = [];
    if (includeGif()) formats.push('gif');
    if (includeWebp()) formats.push('webp');
    return formats;
  });

  const run = async (): Promise<void> => {
    const file = inputFile();
    if (!file) {
      return;
    }

    const formats = formatSummary();
    if (formats.length === 0) {
      return;
    }

    setIsRunning(true);
    try {
      const settings = conversionSettings();
      const summary = await runConversionMatrixTest({
        file,
        metadata: videoMetadata(),
        formats,
        repeats: repeats(),
        quality: settings.quality,
        scale: settings.scale,
        includeStrategyCodecScenarios: includeStrategyCodecScenarios(),
      });

      logger.info('conversion', 'Matrix test summary (UI)', summary);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <Show when={import.meta.env.DEV}>
      <div class="mt-4 rounded-lg border border-dashed border-indigo-300 dark:border-indigo-700 bg-indigo-50/60 dark:bg-indigo-900/10 p-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-sm font-semibold text-indigo-900 dark:text-indigo-200">
              Dev Conversion Matrix
            </div>
            <div class="mt-1 text-xs text-indigo-800/80 dark:text-indigo-200/80">
              Runs a conversion matrix (multiple path combinations) against the currently selected
              video and writes results to logs. Output is not added to the UI results list.
            </div>
          </div>

          <button
            type="button"
            class="shrink-0 inline-flex items-center rounded-md border border-indigo-300 dark:border-indigo-700 px-3 py-1.5 text-xs font-medium text-indigo-900 dark:text-indigo-200 bg-white/70 dark:bg-gray-900/40 hover:bg-white dark:hover:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => {
              void run();
            }}
            disabled={!canRun()}
          >
            {isRunning() ? 'Running…' : 'Run matrix (x3)'}
          </button>
        </div>

        <div class="mt-4 grid grid-cols-1 gap-3">
          <div class="flex flex-wrap items-center gap-3">
            <label class="text-xs text-indigo-900 dark:text-indigo-200">
              Repeats
              <input
                type="number"
                min="1"
                max="10"
                class="ml-2 w-20 rounded-md border border-indigo-300 dark:border-indigo-700 bg-white dark:bg-gray-950 px-2 py-1 text-xs text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
                value={repeats()}
                onInput={(e) =>
                  setRepeats(Math.max(1, Math.min(10, Number(e.currentTarget.value) || 1)))
                }
                disabled={props.disabled || isRunning()}
              />
            </label>

            <label class="inline-flex items-center gap-2 text-xs text-indigo-900 dark:text-indigo-200">
              <input
                type="checkbox"
                class="h-4 w-4 rounded border-indigo-300 dark:border-indigo-700 text-indigo-600 focus:ring-indigo-500 disabled:opacity-50"
                checked={includeGif()}
                onChange={(e) => setIncludeGif(e.currentTarget.checked)}
                disabled={props.disabled || isRunning()}
              />
              GIF
            </label>

            <label class="inline-flex items-center gap-2 text-xs text-indigo-900 dark:text-indigo-200">
              <input
                type="checkbox"
                class="h-4 w-4 rounded border-indigo-300 dark:border-indigo-700 text-indigo-600 focus:ring-indigo-500 disabled:opacity-50"
                checked={includeWebp()}
                onChange={(e) => setIncludeWebp(e.currentTarget.checked)}
                disabled={props.disabled || isRunning()}
              />
              WebP
            </label>

            <label class="inline-flex items-center gap-2 text-xs text-indigo-900 dark:text-indigo-200">
              <input
                type="checkbox"
                class="h-4 w-4 rounded border-indigo-300 dark:border-indigo-700 text-indigo-600 focus:ring-indigo-500 disabled:opacity-50"
                checked={includeStrategyCodecScenarios()}
                onChange={(e) => setIncludeStrategyCodecScenarios(e.currentTarget.checked)}
                disabled={props.disabled || isRunning()}
              />
              Include strategy codec simulations
            </label>
          </div>

          <Show when={!!inputFile()}>
            <div class="text-[11px] text-indigo-800/80 dark:text-indigo-200/80">
              Using settings: format={conversionSettings().format}, quality=
              {conversionSettings().quality}, scale={conversionSettings().scale}
            </div>
          </Show>

          <Show when={!inputFile()}>
            <div class="text-[11px] text-indigo-800/80 dark:text-indigo-200/80">
              Select a video first to enable matrix testing.
            </div>
          </Show>

          <Show when={isRunning()}>
            <div class="text-[11px] text-indigo-800/80 dark:text-indigo-200/80">
              Running… check the console log. Current UI status message (if any):{' '}
              {conversionStatusMessage()}
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
};

export default DevConversionMatrixTest;
