import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  ErrorBoundary,
  For,
  onMount,
  Show,
} from 'solid-js';
import ConversionProgress from './components/ConversionProgress';
import EnvironmentWarning from './components/EnvironmentWarning';
import ErrorDisplay from './components/ErrorDisplay';
import FileDropzone from './components/FileDropzone';
import FormatSelector from './components/FormatSelector';
import InlineWarningBanner from './components/InlineWarningBanner';
import LicenseAttribution from './components/LicenseAttribution';
import QualitySelector from './components/QualitySelector';
import ResultPreview from './components/ResultPreview';
import ScaleSelector from './components/ScaleSelector';
import ThemeToggle from './components/ThemeToggle';
import VideoMetadataDisplay from './components/VideoMetadataDisplay';
import { useConversionHandlers } from './hooks/useConversionHandlers';
import { ffmpegService } from './services/ffmpeg-service';
import { getRecommendedSettings } from './services/performance-checker';
import {
  appState,
  environmentSupported,
  loadingProgress,
  loadingStatusMessage,
  setEnvironmentSupported,
} from './stores/app-store';
import {
  autoAppliedRecommendation,
  conversionProgress,
  conversionResults,
  conversionSettings,
  conversionStatusMessage,
  errorContext,
  errorMessage,
  inputFile,
  performanceWarnings,
  saveConversionSettings,
  setConversionSettings,
  videoMetadata,
} from './stores/conversion-store';
import { estimateEtaRange, estimateOutputSizeRange } from './utils/estimate-output';

const App: Component = () => {
  const [conversionStartTime, setConversionStartTime] = createSignal<number>(0);
  const [estimatedSecondsRemaining, setEstimatedSecondsRemaining] = createSignal<number | null>(
    null
  );
  const [memoryWarning, setMemoryWarning] = createSignal(false);

  const { handleFileSelected, handleConvert, handleReset, handleCancelConversion, handleRetry } =
    useConversionHandlers({
      conversionStartTime,
      setConversionStartTime,
      setEstimatedSecondsRemaining,
      setMemoryWarning,
    });

  const formatQualityLabel = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

  const runIdle = (callback: () => void) => {
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(callback, { timeout: 3000 });
    } else {
      setTimeout(callback, 1200);
    }
  };
  onMount(() => {
    const isSupported = typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated === true;
    setEnvironmentSupported(isSupported);

    const connection = (navigator as Navigator & { connection?: { effectiveType?: string } })
      .connection;
    const isFastNetwork = !connection || connection.effectiveType === '4g';
    if (isFastNetwork) {
      runIdle(() => {
        void ffmpegService.prefetchCoreAssets().catch((error) => {
          console.debug('[FFmpeg] Prefetch skipped', error);
        });
      });
    }
  });

  // Persist conversion settings to localStorage whenever they change
  createEffect(() => {
    const settings = conversionSettings();
    saveConversionSettings(settings);
  });

  const dropzoneStatus = createMemo(() => {
    if (appState() === 'converting') {
      return {
        label: 'Converting video...',
        progress: conversionProgress(),
        message: conversionStatusMessage(),
        showElapsedTime: true,
        startTime: conversionStartTime(),
        estimatedSecondsRemaining: estimatedSecondsRemaining(),
      };
    }
    return null;
  });

  const isBusy = createMemo(
    () =>
      appState() === 'loading-ffmpeg' || appState() === 'analyzing' || appState() === 'converting'
  );

  const recommendedSettings = createMemo(() => {
    const file = inputFile();
    const metadata = videoMetadata();
    if (!file || !metadata) {
      return null;
    }
    return getRecommendedSettings(file, metadata, conversionSettings());
  });

  const estimates = createMemo(() => {
    const file = inputFile();
    const metadata = videoMetadata();
    if (!file || !metadata) {
      return null;
    }
    const scaleFactor = conversionSettings().scale ** 2;
    const sizeRange = estimateOutputSizeRange(file.size, conversionSettings(), scaleFactor);
    const megapixels = (metadata.width * metadata.height * scaleFactor) / 1_000_000;
    const etaRange = estimateEtaRange(metadata.duration, megapixels, conversionSettings());
    return {
      sizeLabel: sizeRange.label,
      etaLabel: etaRange.label,
    };
  });

  const recommendedActionLabel = createMemo(() => {
    const recommendation = recommendedSettings();
    if (!recommendation) {
      return undefined;
    }
    const qualityLabel = formatQualityLabel(recommendation.quality);
    const scaleLabel = `${Math.round(recommendation.scale * 100)}%`;
    return `Apply recommended settings (Quality: ${qualityLabel}, Scale: ${scaleLabel})`;
  });

  const handleApplyRecommended = () => {
    const recommendation = recommendedSettings();
    if (recommendation) {
      setConversionSettings(recommendation);
    }
  };

  return (
    <ErrorBoundary
      fallback={(error) => (
        <div class="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-4">
          <div class="bg-red-50 dark:bg-red-950 border-l-4 border-red-400 dark:border-red-500 p-6 max-w-2xl">
            <h2 class="text-lg font-semibold text-red-800 dark:text-red-300 mb-2">
              Application Error
            </h2>
            <p class="text-sm text-red-700 dark:text-red-400 mb-4">
              An unexpected error occurred. Please refresh the page to try again.
            </p>
            <details class="text-xs text-red-600 dark:text-red-500">
              <summary class="cursor-pointer hover:underline">Error details</summary>
              <pre class="mt-2 p-3 bg-red-100 dark:bg-red-900 rounded overflow-auto">
                {error.toString()}
              </pre>
            </details>
          </div>
        </div>
      )}
    >
      <div class="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col transition-colors">
        <a
          href="#main-content"
          class="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:px-4 focus:py-2 focus:bg-blue-600 focus:text-white focus:rounded focus:shadow-lg"
        >
          Skip to main content
        </a>
        <header class="bg-white dark:bg-gray-900 shadow-sm dark:shadow-gray-800 border-b border-gray-200 dark:border-gray-800">
          <div class="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
            <div class="flex-1">
              <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Motion Converter</h1>
              <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">
                Convert videos to animated GIF or WebP images
              </p>
            </div>
            <ThemeToggle />
          </div>
        </header>

        <main id="main-content" class="flex-1 max-w-6xl mx-auto w-full px-4 py-8">
          <div class="space-y-6">
            <Show when={!environmentSupported()}>
              <EnvironmentWarning />
            </Show>

            <Show when={appState() === 'error' && errorMessage()}>
              <ErrorDisplay
                message={errorMessage()!}
                suggestion={errorContext()?.suggestion}
                onRetry={handleRetry}
                onSelectNewFile={handleReset}
              />
            </Show>
          </div>

          <div class="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-8 lg:items-start">
            <div class="space-y-6">
              <Show when={memoryWarning()}>
                <div class="bg-red-50 dark:bg-red-950 border-l-4 border-red-400 dark:border-red-500 rounded-lg p-4 text-sm text-red-800 dark:text-red-200">
                  High browser memory usage detected ({'>'}80% of JS heap). Close other heavy tabs
                  or switch to Low quality and 50% scale to reduce failure risk.
                </div>
              </Show>

              <FileDropzone
                onFileSelected={handleFileSelected}
                disabled={isBusy()}
                status={dropzoneStatus()?.label}
                progress={dropzoneStatus()?.progress}
                statusMessage={dropzoneStatus()?.message}
                showElapsedTime={dropzoneStatus()?.showElapsedTime}
                startTime={dropzoneStatus()?.startTime}
                estimatedSecondsRemaining={dropzoneStatus()?.estimatedSecondsRemaining}
              />

              <Show when={appState() === 'loading-ffmpeg'}>
                <ConversionProgress
                  progress={loadingProgress()}
                  status="Loading FFmpeg (~30MB download)..."
                  statusMessage={loadingStatusMessage()}
                />
              </Show>

              <Show when={appState() === 'analyzing'}>
                <ConversionProgress progress={50} status="Analyzing video..." />
              </Show>

              {/* Video metadata and warnings - show after file analysis */}
              <Show when={inputFile() && videoMetadata()}>
                <VideoMetadataDisplay
                  metadata={videoMetadata()!}
                  fileName={inputFile()!.name}
                  fileSize={inputFile()!.size}
                />

                <Show when={performanceWarnings().length > 0}>
                  <InlineWarningBanner
                    warnings={performanceWarnings()}
                    actionLabel={recommendedActionLabel()}
                    onAction={recommendedActionLabel() ? handleApplyRecommended : undefined}
                    autoApplied={autoAppliedRecommendation()}
                    estimates={estimates()}
                  />
                </Show>
              </Show>
            </div>

            {/* Conversion settings - ALWAYS visible (from first screen) */}
            <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6">
              <div class="flex gap-3 mb-6">
                <Show
                  when={appState() === 'converting'}
                  fallback={
                    <button
                      type="button"
                      disabled={!videoMetadata() || isBusy()}
                      class="flex-1 inline-flex justify-center items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-offset-gray-900 disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={handleConvert}
                    >
                      Convert
                    </button>
                  }
                >
                  <button
                    type="button"
                    class="flex-1 inline-flex justify-center items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 dark:focus:ring-offset-gray-900"
                    onClick={handleCancelConversion}
                  >
                    Stop Conversion
                  </button>
                </Show>
              </div>

              <FormatSelector
                value={conversionSettings().format}
                onChange={(format) => setConversionSettings({ ...conversionSettings(), format })}
                disabled={!videoMetadata() || isBusy()}
              />

              <QualitySelector
                value={conversionSettings().quality}
                onChange={(quality) => setConversionSettings({ ...conversionSettings(), quality })}
                disabled={!videoMetadata() || isBusy()}
              />

              <ScaleSelector
                value={conversionSettings().scale}
                inputMetadata={videoMetadata()}
                onChange={(scale) => setConversionSettings({ ...conversionSettings(), scale })}
                disabled={!videoMetadata() || isBusy()}
              />
            </div>
          </div>

          {/* Result previews */}
          <Show when={conversionResults().length > 0}>
            <div class="mt-8 space-y-6">
              <For each={conversionResults()}>
                {(result) => (
                  <ResultPreview
                    outputBlob={result.outputBlob}
                    originalName={result.originalName}
                    originalSize={result.originalSize}
                    settings={result.settings}
                    wasTranscoded={result.wasTranscoded}
                    originalCodec={result.originalCodec}
                  />
                )}
              </For>
            </div>
          </Show>
        </main>

        <LicenseAttribution />
      </div>
    </ErrorBoundary>
  );
};

export default App;
