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
import { debounce } from '@piesp/browser-core/async';
import { getErrorMessage } from '@piesp/browser-core/error';
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
import type { AppState } from '@t/app-types';
import type { ProgressPhase } from '@t/conversion-types';
import type { TFunction, TranslationKey } from '@t/i18n-types';
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

const APP_STATE_LABEL_KEYS = {
  idle: 'settings.selectVideo',
  analyzing: 'progress.analyzing',
  converting: 'progress.converting',
  cancelling: 'progress.cancelling',
  done: 'result.convertedAnimation',
  error: 'error.conversionFailed',
} as const satisfies Record<AppState, TranslationKey>;

export function getAppStateAnnouncement(state: AppState, t: TFunction): string {
  return t(APP_STATE_LABEL_KEYS[state]);
}

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
    setMemoryUsageText,
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

  // Clear conversion-only memory telemetry outside an active conversion.
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
    // Only announce state transitions, not per-frame progress updates.
    // Per-frame announcements would flood the screen reader with noise.
    el.textContent = getAppStateAnnouncement(appState(), t);
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
        <div class="flex min-h-screen items-center justify-center bg-bg-base p-4">
          <div class="max-w-2xl border-l-4 border-red-500/60 bg-bg-elevated p-6 rounded-lg">
            <h2 class="mb-2 text-lg font-semibold text-text-primary">{t('app.error.title')}</h2>
            <p class="mb-4 text-sm text-text-secondary">{t('app.error.description')}</p>
            <div class="mb-4 flex gap-3">
              <button
                type="button"
                onClick={reset}
                class="inline-flex items-center rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg-elevated cursor-pointer"
              >
                {t('app.error.retry')}
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                class="inline-flex items-center rounded-md border border-border-standard bg-white/[0.02] px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/[0.2] focus-visible:ring-offset-2 focus-visible:ring-offset-bg-elevated cursor-pointer"
              >
                {t('app.error.reload')}
              </button>
            </div>
            <details class="text-xs text-text-secondary">
              <summary class="cursor-pointer hover:underline">{t('app.error.details')}</summary>
              <pre class="mt-2 overflow-auto rounded bg-white/[0.02] border border-border-standard p-3">
                {String(error)}
              </pre>
            </details>
          </div>
        </div>
      )}
    >
      <div class="flex min-h-screen flex-col bg-bg-base transition-colors" data-testid="app">
        <a
          class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-brand focus:px-4 focus:py-2 focus:text-white focus:shadow-lg"
          href="#main-content"
        >
          {t('app.skipToMain')}
        </a>

        <header class="border-b border-border-standard bg-bg-base">
          <div class="mx-auto flex max-w-[1200px] items-center justify-between px-4 py-0">
            <div class="flex-1">
              <h1
                class="text-2xl font-bold tracking-tight text-text-primary sm:text-[32px]"
                style="letter-spacing: -0.704px"
              >
                {t('app.title')}
              </h1>
              <p class="mt-0.5 text-sm text-text-secondary sm:text-lg">{t('app.subtitle')}</p>
            </div>

            <nav aria-label={t('app.navigation')} class="flex items-center gap-2">
              <LanguageSelector />
              <ExportLogsButton />
            </nav>
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
                <Suspense fallback={<div class="h-24 animate-pulse rounded-lg bg-bg-elevated" />}>
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
                memoryUsage={dropzoneStatus()?.memoryUsage}
                onCancel={
                  appState() === 'analyzing' ? handleCancelAnalysis : handleCancelConversion
                }
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

              <Show when={appState() === 'cancelling'}>
                <Suspense fallback={<div class="h-20 animate-pulse rounded-lg bg-bg-elevated" />}>
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

        <footer>
          <LicenseAttribution />
        </footer>
        <ConfirmationModal />
      </div>
    </ErrorBoundary>
  );
};

export default App;
