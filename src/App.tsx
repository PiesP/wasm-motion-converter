import { type Component, For, createMemo, createSignal, onMount, Show } from 'solid-js';
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
import { checkPerformance } from './services/performance-checker';
import { analyzeVideo } from './services/video-analyzer';
import {
  appState,
  environmentSupported,
  loadingProgress,
  setAppState,
  setEnvironmentSupported,
  setLoadingProgress,
} from './stores/app-store';
import {
  conversionResults,
  conversionProgress,
  conversionSettings,
  conversionStatusMessage,
  DEFAULT_CONVERSION_SETTINGS,
  errorContext,
  errorMessage,
  inputFile,
  performanceWarnings,
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
import { classifyConversionError } from './utils/classify-conversion-error';
import { validateVideoFile } from './utils/file-validation';

const App: Component = () => {
  const [conversionStartTime, setConversionStartTime] = createSignal<number>(0);
  onMount(() => {
    const isSupported = typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated === true;
    setEnvironmentSupported(isSupported);
  });

  const resetConversionRuntimeState = () => {
    setConversionProgress(0);
    setConversionStatusMessage('');
    setConversionStartTime(0);
  };

  const resetErrorState = () => {
    setErrorMessage(null);
    setErrorContext(null);
  };

  const resetAnalysisState = () => {
    setVideoMetadata(null);
    setPerformanceWarnings([]);
  };

  const resetOutputState = () => {
    setLoadingProgress(0);
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
      return;
    }

    setInputFile(file);

    try {
      if (!ffmpegService.isLoaded()) {
        setAppState('loading-ffmpeg');
        await ffmpegService.initialize(setLoadingProgress);
      }

      setAppState('analyzing');
      const metadata = await analyzeVideo(file);
      setVideoMetadata(metadata);

      const warnings = checkPerformance(file, metadata);
      setPerformanceWarnings(warnings);

      setAppState('idle');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unknown error occurred');
      setAppState('error');
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

      ffmpegService.setProgressCallback(setConversionProgress);
      ffmpegService.setStatusCallback(setConversionStatusMessage);

      const blob = await convertVideo(file, settings.format, {
        quality: settings.quality,
        scale: settings.scale,
      });

      clearConversionCallbacks();
      const resultId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      setConversionResults((results) => [
        {
          id: resultId,
          outputBlob: blob,
          originalName: file.name,
          originalSize: file.size,
          createdAt: Date.now(),
        },
        ...results,
      ]);
      setAppState('done');
      setConversionStatusMessage('');
      setConversionStartTime(0);
    } catch (error) {
      clearConversionCallbacks();
      setConversionStatusMessage('');
      setConversionStartTime(0);

      const errorMessage_ = error instanceof Error ? error.message : 'Conversion failed';
      const context = classifyConversionError(errorMessage_, videoMetadata());

      setErrorMessage(context.originalError);
      setErrorContext(context);
      setAppState('error');
    }
  };

  const handleReset = () => {
    resetConversionRuntimeState();
    resetErrorState();
    setInputFile(null);
    resetAnalysisState();
    resetOutputState();
    setConversionSettings(DEFAULT_CONVERSION_SETTINGS);
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
      };
    }
    return null;
  });

  const isBusy = createMemo(
    () =>
      appState() === 'loading-ffmpeg' ||
      appState() === 'analyzing' ||
      appState() === 'converting'
  );

  return (
    <div class="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col transition-colors">
      <header class="bg-white dark:bg-gray-900 shadow-sm dark:shadow-gray-800 border-b border-gray-200 dark:border-gray-800">
        <div class="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div class="flex-1">
            <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Motion Converter</h1>
            <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">
              Convert videos to animated GIF or WebP images
            </p>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main class="flex-1 max-w-4xl mx-auto w-full px-4 py-8">
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

        <FileDropzone
          onFileSelected={handleFileSelected}
          disabled={isBusy()}
          status={dropzoneStatus()?.label}
          progress={dropzoneStatus()?.progress}
          statusMessage={dropzoneStatus()?.message}
          showElapsedTime={dropzoneStatus()?.showElapsedTime}
          startTime={dropzoneStatus()?.startTime}
        />

        <Show when={appState() === 'loading-ffmpeg'}>
          <ConversionProgress
            progress={loadingProgress()}
            status="Loading FFmpeg (~30MB download)..."
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
            <InlineWarningBanner warnings={performanceWarnings()} />
          </Show>
        </Show>

        {/* Conversion settings - ALWAYS visible (from first screen) */}
        <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6">
          <div class="flex gap-3 mb-6">
            <button
              type="button"
              disabled={!videoMetadata() || isBusy()}
              class="flex-1 inline-flex justify-center items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-offset-gray-900 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleConvert}
            >
              Convert
            </button>
            <Show when={inputFile()}>
              <button
                type="button"
                disabled={isBusy()}
                class="inline-flex justify-center items-center px-4 py-2 border border-gray-300 dark:border-gray-700 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 dark:focus:ring-offset-gray-900 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleReset}
              >
                Cancel
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

        {/* Result previews */}
        <Show when={conversionResults().length > 0}>
          <div class="mt-8 space-y-6">
            <For each={conversionResults()}>
              {(result) => (
                <ResultPreview
                  outputBlob={result.outputBlob}
                  originalName={result.originalName}
                  originalSize={result.originalSize}
                />
              )}
            </For>
          </div>
        </Show>
      </main>

      <LicenseAttribution />
    </div>
  );
};

export default App;
