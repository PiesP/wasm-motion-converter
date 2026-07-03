// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import ConfirmationModal from '@components/ConfirmationModal';
import ExportLogsButton from '@components/ExportLogsButton';
import FileDropzone from '@components/FileDropzone';
import LanguageSelector from '@components/LanguageSelector';
import LicenseAttribution from '@components/LicenseAttribution';
import ResultSection from '@components/ResultSection';
import SettingsPanel from '@components/SettingsPanel';
import StatusAlerts from '@components/StatusAlerts';
import VideoMetadataDisplay from '@components/VideoMetadataDisplay';
import { useConversionHandlers } from '@hooks/use-conversion-handlers';
import { useLocale } from '@hooks/use-locale';
import { useNetworkState } from '@hooks/use-network-state';
import { dismissConfirmation } from '@stores/confirmation-store';
import {
  conversionSettings,
  saveConversionSettings,
  setConversionSettings,
} from '@stores/conversion-settings-store';
import {
  appState,
  conversionProgress,
  conversionResults,
  conversionStatusMessage,
  environmentSupported,
  errorContext,
  errorMessage,
  inputFile,
  outputFrames,
  setEnvironmentSupported,
  videoMetadata,
  videoPreviewUrl,
} from '@stores/conversion-store';
import type { ProgressPhase } from '@t/conversion-types';
import { debounce } from '@utils/debounce';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { isMemoryCritical } from '@utils/memory-monitor';
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  ErrorBoundary,
  lazy,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from 'solid-js';

import './index.css';

// Lazy import for test helpers (dev only)
let attachTestHelpers: (() => void) | null = null;
if (import.meta.env.DEV) {
  import('./test-helpers')
    .then((mod) => {
      attachTestHelpers = mod.attachTestHelpers;
    })
    .catch(() => {});
}

const SETTINGS_DEBOUNCE_MS = 500;
const MEMORY_REDUCTION_SCALE = 0.5;

const ConversionProgress = lazy(() => import('@components/ConversionProgress'));
const MemoryWarning = lazy(() => import('@components/MemoryWarning'));

const App: Component = () => {
  const { t } = useLocale();
  const [conversionStartTime, setConversionStartTime] = createSignal(0);
  const [estimatedSecondsRemaining, setEstimatedSecondsRemaining] = createSignal<number | null>(
    null
  );
  const [memoryWarning, setMemoryWarning] = createSignal(false);

  const [memoryUsageText, setMemoryUsageText] = createSignal<string | null>(null);

  const [conversionPhase, setConversionPhase] = createSignal<ProgressPhase>('demuxing');

  const {
    handleFileSelected,
    handleConvert,
    handleReset,
    handleCancelConversion,
    handleCancelAnalysis,
    handleRetry,
    handleDismissError,
  } = useConversionHandlers({
    conversionStartTime,
    setConversionStartTime,
    setEstimatedSecondsRemaining,
    setMemoryWarning,
    setConversionPhase,
    t,
  });

  useNetworkState();

  onMount(() => {
    const isSupported =
      typeof SharedArrayBuffer !== 'undefined' &&
      typeof crossOriginIsolated !== 'undefined' &&
      crossOriginIsolated === true;

    setEnvironmentSupported(isSupported);

    // Attach test helpers in dev mode (AI-driven browser testing)
    if (attachTestHelpers) {
      attachTestHelpers();
      logger.debug('general', 'Test helpers attached via App onMount');
    }
  });

  // Track whether we're converting to show memory usage text.
  // Actual polling is handled by the conversion runtime controller's
  // startMemoryMonitoring() to avoid redundant GC pressure from
  // performance.memory reads. We only display the value when it changes.
  createEffect(() => {
    if (appState() !== 'converting') {
      setMemoryUsageText(null);
    }
  });

  const debouncedSaveSettings = debounce(saveConversionSettings, SETTINGS_DEBOUNCE_MS);

  onCleanup(() => {
    // Revoke video preview blob URL to prevent memory leak on unmount
    const url = videoPreviewUrl();
    if (url) URL.revokeObjectURL(url);
    debouncedSaveSettings.cancel();
    dismissConfirmation();
  });

  createEffect(() => {
    debouncedSaveSettings(conversionSettings());
  });

  // Expose app state to DOM for automated testing
  onMount(() => {
    const el = document.createElement('div');
    el.id = 'app-state';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText =
      'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0';
    document.body.appendChild(el);
  });

  createEffect(() => {
    const el = document.getElementById('app-state');
    if (!el) return;
    const state = appState();
    const progress = conversionProgress();
    el.textContent = progress > 0 ? `${state}: ${progress}%` : state;
  });

  const dropzoneStatus = createMemo(() => {
    const state = appState();
    if (state === 'converting') {
      return {
        label: t('progress.converting'),
        progress: conversionProgress(),
        message: conversionStatusMessage(),
        subPhaseLabel: undefined,
        showElapsedTime: true,
        startTime: conversionStartTime(),
        estimatedSecondsRemaining: estimatedSecondsRemaining(),
        phase: conversionPhase(),
        memoryUsage: memoryUsageText(),
        outputFrames: outputFrames(),
      };
    }
    if (state === 'analyzing') {
      return {
        label: t('progress.analyzing'),
        progress: 0,
        message: t('progress.readingMetadata'),
        subPhaseLabel: t('progress.readingMetadata'),
      };
    }
    return null;
  });

  const isConversionActive = createMemo(
    () => appState() === 'converting' || appState() === 'cancelling'
  );

  const isBusy = createMemo(
    () => appState() === 'analyzing' || appState() === 'converting' || appState() === 'cancelling'
  );

  // Metadata summary for dropzone card: "1920×1080 · 0:12 · 30fps"
  const metadataSummary = createMemo(() => {
    const meta = videoMetadata();
    const file = inputFile();
    if (!meta || !file) return '';
    const parts: string[] = [];
    if (meta.width && meta.height) parts.push(`${meta.width}×${meta.height}`);
    if (meta.duration) {
      const mins = Math.floor(meta.duration / 60);
      const secs = Math.floor(meta.duration % 60);
      parts.push(`${mins}:${secs.toString().padStart(2, '0')}`);
    }
    if (meta.framerate) parts.push(`${meta.framerate}fps`);
    return parts.join(' · ');
  });

  const handleReduceSettings = (): void => {
    setConversionSettings({
      ...conversionSettings(),
      quality: 'low',
      scale: MEMORY_REDUCTION_SCALE,
    });

    if (memoryWarning() && appState() !== 'converting') {
      setMemoryWarning(false);
      handleConvert().catch((error) => {
        logger.error('general', 'Conversion failed after memory reduction', {
          error: getErrorMessage(error),
        });
      });
    }
  };

  const handleDismissMemoryWarning = (): void => {
    setMemoryWarning(false);
  };

  const handleConvertWithMemoryCheck = (): void => {
    if (isMemoryCritical()) {
      setMemoryWarning(true);
      return;
    }

    handleConvert().catch((error) => {
      logger.error('general', 'Conversion failed', {
        error: getErrorMessage(error),
      });
    });
  };

  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <div class="flex min-h-screen items-center justify-center bg-[#08090a] p-4">
          <div class="max-w-2xl border-l-4 border-red-500/60 bg-[#191a1b] p-6 rounded-lg">
            <h2 class="mb-2 text-lg font-semibold text-[#f7f8f8]">{t('app.error.title')}</h2>
            <p class="mb-4 text-sm text-[#d0d6e0]">{t('app.error.description')}</p>
            <div class="mb-4 flex gap-3">
              <button
                type="button"
                onClick={reset}
                class="inline-flex items-center rounded-md bg-[#5e6ad2] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#7170ff] focus:outline-none focus:ring-2 focus:ring-[#5e6ad2] focus:ring-offset-2 focus:ring-offset-[#191a1b]"
              >
                {t('app.error.retry')}
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                class="inline-flex items-center rounded-md border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-sm font-medium text-[#d0d6e0] transition-colors hover:bg-white/[0.05] focus:outline-none focus:ring-2 focus:ring-white/[0.2] focus:ring-offset-2 focus:ring-offset-[#191a1b]"
              >
                {t('app.error.reload')}
              </button>
            </div>
            <details class="text-xs text-[#d0d6e0]">
              <summary class="cursor-pointer hover:underline">{t('app.error.details')}</summary>
              <pre class="mt-2 overflow-auto rounded bg-white/[0.02] border border-white/[0.08] p-3">
                {String(error)}
              </pre>
            </details>
          </div>
        </div>
      )}
    >
      <div class="flex min-h-screen flex-col bg-[#08090a] transition-colors" data-testid="app">
        <a
          class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-[#5e6ad2] focus:px-4 focus:py-2 focus:text-white focus:shadow-lg"
          href="#main-content"
        >
          {t('app.skipToMain')}
        </a>

        <header class="border-b border-white/[0.08] bg-[#08090a]">
          <div class="mx-auto flex max-w-[1200px] items-center justify-between px-4 py-0">
            <div class="flex-1">
              <h1
                class="text-2xl font-bold tracking-tight text-[#f7f8f8] sm:text-[32px]"
                style="letter-spacing: -0.704px"
              >
                {t('app.title')}
              </h1>
              <p class="mt-0.5 text-sm text-[#d0d6e0] sm:text-lg">{t('app.subtitle')}</p>
            </div>

            <div class="flex items-center gap-2">
              <LanguageSelector />
              <ExportLogsButton />
            </div>
          </div>
        </header>

        <main
          id="main-content"
          class="mx-auto w-full max-w-[1200px] flex-1 px-4 py-8 sm:px-6 lg:px-8"
        >
          <StatusAlerts
            environmentSupported={environmentSupported()}
            errorContext={errorContext()}
            errorMessage={appState() === 'error' ? errorMessage() : null}
            onDismissError={handleDismissError}
            onRetry={handleRetry}
            onSelectNewFile={handleReset}
          />

          {/* Grid: exactly 2 direct children required (left/right columns).
              Do NOT wrap these divs — grid layout depends on direct-child relationship. */}
          <div class="mt-6 grid gap-6 sm:grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-start lg:gap-8">
            {/* Left column (desktop): Dropzone + metadata */}
            <div class="space-y-6 order-1">
              <Show when={memoryWarning()}>
                <Suspense fallback={<div class="h-24 animate-pulse rounded-lg bg-[#191a1b]" />}>
                  <MemoryWarning
                    isDuringConversion={appState() === 'converting'}
                    onCancel={handleCancelConversion}
                    onDismiss={handleDismissMemoryWarning}
                    onReduceSettings={handleReduceSettings}
                  />
                </Suspense>
              </Show>

              {/* Unified dropzone card with preview + progress (아이디어 1) */}
              <FileDropzone
                disabled={isBusy()}
                estimatedSecondsRemaining={dropzoneStatus()?.estimatedSecondsRemaining}
                onCancel={handleCancelConversion}
                onClear={handleReset}
                onFileSelected={handleFileSelected}
                previewUrl={videoPreviewUrl()}
                progress={dropzoneStatus()?.progress}
                showElapsedTime={dropzoneStatus()?.showElapsedTime}
                startTime={dropzoneStatus()?.startTime}
                status={dropzoneStatus()?.label}
                statusMessage={dropzoneStatus()?.message}
                phase={dropzoneStatus()?.phase}
                outputFrames={dropzoneStatus()?.outputFrames}
                fileName={inputFile()?.name}
                fileSize={inputFile()?.size}
                metadataSummary={metadataSummary()}
              />

              {/* Analyzing state: separate progress (not in dropzone) */}
              <Show when={appState() === 'analyzing'}>
                <Suspense fallback={<div class="h-20 animate-pulse rounded-lg bg-[#191a1b]" />}>
                  <div class="space-y-2">
                    <ConversionProgress
                      progress={0}
                      status={t('progress.analyzing')}
                      statusMessage={t('progress.readingMetadata')}
                    />
                    <button
                      type="button"
                      class="w-full rounded-md border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-sm font-medium text-[#d0d6e0] transition-all duration-150 hover:bg-white/[0.05] focus:outline-none focus:ring-2 focus:ring-[rgba(94,106,210,0.5)] focus:ring-offset-2 focus:ring-offset-[#0f1011]"
                      onClick={handleCancelAnalysis}
                    >
                      {t('dropzone.cancelConversion')}
                    </button>
                  </div>
                </Suspense>
              </Show>

              <Show when={appState() === 'cancelling'}>
                <Suspense fallback={<div class="h-20 animate-pulse rounded-lg bg-[#191a1b]" />}>
                  <ConversionProgress progress={0} status={t('progress.cancelling')} />
                </Suspense>
              </Show>

              {/* Video metadata: shown below dropzone when file selected but not converting */}
              <Show when={inputFile() && videoMetadata() && !isBusy()}>
                <VideoMetadataDisplay
                  fileName={inputFile()!.name}
                  fileSize={inputFile()!.size}
                  metadata={videoMetadata()!}
                />
              </Show>
            </div>

            {/* Right column (desktop): Settings */}
            <div class="lg:sticky lg:top-8 order-2">
              <SettingsPanel
                isBusy={isBusy()}
                isConversionActive={isConversionActive()}
                isConverting={appState() === 'converting'}
                metadata={videoMetadata()}
                onCancel={handleCancelConversion}
                onConvert={handleConvertWithMemoryCheck}
                onFormatChange={(format) =>
                  setConversionSettings({ ...conversionSettings(), format })
                }
                onQualityChange={(quality) =>
                  setConversionSettings({ ...conversionSettings(), quality })
                }
                onScaleChange={(scale) => setConversionSettings({ ...conversionSettings(), scale })}
                onTrimChange={(start, end) =>
                  setConversionSettings({ ...conversionSettings(), trimStart: start, trimEnd: end })
                }
                onSmartFrameSkipChange={(mode) =>
                  setConversionSettings({ ...conversionSettings(), smartFrameSkip: mode })
                }
                settings={conversionSettings()}
              />
            </div>
          </div>

          <ResultSection results={conversionResults()} />
        </main>

        <LicenseAttribution />
        <ConfirmationModal />
      </div>
    </ErrorBoundary>
  );
};

export default App;
