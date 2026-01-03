import { type Component, createSignal, onMount, Show } from 'solid-js';
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
  conversionProgress,
  conversionSettings,
  conversionStatusMessage,
  type ErrorContext,
  errorContext,
  errorMessage,
  inputFile,
  outputBlob,
  performanceWarnings,
  setConversionProgress,
  setConversionSettings,
  setConversionStatusMessage,
  setErrorContext,
  setErrorMessage,
  setInputFile,
  setOutputBlob,
  setPerformanceWarnings,
  setVideoMetadata,
  videoMetadata,
} from './stores/conversion-store';
import type { VideoMetadata } from './types/conversion-types';
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

  const handleFileSelected = async (file: File) => {
    resetConversionRuntimeState();
    resetErrorState();
    setOutputBlob(null);
    setVideoMetadata(null);
    setPerformanceWarnings([]);
    setLoadingProgress(0);

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
        await ffmpegService.initialize((progress) => {
          setLoadingProgress(progress);
        });
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
      console.warn('[App] handleConvert: No input file');
      return;
    }

    console.log(
      '[App] Starting conversion - file:',
      file.name,
      'format:',
      conversionSettings().format,
      'quality:',
      conversionSettings().quality,
      'scale:',
      conversionSettings().scale
    );

    try {
      setAppState('converting');
      setConversionProgress(0);
      setConversionStatusMessage('');
      setConversionStartTime(Date.now());
      setErrorContext(null);
      setOutputBlob(null);
      console.log('[App] State set to converting, progress reset to 0, startTime:', Date.now());

      // Set up progress callback for conversion
      ffmpegService.setProgressCallback((progress) => {
        console.log('[App] Progress callback received:', progress);
        setConversionProgress(progress);
      });

      // Set up status message callback
      ffmpegService.setStatusCallback((message) => {
        console.log('[App] Status callback received:', message);
        setConversionStatusMessage(message);
      });

      const blob = await convertVideo(file, conversionSettings().format, {
        quality: conversionSettings().quality,
        scale: conversionSettings().scale,
      });

      console.log('[App] Conversion completed, blob size:', blob.size);

      // Clear progress and status callbacks after conversion
      ffmpegService.setProgressCallback(null);
      ffmpegService.setStatusCallback(null);

      setOutputBlob(blob);
      setAppState('done');
      setConversionStatusMessage('');
      setConversionStartTime(0);
      console.log('[App] State set to done');
    } catch (error) {
      console.error('[App] Conversion error:', error);
      ffmpegService.setProgressCallback(null);
      ffmpegService.setStatusCallback(null);
      setConversionStatusMessage('');
      setConversionStartTime(0);

      // Classify error and set suggestion
      const errorMessage_ = error instanceof Error ? error.message : 'Conversion failed';
      const context = classifyConversionError(errorMessage_, file, videoMetadata());

      console.warn('[App] Error classified as:', context.type, 'Suggestion:', context.suggestion);

      setErrorMessage(context.originalError);
      setErrorContext(context);
      setAppState('error');
    }
  };

  /**
   * Classify conversion errors and provide suggestions
   */
  const classifyConversionError = (
    errorMsg: string,
    _file: File,
    metadata: VideoMetadata | null
  ): ErrorContext => {
    const timestamp = Date.now();
    const baseContext = { timestamp, originalError: errorMsg };

    // Timeout errors
    if (errorMsg.includes('timed out') || errorMsg.includes('90s') || errorMsg.includes('hung')) {
      return {
        type: 'timeout',
        ...baseContext,
        suggestion:
          'The conversion took too long. Try reducing the quality setting to "low" or the scale to 0.5, or choose a shorter video.',
      };
    }

    // Memory errors (including "memory access out of bounds" from ffmpeg.wasm issues)
    if (
      errorMsg.includes('memory') ||
      errorMsg.includes('Out of memory') ||
      errorMsg.includes('abort') ||
      errorMsg.includes('stack overflow')
    ) {
      return {
        type: 'memory',
        ...baseContext,
        suggestion:
          'Your browser ran out of memory or encountered a memory issue. Try using a smaller video file, reducing quality to "low", or scaling down the resolution.',
      };
    }

    // Codec/format errors
    if (
      errorMsg.includes('codec') ||
      errorMsg.includes('unsupported') ||
      errorMsg.includes('not found')
    ) {
      return {
        type: 'codec',
        ...baseContext,
        suggestion:
          'The video format or codec is not supported. Try converting the video to H.264/MP4 format first using another tool.',
      };
    }

    // WebP specific issues
    if (errorMsg.includes('webp') || errorMsg.includes('libwebp')) {
      return {
        type: 'format',
        ...baseContext,
        suggestion:
          'WebP conversion failed. Try using GIF format instead, or reduce the quality/scale settings.',
      };
    }

    // Worker/threading issues (common ffmpeg.wasm problem)
    if (
      errorMsg.includes('worker') ||
      errorMsg.includes('thread') ||
      errorMsg.includes('cors') ||
      errorMsg.includes('cross-origin') ||
      errorMsg.includes('SharedArrayBuffer')
    ) {
      return {
        type: 'general',
        ...baseContext,
        suggestion:
          'Worker or cross-origin isolation issue. Ensure your server has proper COOP/COEP headers configured. Try refreshing the page or using a different browser.',
      };
    }

    // General error with performance context
    if (metadata) {
      const totalPixels = metadata.width * metadata.height * metadata.framerate * metadata.duration;
      if (totalPixels > 500_000_000) {
        return {
          type: 'memory',
          ...baseContext,
          suggestion:
            'The video is too complex to convert in your browser (very high total pixel count). Try reducing quality to "low", scale to 0.5, or choosing a shorter/lower resolution video.',
        };
      }
    }

    // Default general error with common solutions
    return {
      type: 'general',
      ...baseContext,
      suggestion:
        'An unexpected error occurred. Try: 1) Reducing quality to "low" or scale to 0.5, 2) Using a different video file, 3) Reloading the page, or 4) Closing other browser tabs.',
    };
  };

  const handleReset = () => {
    resetConversionRuntimeState();
    resetErrorState();
    setInputFile(null);
    setVideoMetadata(null);
    setConversionSettings({
      format: 'gif',
      quality: 'medium',
      scale: 1.0,
    });
    setPerformanceWarnings([]);
    setOutputBlob(null);
    setLoadingProgress(0);
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

        {/* File dropzone - only show when no file selected */}
        <Show when={!inputFile() && appState() !== 'converting' && appState() !== 'done'}>
          <FileDropzone onFileSelected={handleFileSelected} />
        </Show>

        {/* Loading states */}
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
        <Show
          when={
            inputFile() && videoMetadata() && appState() !== 'converting' && appState() !== 'done'
          }
        >
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
        <Show when={appState() !== 'converting' && appState() !== 'done'}>
          <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6">
            <FormatSelector
              value={conversionSettings().format}
              onChange={(format) => setConversionSettings({ ...conversionSettings(), format })}
              disabled={!videoMetadata()}
            />

            <QualitySelector
              value={conversionSettings().quality}
              onChange={(quality) => setConversionSettings({ ...conversionSettings(), quality })}
              disabled={!videoMetadata()}
            />

            <ScaleSelector
              value={conversionSettings().scale}
              inputMetadata={videoMetadata()}
              onChange={(scale) => setConversionSettings({ ...conversionSettings(), scale })}
              disabled={!videoMetadata()}
            />

            <div class="flex gap-3">
              <button
                type="button"
                disabled={!videoMetadata() || appState() !== 'idle'}
                class="flex-1 inline-flex justify-center items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-offset-gray-900 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleConvert}
              >
                Convert
              </button>
              <Show when={inputFile()}>
                <button
                  type="button"
                  class="inline-flex justify-center items-center px-4 py-2 border border-gray-300 dark:border-gray-700 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 dark:focus:ring-offset-gray-900"
                  onClick={handleReset}
                >
                  Cancel
                </button>
              </Show>
            </div>
          </div>
        </Show>

        {/* Converting state */}
        <Show when={appState() === 'converting'}>
          <ConversionProgress
            progress={conversionProgress()}
            status="Converting video..."
            statusMessage={conversionStatusMessage()}
            showElapsedTime={true}
            startTime={conversionStartTime()}
          />
        </Show>

        {/* Result preview */}
        <Show when={appState() === 'done' && outputBlob()}>
          <ResultPreview
            outputBlob={outputBlob()!}
            originalSize={inputFile()?.size ?? 0}
            onReset={handleReset}
          />
        </Show>
      </main>

      <LicenseAttribution />
    </div>
  );
};

export default App;
