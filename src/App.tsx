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
// Eagerly loaded components (used immediately)
import ConfirmationModal from './components/ConfirmationModal';
import EnvironmentWarning from './components/EnvironmentWarning';
import FileDropzone from './components/FileDropzone';
import FormatSelector from './components/FormatSelector';
import LicenseAttribution from './components/LicenseAttribution';
import QualitySelector from './components/QualitySelector';
import ScaleSelector from './components/ScaleSelector';
import ThemeToggle from './components/ThemeToggle';
import ToastContainer from './components/ToastContainer';
import VideoMetadataDisplay from './components/VideoMetadataDisplay';
import { useConversionHandlers } from './hooks/use-conversion-handlers';
import { ffmpegService } from './services/ffmpeg-service';
import { extendedCapabilityService } from './services/video-pipeline/extended-capability-service';
import { strategyRegistryService } from './services/orchestration/strategy-registry-service';
import { strategyHistoryService } from './services/orchestration/strategy-history-service';
import {
  appState,
  environmentSupported,
  loadingProgress,
  loadingStatusMessage,
  setEnvironmentSupported,
} from './stores/app-store';
import {
  conversionProgress,
  conversionResults,
  conversionSettings,
  conversionStatusMessage,
  errorContext,
  errorMessage,
  inputFile,
  saveConversionSettings,
  setConversionSettings,
  videoMetadata,
  videoPreviewUrl,
} from './stores/conversion-store';
import { debounce } from './utils/debounce';
import { getErrorMessage } from './utils/error-utils';
import { isHardwareCacheValid } from './utils/hardware-profile';
import { logger } from './utils/logger';
import { isMemoryCritical } from './utils/memory-monitor';

// Lazy loaded components (conditionally shown - reduces initial bundle by ~15KB)
const ConversionProgress = lazy(() => import('./components/ConversionProgress'));
const ErrorDisplay = lazy(() => import('./components/ErrorDisplay'));
const MemoryWarning = lazy(() => import('./components/MemoryWarning'));
const ResultPreview = lazy(() => import('./components/ResultPreview'));

/**
 * Main application component orchestrating the video conversion workflow
 *
 * @remarks
 * Manages the complete user journey from file selection through analysis,
 * conversion, and result preview. Implements sophisticated state management
 * with memory monitoring, error handling, and accessibility features.
 *
 * Key features:
 * - Lazy-loaded heavy components for optimal bundle size (~15KB savings)
 * - Memory monitoring with adaptive quality settings to prevent OOM errors
 * - FFmpeg asset prefetching on fast networks for improved UX
 * - Persistent conversion settings via localStorage with debounced saves
 * - Comprehensive error boundaries with user-friendly fallback UI
 * - Full WCAG accessibility with ARIA labels and keyboard navigation
 * - Responsive grid layout optimized for mobile and desktop
 *
 * @returns SolidJS component with main layout and conversion interface
 */
const App: Component = () => {
  const [conversionStartTime, setConversionStartTime] = createSignal<number>(0);
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

  /**
   * Schedule task execution during browser idle time
   *
   * @param callback - Function to execute when browser becomes idle
   * @remarks
   * Uses requestIdleCallback with 3-second timeout for modern browsers,
   * falls back to setTimeout for older browsers. Prevents blocking main
   * thread during critical rendering operations.
   */
  const runIdle = (callback: () => void): void => {
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(callback, { timeout: 3000 });
    } else {
      setTimeout(callback, 1200);
    }
  };

  /**
   * Initialize application on component mount
   *
   * @remarks
   * - Detects SharedArrayBuffer and cross-origin isolation support
   * - Checks network speed and prefetches FFmpeg assets if on 4G
   * - Uses idle scheduling to avoid blocking initial render
   */
  onMount(() => {
    const isSupported = typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated === true;
    setEnvironmentSupported(isSupported);

    // Validate hardware profile and invalidate caches if hardware changed
    if (!isHardwareCacheValid()) {
      logger.info('general', 'Hardware profile changed or first run, cache invalidated');
    }

    const connection = (navigator as Navigator & { connection?: { effectiveType?: string } })
      .connection;
    const isFastNetwork = !connection || connection.effectiveType === '4g';
    if (isFastNetwork) {
      runIdle(() => {
        void ffmpegService.prefetchCoreAssets().catch((error) => {
          logger.debug('prefetch', 'FFmpeg prefetch skipped', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
    }

    // Extended capability detection (idle-scheduled, non-blocking)
    runIdle(async () => {
      try {
        const caps = await extendedCapabilityService.detectCapabilities();

        // Log comprehensive capability matrix in dev mode
        if (import.meta.env.DEV) {
          logger.info('general', '=== Extended Video Capabilities ===');
          logger.info('general', 'Codec Decode Support', {
            h264: caps.h264,
            hevc: caps.hevc,
            av1: caps.av1,
            vp8: caps.vp8,
            vp9: caps.vp9,
          });
          logger.info('general', 'Encoder Support', {
            gif: caps.gifEncode,
            webp: caps.webpEncode,
            mp4: caps.mp4Encode,
          });
          logger.info('general', 'Hardware Features', {
            hardwareAcceleration: caps.hardwareAccelerated,
            sharedArrayBuffer: caps.sharedArrayBuffer,
            crossOriginIsolated: caps.crossOriginIsolated,
            estimatedCores: caps.hardwareDecodeCores,
          });
          logger.info('general', '=====================================');

          // Expose debug interface (dev mode only)
          if (typeof window !== 'undefined') {
            window.__EXTENDED_VIDEO_CAPS__ = caps;
            window.__CONVERSION_DEBUG__ = {
              capabilities: caps,
              strategies: strategyRegistryService.getAllStrategies(),
              history: () => strategyHistoryService.getAllHistory(),
              testStrategy: (codec: string, format: 'gif' | 'webp' | 'mp4') => {
                return strategyRegistryService.getStrategy({
                  codec,
                  format,
                  container: 'mp4',
                  capabilities: caps,
                });
              },
            };
            logger.info('general', 'Debug interface available: window.__CONVERSION_DEBUG__');
          }
        }
      } catch (error) {
        logger.warn('general', 'Extended capability detection failed (non-critical)', {
          error: getErrorMessage(error),
        });
      }
    });
  });

  /**
   * Debounced persistence of conversion settings to localStorage
   *
   * @remarks
   * Prevents excessive writes when user rapidly changes multiple settings.
   * Debounced to 500ms to balance responsiveness with write frequency.
   */
  const debouncedSaveSettings = debounce(saveConversionSettings, 500);

  onCleanup(() => {
    debouncedSaveSettings.cancel();
  });

  /**
   * Effect to persist conversion settings on change
   *
   * @remarks
   * Automatically saves user preferences to localStorage whenever
   * conversion settings are modified, with debouncing to minimize I/O.
   */

  createEffect(() => {
    const settings = conversionSettings();
    debouncedSaveSettings(settings);
  });

  /**
   * Memoized dropzone status object
   *
   * @remarks
   * Computes conversion progress UI state during active conversion,
   * returning null when not converting. Includes progress percentage,
   * elapsed time tracking, and ETA calculation.
   */
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

  /**
   * Memoized busy state computation
   *
   * @remarks
   * Determines if UI should be disabled based on app state.
   * Returns true during FFmpeg loading, video analysis, or conversion.
   */
  const isBusy = createMemo(
    () =>
      appState() === 'loading-ffmpeg' || appState() === 'analyzing' || appState() === 'converting'
  );

  /**
   * Handle reducing settings due to memory constraints
   *
   * @remarks
   * Automatically reduces quality to 'low' and scale to 0.5 when
   * memory is critical. If memory warning is displayed, dismisses it
   * and proceeds with conversion using reduced settings.
   */
  const handleReduceSettings = (): void => {
    setConversionSettings({
      ...conversionSettings(),
      quality: 'low',
      scale: 0.5,
    });
    // If showing pre-conversion warning, dismiss it and start conversion
    if (memoryWarning() && appState() !== 'converting') {
      setMemoryWarning(false);
      handleConvert();
    }
  };

  /**
   * Handle dismissing memory warning dialog
   *
   * @remarks
   * Clears the memory warning flag without starting conversion.
   * User can then manually decide to reduce settings or proceed at risk.
   */
  const handleDismissMemoryWarning = (): void => {
    setMemoryWarning(false);
  };

  /**
   * Handle conversion with memory check
   *
   * @remarks
   * Checks memory availability before starting conversion.
   * If memory is critical, shows warning dialog. Otherwise,
   * proceeds with conversion immediately.
   */
  const handleConvertWithMemoryCheck = (): void => {
    // Check memory before starting conversion
    if (isMemoryCritical()) {
      setMemoryWarning(true);
      return;
    }
    handleConvert();
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
              <h1 class="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">
                Motion Converter
              </h1>
              <p class="text-xs sm:text-sm text-gray-600 dark:text-gray-400 mt-1">
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
              <Suspense
                fallback={
                  <div class="animate-pulse h-32 bg-gray-100 dark:bg-gray-800 rounded-lg" />
                }
              >
                <ErrorDisplay
                  message={errorMessage()!}
                  suggestion={errorContext()?.suggestion}
                  errorType={errorContext()?.type}
                  onRetry={handleRetry}
                  onSelectNewFile={handleReset}
                  onDismiss={handleDismissError}
                />
              </Suspense>
            </Show>
          </div>

          <div class="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-8 lg:items-start">
            <div class="space-y-6">
              <Show when={memoryWarning()}>
                <Suspense
                  fallback={
                    <div class="animate-pulse h-24 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg" />
                  }
                >
                  <MemoryWarning
                    isDuringConversion={appState() === 'converting'}
                    onReduceSettings={handleReduceSettings}
                    onCancel={handleCancelConversion}
                    onDismiss={handleDismissMemoryWarning}
                  />
                </Suspense>
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
                previewUrl={videoPreviewUrl()}
              />

              <Show when={appState() === 'loading-ffmpeg'}>
                <Suspense
                  fallback={
                    <div class="animate-pulse h-20 bg-blue-50 dark:bg-blue-900/20 rounded-lg" />
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
                    <div class="animate-pulse h-20 bg-blue-50 dark:bg-blue-900/20 rounded-lg" />
                  }
                >
                  <ConversionProgress progress={50} status="Analyzing video..." />
                </Suspense>
              </Show>

              {/* Video metadata and warnings - show after file analysis */}
              <Show when={inputFile() && videoMetadata()}>
                <VideoMetadataDisplay
                  metadata={videoMetadata()!}
                  fileName={inputFile()!.name}
                  fileSize={inputFile()!.size}
                />
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
                      aria-label="Convert video to animated image"
                      class="flex-1 inline-flex justify-center items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-offset-gray-900 disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={handleConvertWithMemoryCheck}
                    >
                      Convert
                    </button>
                  }
                >
                  <button
                    type="button"
                    aria-label="Stop video conversion"
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
                tooltip="GIF works everywhere, WebP is smaller but requires modern browsers"
              />

              <QualitySelector
                value={conversionSettings().quality}
                onChange={(quality) => setConversionSettings({ ...conversionSettings(), quality })}
                disabled={!videoMetadata() || isBusy()}
                tooltip="Higher quality = larger file size and slower conversion"
              />

              <ScaleSelector
                value={conversionSettings().scale}
                inputMetadata={videoMetadata()}
                onChange={(scale) => setConversionSettings({ ...conversionSettings(), scale })}
                disabled={!videoMetadata() || isBusy()}
                tooltip="Reduce dimensions to decrease file size and speed up conversion"
              />
            </div>
          </div>

          {/* Result previews */}
          <Show when={conversionResults().length > 0}>
            <div class="mt-8 space-y-6">
              <For each={conversionResults()}>
                {(result) => (
                  <Suspense
                    fallback={
                      <div class="animate-pulse h-96 bg-gray-100 dark:bg-gray-800 rounded-lg" />
                    }
                  >
                    <ResultPreview
                      outputBlob={result.outputBlob}
                      originalName={result.originalName}
                      originalSize={result.originalSize}
                      settings={result.settings}
                      conversionDurationSeconds={result.conversionDurationSeconds}
                      wasTranscoded={result.wasTranscoded}
                      originalCodec={result.originalCodec}
                    />
                  </Suspense>
                )}
              </For>
            </div>
          </Show>
        </main>

        <LicenseAttribution />
        <ToastContainer />
        <ConfirmationModal />
      </div>
    </ErrorBoundary>
  );
};

export default App;
