// Eagerly loaded components (used immediately)
import ConfirmationModal from '@components/ConfirmationModal';
import DevConversionMatrixTest from '@components/DevConversionMatrixTest';
import DevRouteOverrides from '@components/DevRouteOverrides';
import EnvironmentWarning from '@components/EnvironmentWarning';
import ExportLogsButton from '@components/ExportLogsButton';
import FileDropzone from '@components/FileDropzone';
import FormatSelector from '@components/FormatSelector';
import LicenseAttribution from '@components/LicenseAttribution';
import LoadingOverlay from '@components/LoadingOverlay';
import { OfflineBanner } from '@components/OfflineBanner';
import QualitySelector from '@components/QualitySelector';
import ScaleSelector from '@components/ScaleSelector';
import ThemeToggle from '@components/ThemeToggle';
import Button from '@components/ui/button';
import Panel from '@components/ui/panel';
import VideoMetadataDisplay from '@components/VideoMetadataDisplay';
import {
  isPreloadComplete,
  type PreloadProgress,
  preloadAllDependencies,
} from '@services/cdn/unified-preloader';
import {
  getConversionAutoSelectionDebug,
  getConversionPhaseTimingsDebug,
} from '@services/orchestration/conversion-debug';
import { conversionMetricsService } from '@services/orchestration/conversion-metrics-service';
import {
  clearDevConversionOverrides,
  getDevConversionOverrides,
  setDevConversionOverrides,
} from '@services/orchestration/dev-conversion-overrides';
import { strategyHistoryService } from '@services/orchestration/strategy-history-service';
import { strategyRegistryService } from '@services/orchestration/strategy-registry-service';
import { isLikelyFirstVisit } from '@services/sw/sw-readiness';
import { extendedCapabilityService } from '@services/video-pipeline/extended-capability-service';
import {
  appState,
  environmentSupported,
  loadingProgress,
  loadingStatusMessage,
  setEnvironmentSupported,
} from '@stores/app-store';
import { showConfirmation } from '@stores/confirmation-store';
import { errorContext, errorMessage } from '@stores/conversion-error-store';
import { inputFile, videoMetadata, videoPreviewUrl } from '@stores/conversion-media-store';
import { conversionProgress, conversionStatusMessage } from '@stores/conversion-progress-store';
import { conversionResults } from '@stores/conversion-result-store';
import {
  conversionSettings,
  saveConversionSettings,
  setConversionSettings,
} from '@stores/conversion-settings-store';
import { devMatrixTestIsRunning, requestDevMatrixTestCancel } from '@stores/dev-matrix-test-store';
import { useNetworkState } from '@stores/network-store';
import { INITIAL_DOWNLOAD_ESTIMATE_BYTES } from '@utils/constants';
import { debounce } from '@utils/debounce';
import { getErrorMessage } from '@utils/error-utils';
import { formatBytes } from '@utils/format-bytes';
import { isHardwareCacheValid } from '@utils/hardware-profile';
import { logger } from '@utils/logger';
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

// Lazy loaded components (conditionally shown - reduces initial bundle by ~15KB)
const ConversionProgress = lazy(() => import('@components/ConversionProgress'));
const ErrorDisplay = lazy(() => import('@components/ErrorDisplay'));
const MemoryWarning = lazy(() => import('@components/MemoryWarning'));
const ResultPreview = lazy(() => import('@components/ResultPreview'));

interface StatusAlertsProps {
  environmentSupported: boolean;
  showError: boolean;
  errorMessage: string | null;
  errorContext: { suggestion?: string; type?: string } | null;
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

      <Show when={props.showError && props.errorMessage}>
        <Suspense
          fallback={<div class="animate-pulse h-32 bg-gray-100 dark:bg-gray-800 rounded-lg" />}
        >
          <ErrorDisplay
            message={props.errorMessage!}
            suggestion={props.errorContext?.suggestion}
            errorType={props.errorContext?.type as never}
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
  conversionSettings: typeof conversionSettings extends () => infer T ? T : never;
  videoMetadata: typeof videoMetadata extends () => infer T ? T : never;
  onConvert: () => void;
  onCancel: () => void;
  onFormatChange: (
    format: typeof conversionSettings extends () => infer T
      ? T extends { format: infer F }
        ? F
        : never
      : never
  ) => void;
  onQualityChange: (
    quality: typeof conversionSettings extends () => infer T
      ? T extends { quality: infer Q }
        ? Q
        : never
      : never
  ) => void;
  onScaleChange: (
    scale: typeof conversionSettings extends () => infer T
      ? T extends { scale: infer S }
        ? S
        : never
      : never
  ) => void;
  devMatrixTestIsRunning: boolean;
  onRequestDevCancel: () => void;
}

const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  return (
    <Panel class="p-6">
      <div class="flex gap-3 mb-6">
        <Show
          when={props.isConverting}
          fallback={
            <Button
              disabled={!props.videoMetadata || props.isBusy}
              ariaLabel="Convert video to animated image"
              class="flex-1"
              onClick={props.onConvert}
            >
              Convert
            </Button>
          }
        >
          <Button
            variant="danger"
            ariaLabel="Stop video conversion"
            class="flex-1"
            onClick={() => {
              if (props.devMatrixTestIsRunning) {
                props.onRequestDevCancel();
              }
              props.onCancel();
            }}
          >
            {props.devMatrixTestIsRunning ? 'Stop Test' : 'Stop Conversion'}
          </Button>
        </Show>
      </div>

      <FormatSelector
        value={props.conversionSettings.format}
        onChange={props.onFormatChange}
        disabled={!props.videoMetadata || props.isBusy}
        tooltip="GIF works everywhere, WebP is smaller but requires modern browsers"
      />

      <QualitySelector
        value={props.conversionSettings.quality}
        onChange={props.onQualityChange}
        disabled={!props.videoMetadata || props.isBusy}
        tooltip="Higher quality = larger file size and slower conversion"
      />

      <ScaleSelector
        value={props.conversionSettings.scale}
        inputMetadata={props.videoMetadata}
        onChange={props.onScaleChange}
        disabled={!props.videoMetadata || props.isBusy}
        tooltip="Reduce dimensions to decrease file size and speed up conversion"
      />

      <DevRouteOverrides disabled={props.isBusy} />
      <DevConversionMatrixTest disabled={props.isBusy} />
    </Panel>
  );
};

interface ResultSectionProps {
  results: typeof conversionResults extends () => infer T ? T : never;
}

const ResultSection: Component<ResultSectionProps> = (props) => {
  return (
    <Show when={props.results.length > 0}>
      <div class="mt-8 space-y-6">
        <For each={props.results}>
          {(result) => (
            <Suspense
              fallback={<div class="animate-pulse h-96 bg-gray-100 dark:bg-gray-800 rounded-lg" />}
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
  );
};

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

  // Preload state
  const [preloadComplete, setPreloadComplete] = createSignal(false);
  const [preloadStatus, setPreloadStatus] = createSignal('Initializing...');
  const [preloadProgress, setPreloadProgress] = createSignal(0);
  const [preloadStatusMessage, setPreloadStatusMessage] = createSignal<string | undefined>(
    undefined
  );

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

  // Initialize network state monitoring for offline support
  useNetworkState();

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
   * - Preloads all external dependencies with unified preloader
   * - Shows loading overlay until preload completes
   * - Extended capability detection runs after preload
   */
  const startPreload = (): void => {
    // Handle preload progress updates
    const handlePreloadProgress = (progress: PreloadProgress): void => {
      switch (progress.phase) {
        case 'waiting-sw':
          setPreloadStatus('Preparing app...');
          setPreloadStatusMessage('Waiting for Service Worker');
          setPreloadProgress(0);
          break;
        case 'downloading':
          setPreloadStatus(`Loading ${progress.currentFile}...`);
          setPreloadStatusMessage(`${progress.completedFiles}/${progress.totalFiles} files loaded`);
          setPreloadProgress(progress.percentage);
          break;
        case 'initializing-ffmpeg':
          setPreloadStatus('Initializing FFmpeg runtime...');
          setPreloadStatusMessage(progress.currentFile);
          setPreloadProgress(progress.percentage);
          break;
        case 'validating':
          setPreloadStatus('Validating assets...');
          setPreloadProgress(95);
          break;
        case 'complete':
          setPreloadStatus('Ready!');
          setPreloadStatusMessage(undefined);
          setPreloadProgress(100);
          // Delay hiding overlay for visual feedback
          setTimeout(() => setPreloadComplete(true), 500);
          break;
        case 'error':
          setPreloadStatus('Loading failed');
          setPreloadStatusMessage(progress.error);
          // Still allow app usage on error
          setTimeout(() => setPreloadComplete(true), 2000);
          break;
      }
    };

    // Start preloading all dependencies
    void preloadAllDependencies(handlePreloadProgress).catch((error) => {
      logger.error('general', 'Preload failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Allow app usage even on preload failure
      setPreloadComplete(true);
    });
  };

  const requestInitialDownload = (): void => {
    if (isPreloadComplete() || preloadComplete()) {
      setPreloadComplete(true);
      return;
    }

    const estimatedBytes = INITIAL_DOWNLOAD_ESTIMATE_BYTES;
    const estimatedSize = formatBytes(estimatedBytes);

    showConfirmation(
      [
        {
          severity: 'info',
          message: 'Initial download required to run conversions',
          details: `About ${estimatedSize} will be downloaded and cached for offline use.`,
          suggestedAction: 'Continue when you are ready to download.',
          requiresConfirmation: true,
        },
      ],
      () => {
        startPreload();
      },
      () => {
        logger.info('general', 'User postponed initial download');
        setPreloadComplete(true);
      },
      {
        title: 'Download Required',
        confirmLabel: 'Download Now',
        cancelLabel: 'Not Now',
      }
    );
  };

  onMount(() => {
    const isSupported = typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated === true;
    setEnvironmentSupported(isSupported);

    // Validate hardware profile and invalidate caches if hardware changed
    if (!isHardwareCacheValid()) {
      logger.info('general', 'Hardware profile changed or first run, cache invalidated');
    }

    if (isLikelyFirstVisit()) {
      requestInitialDownload();
    } else {
      startPreload();
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
            webcodecsDecode: caps.webcodecsDecode,
            offscreenCanvas: caps.offscreenCanvas,
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
              metrics: () => conversionMetricsService.getAll(),
              metricsSummary: () => conversionMetricsService.getSummary(),
              clearMetrics: () => conversionMetricsService.clear(),
              devOverrides: () => getDevConversionOverrides(),
              setDevOverrides: (patch: {
                forcedPath?: 'auto' | 'cpu' | 'gpu';
                disableFallback?: boolean;
                forcedGifEncoder?:
                  | 'auto'
                  | 'modern-gif'
                  | 'ffmpeg-direct'
                  | 'ffmpeg-palette'
                  | 'ffmpeg-palette-frames';
                forcedCaptureMode?: 'auto' | 'demuxer' | 'track' | 'frame-callback' | 'seek';
                disableDemuxerInAuto?: boolean;
                forcedStrategyCodec?: 'auto' | 'h264' | 'hevc' | 'av1' | 'vp8' | 'vp9' | 'unknown';
              }) => setDevConversionOverrides(patch),
              clearDevOverrides: () => clearDevConversionOverrides(),
              lastDecision: () => getConversionAutoSelectionDebug(),
              phaseTimings: () => getConversionPhaseTimingsDebug(),
              testStrategy: (codec: string, format: 'gif' | 'webp' | 'mp4') => {
                return strategyRegistryService.getStrategy({
                  codec,
                  format,
                  container: 'mp4',
                  capabilities: caps,
                });
              },
              pickVideoFile: async (accept?: string) => {
                const mod = await import('@services/dev/mp4-smoke-test');
                return mod.pickVideoFile(accept);
              },
              smokeMp4: async (
                file?: File,
                options?: {
                  targetFps?: number;
                  scale?: number;
                  maxFrames?: number;
                  captureMode?: 'auto' | 'demuxer' | 'frame-callback' | 'seek' | 'track';
                  quality?: 'low' | 'medium' | 'high';
                  validatePlayback?: boolean;
                  mountPreview?: boolean;
                  autoDownload?: boolean;
                  filename?: string;
                  playbackTimeoutMs?: number;
                }
              ) => {
                const mod = await import('@services/dev/mp4-smoke-test');
                const promise = mod.runMp4SmokeTest({ file, options });

                // Dev-only ergonomics: users often call this from the console without await.
                // Attach a handler to prevent unhandled promise rejection noise.
                promise.catch((error) => {
                  logger.error('mp4-encoder', 'MP4 smoke test failed', {
                    error: getErrorMessage(error),
                  });
                });

                return promise;
              },
              revokeObjectUrl: (url: string) => {
                const safeUrl = String(url);
                // Keep this synchronous for convenient console usage.
                try {
                  URL.revokeObjectURL(safeUrl);
                } catch {
                  // ignore
                }
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
      {/* Loading overlay - shown during preload */}
      <LoadingOverlay
        visible={!preloadComplete()}
        status={preloadStatus()}
        progress={preloadProgress()}
        statusMessage={preloadStatusMessage()}
      />

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
            <div class="flex items-center gap-2">
              <ExportLogsButton />
              <ThemeToggle />
            </div>
          </div>
        </header>

        <main id="main-content" class="flex-1 max-w-6xl mx-auto w-full px-4 py-8">
          <StatusAlerts
            environmentSupported={environmentSupported()}
            showError={appState() === 'error'}
            errorMessage={errorMessage()}
            errorContext={errorContext()}
            onRetry={handleRetry}
            onSelectNewFile={handleReset}
            onDismissError={handleDismissError}
          />

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
            <SettingsPanel
              isBusy={isBusy()}
              isConverting={appState() === 'converting'}
              conversionSettings={conversionSettings()}
              videoMetadata={videoMetadata()}
              onConvert={handleConvertWithMemoryCheck}
              onCancel={handleCancelConversion}
              onFormatChange={(format) =>
                setConversionSettings({ ...conversionSettings(), format })
              }
              onQualityChange={(quality) =>
                setConversionSettings({ ...conversionSettings(), quality })
              }
              onScaleChange={(scale) => setConversionSettings({ ...conversionSettings(), scale })}
              devMatrixTestIsRunning={import.meta.env.DEV && devMatrixTestIsRunning()}
              onRequestDevCancel={requestDevMatrixTestCancel}
            />
          </div>

          {/* Result previews */}
          <ResultSection results={conversionResults()} />
        </main>

        <LicenseAttribution />
        <ConfirmationModal />
      </div>
    </ErrorBoundary>
  );
};

export default App;
