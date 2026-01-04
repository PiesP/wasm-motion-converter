import {
  batch,
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
import { convertVideo } from './services/conversion-service';
import { ffmpegService } from './services/ffmpeg-service';
import { checkPerformance, getRecommendedSettings } from './services/performance-checker';
import { analyzeVideo, analyzeVideoQuick } from './services/video-analyzer';
import { logger } from './utils/logger';
import {
  appState,
  environmentSupported,
  loadingProgress,
  loadingStatusMessage,
  setAppState,
  setEnvironmentSupported,
  setLoadingProgress,
  setLoadingStatusMessage,
} from './stores/app-store';
import {
  autoAppliedRecommendation,
  conversionProgress,
  conversionResults,
  conversionSettings,
  conversionStatusMessage,
  DEFAULT_CONVERSION_SETTINGS,
  errorContext,
  errorMessage,
  inputFile,
  MAX_RESULTS,
  performanceWarnings,
  saveConversionSettings,
  setAutoAppliedRecommendation,
  setConversionProgress,
  setConversionResults,
  setConversionSettings,
  setConversionStatusMessage,
  setErrorContext,
  setErrorMessage,
  setInputFile,
  setPerformanceWarnings,
  setVideoMetadata,
  videoMetadata,
} from './stores/conversion-store';
import type { VideoMetadata } from './types/conversion-types';
import { classifyConversionError } from './utils/classify-conversion-error';
import { WARN_RESOLUTION_PIXELS } from './utils/constants';
import { estimateEtaRange, estimateOutputSizeRange } from './utils/estimate-output';
import { ETACalculator } from './utils/eta-calculator';
import { validateVideoFile } from './utils/file-validation';
import { isMemoryCritical } from './utils/memory-monitor';

const App: Component = () => {
  const [conversionStartTime, setConversionStartTime] = createSignal<number>(0);
  const [estimatedSecondsRemaining, setEstimatedSecondsRemaining] = createSignal<number | null>(
    null
  );
  const [memoryWarning, setMemoryWarning] = createSignal(false);
  let memoryCheckTimer: ReturnType<typeof setInterval> | null = null;
  let lastEtaUpdate = 0; // Timestamp of last ETA UI update (for throttling)
  const etaCalculator = new ETACalculator();
  const formatQualityLabel = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

  const runIdle = (callback: () => void) => {
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(callback, { timeout: 3000 });
    } else {
      setTimeout(callback, 1200);
    }
  };

  const shouldRunFullAnalysis = (file: File, metadata: VideoMetadata | null): boolean => {
    if (!metadata) {
      return true;
    }
    if (metadata.codec === 'unknown' || metadata.framerate <= 0 || metadata.bitrate <= 0) {
      return true;
    }
    const isSmallFile = file.size <= 50 * 1024 * 1024;
    const isShort = metadata.duration > 0 ? metadata.duration <= 15 : false;
    const isLowRes = metadata.width * metadata.height <= WARN_RESOLUTION_PIXELS;
    return !(isSmallFile && isShort && isLowRes);
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

  const resetConversionRuntimeState = () => {
    setConversionProgress(0);
    setConversionStatusMessage('');
    setConversionStartTime(0);
    setEstimatedSecondsRemaining(null);
    setMemoryWarning(false);
    etaCalculator.reset();
    if (memoryCheckTimer) {
      clearInterval(memoryCheckTimer);
      memoryCheckTimer = null;
    }
  };

  const resetErrorState = () => {
    setErrorMessage(null);
    setErrorContext(null);
  };

  const resetAnalysisState = () => {
    setVideoMetadata(null);
    setPerformanceWarnings([]);
    setAutoAppliedRecommendation(false);
  };

  const resetOutputState = () => {
    setLoadingProgress(0);
    setLoadingStatusMessage('');
  };

  const clearConversionCallbacks = () => {
    ffmpegService.setProgressCallback(null);
    ffmpegService.setStatusCallback(null);
  };

  const handleFileSelected = async (file: File) => {
    resetConversionRuntimeState();
    resetErrorState();
    resetAnalysisState();
    resetOutputState();

    const validation = validateVideoFile(file);
    if (!validation.valid) {
      setErrorMessage(validation.error ?? 'Unknown error');
      setAppState('error');
      // Move focus to retry button for keyboard users and screen readers
      queueMicrotask(() => {
        document.querySelector<HTMLButtonElement>('[data-error-retry-button]')?.focus();
      });
      return;
    }

    await ffmpegService.clearCachedInput();
    setInputFile(file);

    try {
      const needsInit = !ffmpegService.isLoaded();
      const initPromise = needsInit
        ? ffmpegService.initialize(setLoadingProgress, setLoadingStatusMessage)
        : Promise.resolve();

      if (needsInit) {
        setAppState('loading-ffmpeg');
      }

      let quickMetadata: VideoMetadata | null = null;
      const quickAnalysisPromise = analyzeVideoQuick(file)
        .then((metadata) => {
          quickMetadata = metadata;
          setVideoMetadata(metadata);
          setPerformanceWarnings(checkPerformance(file, metadata));
          return metadata;
        })
        .catch(() => null);

      await Promise.all([initPromise, quickAnalysisPromise]);

      const requiresFullAnalysis = shouldRunFullAnalysis(file, quickMetadata);
      let finalMetadata: VideoMetadata | null = quickMetadata;

      if (requiresFullAnalysis) {
        setAppState('analyzing');
        const metadata = await analyzeVideo(file);
        finalMetadata = metadata;
        setVideoMetadata(metadata);
        setPerformanceWarnings(checkPerformance(file, metadata));
      }

      if (finalMetadata) {
        const recommendation = getRecommendedSettings(file, finalMetadata, conversionSettings());
        const applied = Boolean(recommendation);
        setAutoAppliedRecommendation(applied);
        if (recommendation) {
          setConversionSettings(recommendation);
        }
      }

      setAppState('idle');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unknown error occurred');
      setAppState('error');
      // Move focus to retry button for keyboard users and screen readers
      queueMicrotask(() => {
        document.querySelector<HTMLButtonElement>('[data-error-retry-button]')?.focus();
      });
    }
  };

  const handleConvert = async () => {
    const file = inputFile();
    if (!file) {
      return;
    }

    const settings = conversionSettings();

    try {
      setAppState('converting');
      setConversionProgress(0);
      setConversionStatusMessage('');
      setConversionStartTime(Date.now());
      setErrorContext(null);
      etaCalculator.reset();
      setEstimatedSecondsRemaining(null);
      lastEtaUpdate = 0; // Reset ETA update throttle
      setMemoryWarning(false);

      logger.info('conversion', 'Starting conversion', {
        format: settings.format,
        quality: settings.quality,
        scale: settings.scale,
        fileSize: file.size,
        fileName: file.name,
      });
      if (memoryCheckTimer) {
        clearInterval(memoryCheckTimer);
      }
      memoryCheckTimer = setInterval(() => {
        if (isMemoryCritical()) {
          setMemoryWarning(true);
        }
      }, 2000);

      const progressCallback = (progress: number) => {
        const now = Date.now();
        batch(() => {
          setConversionProgress(progress);
          etaCalculator.addSample(progress);
          // Throttle ETA UI updates to max 1/second to reduce reactive computation overhead
          if (now - lastEtaUpdate >= 1000) {
            setEstimatedSecondsRemaining(etaCalculator.getETA());
            lastEtaUpdate = now;
          }
        });
      };

      ffmpegService.setProgressCallback(progressCallback);
      ffmpegService.setStatusCallback(setConversionStatusMessage);

      const blob = await convertVideo(
        file,
        settings.format,
        {
          quality: settings.quality,
          scale: settings.scale,
        },
        videoMetadata() ?? undefined
      );

      clearConversionCallbacks();
      if (memoryCheckTimer) {
        clearInterval(memoryCheckTimer);
        memoryCheckTimer = null;
      }

      const duration = Date.now() - conversionStartTime();
      logger.info('conversion', 'Conversion completed successfully', {
        duration: `${(duration / 1000).toFixed(2)}s`,
        outputSize: blob.size,
      });

      const resultId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      setConversionResults((results) => {
        const newResults = [
          {
            id: resultId,
            outputBlob: blob,
            originalName: file.name,
            originalSize: file.size,
            createdAt: Date.now(),
            settings: settings,
            // biome-ignore lint/suspicious/noExplicitAny: Blob metadata attached dynamically by FFmpegService
            wasTranscoded: (blob as any).wasTranscoded,
            originalCodec: videoMetadata()?.codec,
          },
          ...results,
        ];
        return newResults.slice(0, MAX_RESULTS);
      });
      setAppState('done');
      setConversionStatusMessage('');
      setConversionStartTime(0);
      // Move focus to download button for keyboard users and screen readers
      queueMicrotask(() => {
        document.querySelector<HTMLButtonElement>('[data-download-button]')?.focus();
      });
    } catch (error) {
      clearConversionCallbacks();
      if (memoryCheckTimer) {
        clearInterval(memoryCheckTimer);
        memoryCheckTimer = null;
      }
      setConversionStatusMessage('');
      setConversionStartTime(0);

      const errorMessage_ = error instanceof Error ? error.message : 'Conversion failed';

      // Check if the error is due to user cancellation
      if (
        errorMessage_.includes('cancelled by user') ||
        errorMessage_.includes('called FFmpeg.terminate()')
      ) {
        // User cancelled - just return to idle without showing error
        setAppState('idle');
        return;
      }

      const context = classifyConversionError(
        errorMessage_,
        videoMetadata(),
        settings,
        ffmpegService.getRecentFFmpegLogs()
      );

      logger.error('conversion', 'Conversion failed', {
        error: errorMessage_,
        settings,
        errorType: context.type,
      });

      setErrorMessage(context.originalError);
      setErrorContext(context);
      setAppState('error');
      // Move focus to retry button for keyboard users and screen readers
      queueMicrotask(() => {
        document.querySelector<HTMLButtonElement>('[data-error-retry-button]')?.focus();
      });
    }
  };

  const handleReset = () => {
    resetConversionRuntimeState();
    resetErrorState();
    setInputFile(null);
    resetAnalysisState();
    resetOutputState();
    setConversionSettings(DEFAULT_CONVERSION_SETTINGS);
    void ffmpegService.clearCachedInput();
    setAppState('idle');
  };

  const handleCancelConversion = () => {
    ffmpegService.cancelConversion();
    clearConversionCallbacks();
    resetConversionRuntimeState();
    setAppState('idle');
  };

  const handleRetry = () => {
    const file = inputFile();
    if (file && appState() === 'error') {
      handleFileSelected(file);
    } else {
      handleReset();
    }
  };

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

        <main class="flex-1 max-w-6xl mx-auto w-full px-4 py-8">
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
                  High browser memory usage detected (&gt;80% of JS heap). Close other heavy tabs or
                  switch to Low quality and 50% scale to reduce failure risk.
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
