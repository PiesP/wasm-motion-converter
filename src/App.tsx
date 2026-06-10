// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import ConfirmationModal from '@components/ConfirmationModal';
import ExportLogsButton from '@components/ExportLogsButton';
import FileDropzone from '@components/FileDropzone';
import LicenseAttribution from '@components/LicenseAttribution';
import ResultSection from '@components/ResultSection';
import SettingsPanel from '@components/SettingsPanel';
import StatusAlerts from '@components/StatusAlerts';
import ThemeToggle from '@components/ThemeToggle';
import VideoMetadataDisplay from '@components/VideoMetadataDisplay';
import { useConversionHandlers } from '@hooks/use-conversion-handlers';
import { useNetworkState } from '@hooks/use-network-state';
import { ffmpegService } from '@services/cpu-path/ffmpeg-pipeline-service';
import { requestIdle } from '@services/ffmpeg/core-assets-service';
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
  loadingProgress,
  loadingStatusMessage,
  setEnvironmentSupported,
  videoMetadata,
  videoPreviewUrl,
} from '@stores/conversion-store';
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
  const [conversionStartTime, setConversionStartTime] = createSignal(0);
  const [estimatedSecondsRemaining, setEstimatedSecondsRemaining] = createSignal<number | null>(
    null
  );
  const [memoryWarning, setMemoryWarning] = createSignal(false);

  const {
    handleFileSelected,
    handleConvert,
    handleReset,
    handleCancelConversion,
    handleCancelFFmpegLoad,
    handleCancelAnalysis,
    handleRetry,
    handleDismissError,
  } = useConversionHandlers({
    conversionStartTime,
    setConversionStartTime,
    setEstimatedSecondsRemaining,
    setMemoryWarning,
  });

  useNetworkState();

  onMount(() => {
    const isSupported =
      typeof SharedArrayBuffer !== 'undefined' &&
      typeof crossOriginIsolated !== 'undefined' &&
      crossOriginIsolated === true;

    setEnvironmentSupported(isSupported);

    // Prefetch FFmpeg core assets in idle time to reduce first-conversion latency
    if (isSupported) {
      requestIdle(
        () => {
          ffmpegService.prefetchCoreAssets().catch(() => {
            // Non-fatal: prefetch failure will be handled on first conversion
            logger.debug('general', 'FFmpeg core prefetch failed (will retry on demand)');
          });
        },
        { timeout: 5000 }
      );
    }

    // Attach test helpers in dev mode (AI-driven browser testing)
    if (attachTestHelpers) {
      attachTestHelpers();
      logger.debug('general', 'Test helpers attached via App onMount');
    }
  });

  const debouncedSaveSettings = debounce(saveConversionSettings, SETTINGS_DEBOUNCE_MS);

  onCleanup(() => {
    const url = videoPreviewUrl();
    if (url) URL.revokeObjectURL(url);
    debouncedSaveSettings.cancel();
    dismissConfirmation();
    (
      (globalThis as Record<string, unknown>).cleanupServiceWorkerUpdateCheck as
        | (() => void)
        | undefined
    )?.();
  });

  createEffect(() => {
    debouncedSaveSettings(conversionSettings());
  });

  const dropzoneStatus = createMemo(() => {
    if (appState() !== 'converting') {
      return null;
    }

    return {
      label: 'Converting video...',
      progress: conversionProgress(),
      message: conversionStatusMessage(),
      showElapsedTime: true,
      startTime: conversionStartTime(),
      estimatedSecondsRemaining: estimatedSecondsRemaining(),
    };
  });

  const isConversionActive = createMemo(
    () => appState() === 'converting' || appState() === 'cancelling'
  );

  const isBusy = createMemo(
    () =>
      appState() === 'loading-ffmpeg' ||
      appState() === 'analyzing' ||
      appState() === 'converting' ||
      appState() === 'cancelling'
  );

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
      fallback={(error) => (
        <div class="flex min-h-screen items-center justify-center bg-gray-50 p-4 dark:bg-gray-950">
          <div class="max-w-2xl border-l-4 border-red-400 bg-red-50 p-6 dark:border-red-500 dark:bg-red-950">
            <h2 class="mb-2 text-lg font-semibold text-red-800 dark:text-red-300">
              Application Error
            </h2>
            <p class="mb-4 text-sm text-red-700 dark:text-red-400">
              An unexpected error occurred. Please refresh the page to try again.
            </p>
            <details class="text-xs text-red-600 dark:text-red-500">
              <summary class="cursor-pointer hover:underline">Error details</summary>
              <pre class="mt-2 overflow-auto rounded bg-red-100 p-3 dark:bg-red-900">
                {String(error)}
              </pre>
            </details>
          </div>
        </div>
      )}
    >
      <div class="flex min-h-screen flex-col bg-gray-50 transition-colors dark:bg-gray-950">
        <a
          class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-blue-600 focus:px-4 focus:py-2 focus:text-white focus:shadow-lg"
          href="#main-content"
        >
          Skip to main content
        </a>

        <header class="border-b border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900 dark:shadow-gray-800">
          <div class="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
            <div class="flex-1">
              <h1 class="text-xl font-bold text-gray-900 dark:text-white sm:text-2xl">
                Motion Converter
              </h1>
              <p class="mt-1 text-xs text-gray-600 dark:text-gray-400 sm:text-sm">
                Convert videos to animated GIF or WebP images
              </p>
            </div>

            <div class="flex items-center gap-2">
              <ExportLogsButton />
              <ThemeToggle />
            </div>
          </div>
        </header>

        <main id="main-content" class="mx-auto w-full max-w-6xl flex-1 px-4 py-8" data-testid="app">
          <StatusAlerts
            environmentSupported={environmentSupported()}
            errorContext={errorContext()}
            errorMessage={appState() === 'error' ? errorMessage() : null}
            onDismissError={handleDismissError}
            onRetry={handleRetry}
            onSelectNewFile={handleReset}
          />

          <div class="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-start lg:gap-8">
            <div class="space-y-6">
              <Show when={memoryWarning()}>
                <Suspense
                  fallback={
                    <div class="h-24 animate-pulse rounded-lg bg-yellow-50 dark:bg-yellow-900/20" />
                  }
                >
                  <MemoryWarning
                    isDuringConversion={appState() === 'converting'}
                    onCancel={handleCancelConversion}
                    onDismiss={handleDismissMemoryWarning}
                    onReduceSettings={handleReduceSettings}
                  />
                </Suspense>
              </Show>

              <FileDropzone
                disabled={isBusy()}
                estimatedSecondsRemaining={dropzoneStatus()?.estimatedSecondsRemaining}
                onFileSelected={handleFileSelected}
                previewUrl={videoPreviewUrl()}
                progress={dropzoneStatus()?.progress}
                showElapsedTime={dropzoneStatus()?.showElapsedTime}
                startTime={dropzoneStatus()?.startTime}
                status={dropzoneStatus()?.label}
                statusMessage={dropzoneStatus()?.message}
              />

              <Show when={appState() === 'loading-ffmpeg'}>
                <Suspense
                  fallback={
                    <div class="h-20 animate-pulse rounded-lg bg-blue-50 dark:bg-blue-900/20" />
                  }
                >
                  <div class="space-y-2">
                    <ConversionProgress
                      progress={loadingProgress()}
                      status="Loading FFmpeg (~30MB download)..."
                      statusMessage={loadingStatusMessage()}
                    />
                    <button
                      type="button"
                      class="w-full rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:focus:ring-blue-400 dark:focus:ring-offset-gray-900"
                      onClick={handleCancelFFmpegLoad}
                    >
                      Cancel
                    </button>
                  </div>
                </Suspense>
              </Show>

              <Show when={appState() === 'analyzing'}>
                <Suspense
                  fallback={
                    <div class="h-20 animate-pulse rounded-lg bg-blue-50 dark:bg-blue-900/20" />
                  }
                >
                  <div class="space-y-2">
                    <ConversionProgress
                      progress={0}
                      status="Analyzing video..."
                      statusMessage="Reading video metadata..."
                    />
                    <button
                      type="button"
                      class="w-full rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:focus:ring-blue-400 dark:focus:ring-offset-gray-900"
                      onClick={handleCancelAnalysis}
                    >
                      Cancel
                    </button>
                  </div>
                </Suspense>
              </Show>

              <Show when={appState() === 'cancelling'}>
                <Suspense
                  fallback={
                    <div class="h-20 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
                  }
                >
                  <ConversionProgress progress={0} status="Cancelling..." />
                </Suspense>
              </Show>

              <Show when={inputFile() && videoMetadata()}>
                <VideoMetadataDisplay
                  fileName={inputFile()!.name}
                  fileSize={inputFile()!.size}
                  metadata={videoMetadata()!}
                />
              </Show>
            </div>

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
              settings={conversionSettings()}
            />
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
