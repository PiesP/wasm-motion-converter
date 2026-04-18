import ConfirmationModal from '@components/ConfirmationModal';
import EnvironmentWarning from '@components/EnvironmentWarning';
import ExportLogsButton from '@components/ExportLogsButton';
import FileDropzone from '@components/FileDropzone';
import FormatSelector from '@components/FormatSelector';
import LicenseAttribution from '@components/LicenseAttribution';
import OfflineBanner from '@components/OfflineBanner';
import QualitySelector from '@components/QualitySelector';
import ScaleSelector from '@components/ScaleSelector';
import ThemeToggle from '@components/ThemeToggle';
import VideoMetadataDisplay from '@components/VideoMetadataDisplay';
import Button from '@components/ui/Button';
import Panel from '@components/ui/Panel';
import {
  appState,
  environmentSupported,
  loadingProgress,
  loadingStatusMessage,
  setEnvironmentSupported,
} from '@stores/app-store';
import {
  conversionProgress,
  conversionResults,
  conversionStatusMessage,
  errorContext,
  errorMessage,
  inputFile,
  videoMetadata,
  videoPreviewUrl,
} from '@stores/conversion-store';
import {
  conversionSettings,
  saveConversionSettings,
  setConversionSettings,
} from '@stores/conversion-settings-store';
import { useNetworkState } from '@stores/network-store';
import type {
  ConversionResult,
  ConversionSettings,
  ErrorContext,
  VideoMetadata,
} from '@t/conversion-types';
import { debounce } from '@utils/debounce';
import { isMemoryCritical } from '@utils/memory-monitor';
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  ErrorBoundary,
  For,
  lazy,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from 'solid-js';

import { useConversionHandlers } from '@/hooks/use-conversion-handlers';

const ConversionProgress = lazy(() => import('@components/ConversionProgress'));
const ErrorDisplay = lazy(() => import('@components/ErrorDisplay'));
const MemoryWarning = lazy(() => import('@components/MemoryWarning'));
const ResultPreview = lazy(() => import('@components/ResultPreview'));

interface StatusAlertsProps {
  environmentSupported: boolean;
  errorMessage: string | null;
  errorContext: ErrorContext | null;
  onRetry: () => void;
  onSelectNewFile: () => void;
  onDismissError: () => void;
}

const StatusAlerts: Component<StatusAlertsProps> = (props) => {
  return (
    <div class="space-y-6">
      <OfflineBanner />

      <Show when={!props.environmentSupported}>
        <EnvironmentWarning />
      </Show>

      <Show when={props.errorMessage}>
        <Suspense
          fallback={<div class="h-32 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />}
        >
          <ErrorDisplay
            message={props.errorMessage!}
            suggestion={props.errorContext?.suggestion}
            errorType={props.errorContext?.type}
            onRetry={props.onRetry}
            onSelectNewFile={props.onSelectNewFile}
            onDismiss={props.onDismissError}
          />
        </Suspense>
      </Show>
    </div>
  );
};

interface SettingsPanelProps {
  isBusy: boolean;
  isConverting: boolean;
  settings: ConversionSettings;
  metadata: VideoMetadata | null;
  onConvert: () => void;
  onCancel: () => void;
  onFormatChange: (format: ConversionSettings['format']) => void;
  onQualityChange: (quality: ConversionSettings['quality']) => void;
  onScaleChange: (scale: ConversionSettings['scale']) => void;
}

const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  return (
    <Panel class="p-6">
      <div class="mb-6 flex gap-3">
        <Show
          when={props.isConverting}
          fallback={
            <Button
              ariaLabel="Convert video to animated image"
              class="flex-1"
              disabled={!props.metadata || props.isBusy}
              onClick={props.onConvert}
            >
              Convert
            </Button>
          }
        >
          <Button
            ariaLabel="Stop video conversion"
            class="flex-1"
            onClick={props.onCancel}
            variant="danger"
          >
            Stop Conversion
          </Button>
        </Show>
      </div>

      <FormatSelector
        disabled={!props.metadata || props.isBusy}
        onChange={props.onFormatChange}
        tooltip="GIF works everywhere, WebP is smaller but requires modern browsers"
        value={props.settings.format}
      />

      <QualitySelector
        disabled={!props.metadata || props.isBusy}
        onChange={props.onQualityChange}
        tooltip="Higher quality = larger file size and slower conversion"
        value={props.settings.quality}
      />

      <ScaleSelector
        disabled={!props.metadata || props.isBusy}
        inputMetadata={props.metadata}
        onChange={props.onScaleChange}
        tooltip="Reduce dimensions to decrease file size and speed up conversion"
        value={props.settings.scale}
      />
    </Panel>
  );
};

interface ResultSectionProps {
  results: ConversionResult[];
}

const ResultSection: Component<ResultSectionProps> = (props) => {
  return (
    <Show when={props.results.length > 0}>
      <div class="mt-8 space-y-6">
        <For each={props.results}>
          {(result) => (
            <Suspense
              fallback={<div class="h-96 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />}
            >
              <ResultPreview
                conversionDurationSeconds={result.conversionDurationSeconds}
                originalCodec={result.originalCodec}
                originalName={result.originalName}
                originalSize={result.originalSize}
                outputBlob={result.outputBlob}
                settings={result.settings}
                wasTranscoded={result.wasTranscoded}
              />
            </Suspense>
          )}
        </For>
      </div>
    </Show>
  );
};

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
  });

  const debouncedSaveSettings = debounce(saveConversionSettings, 500);

  onCleanup(() => {
    debouncedSaveSettings.cancel();
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

  const isBusy = createMemo(
    () =>
      appState() === 'loading-ffmpeg' || appState() === 'analyzing' || appState() === 'converting'
  );

  const handleReduceSettings = (): void => {
    setConversionSettings({
      ...conversionSettings(),
      quality: 'low',
      scale: 0.5,
    });

    if (memoryWarning() && appState() !== 'converting') {
      setMemoryWarning(false);
      void handleConvert();
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

    void handleConvert();
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

        <main id="main-content" class="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
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
                  <ConversionProgress
                    progress={loadingProgress()}
                    status="Loading FFmpeg (~30MB download)..."
                    statusMessage={loadingStatusMessage()}
                  />
                </Suspense>
              </Show>

              <Show when={appState() === 'analyzing'}>
                <Suspense
                  fallback={
                    <div class="h-20 animate-pulse rounded-lg bg-blue-50 dark:bg-blue-900/20" />
                  }
                >
                  <ConversionProgress progress={50} status="Analyzing video..." />
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
