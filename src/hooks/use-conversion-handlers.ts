import type { Setter } from 'solid-js';
import { batch } from 'solid-js';

import { convertVideo } from '../services/conversion-service';
import { ffmpegService } from '../services/ffmpeg-service';
import { checkPerformance, getRecommendedSettings } from '../services/performance-checker-service';
import { analyzeVideo, analyzeVideoQuick } from '../services/video-analyzer-service';
import {
  appState,
  setAppState,
  setLoadingProgress,
  setLoadingStatusMessage,
} from '../stores/app-store';
import { showConfirmation } from '../stores/confirmation-store';
import {
  conversionSettings,
  DEFAULT_CONVERSION_SETTINGS,
  inputFile,
  MAX_RESULTS,
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
  setVideoPreviewUrl,
  videoMetadata,
  videoPreviewUrl,
} from '../stores/conversion-store';
import { showToast } from '../stores/toast-store';
import { classifyConversionError } from '../utils/classify-conversion-error';
import { WARN_RESOLUTION_PIXELS } from '../utils/constants';
import { ETACalculator } from '../utils/eta-calculator';
import { validateVideoDuration, validateVideoFile } from '../utils/file-validation';
import { logger } from '../utils/logger';
import { isMemoryCritical } from '../utils/memory-monitor';

import type { VideoMetadata } from '../types/conversion-types';

/**
 * Small file size threshold for quick analysis bypass (50 MB)
 */
const SMALL_FILE_SIZE_THRESHOLD = 50 * 1024 * 1024;

/**
 * Short video duration threshold for quick analysis bypass (15 seconds)
 */
const SHORT_VIDEO_DURATION = 15;

/**
 * Memory check interval during conversion (5 seconds)
 */
const MEMORY_CHECK_INTERVAL = 5000;

/**
 * ETA update interval for UI throttling (1 second)
 */
const ETA_UPDATE_INTERVAL = 1000;

/**
 * Milliseconds per second conversion factor
 */
const MS_PER_SECOND = 1000;

/**
 * Options for conversion handlers hook
 */
interface ConversionHandlersOptions {
  /** Get current conversion start time in milliseconds */
  conversionStartTime: () => number;
  /** Set conversion start time in milliseconds */
  setConversionStartTime: Setter<number>;
  /** Set estimated seconds remaining for ETA display */
  setEstimatedSecondsRemaining: Setter<number | null>;
  /** Set memory warning flag */
  setMemoryWarning: Setter<boolean>;
}

/**
 * Custom hook for video conversion handlers
 *
 * Provides handlers for file selection, conversion, cancellation, reset,
 * and error management. Manages conversion state, progress tracking,
 * memory monitoring, and ETA calculation.
 *
 * @param options - Configuration options for the hook
 * @returns Object containing all conversion handler functions
 */
export function useConversionHandlers(options: ConversionHandlersOptions): {
  handleFileSelected: (file: File) => Promise<void>;
  handleConvert: () => Promise<void>;
  handleReset: () => void;
  handleCancelConversion: () => void;
  handleRetry: () => void;
  handleDismissError: () => void;
} {
  const {
    conversionStartTime,
    setConversionStartTime,
    setEstimatedSecondsRemaining,
    setMemoryWarning,
  } = options;

  let memoryCheckTimer: ReturnType<typeof setInterval> | null = null;
  let lastEtaUpdate = 0;
  const etaCalculator = new ETACalculator();

  /**
   * Determine if full video analysis is needed
   *
   * @param file - Video file to analyze
   * @param metadata - Quick metadata (if available)
   * @returns True if full analysis is required
   */
  const shouldRunFullAnalysis = (file: File, metadata: VideoMetadata | null): boolean => {
    if (!metadata) {
      return true;
    }
    if (metadata.codec === 'unknown' || metadata.framerate <= 0 || metadata.bitrate <= 0) {
      return true;
    }
    const isSmallFile = file.size <= SMALL_FILE_SIZE_THRESHOLD;
    const isShort = metadata.duration > 0 ? metadata.duration <= SHORT_VIDEO_DURATION : false;
    const isLowRes = metadata.width * metadata.height <= WARN_RESOLUTION_PIXELS;
    return !(isSmallFile && isShort && isLowRes);
  };

  /**
   * Reset conversion runtime state (progress, ETA, timers)
   */
  const resetConversionRuntimeState = (): void => {
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

  /**
   * Reset error state
   */
  const resetErrorState = (): void => {
    setErrorMessage(null);
    setErrorContext(null);
  };

  /**
   * Reset analysis state (metadata, warnings)
   */
  const resetAnalysisState = (): void => {
    setVideoMetadata(null);
    setPerformanceWarnings([]);
    setAutoAppliedRecommendation(false);
  };

  /**
   * Reset output state (loading progress)
   */
  const resetOutputState = (): void => {
    setLoadingProgress(0);
    setLoadingStatusMessage('');
  };

  /**
   * Clear FFmpeg conversion callbacks
   */
  const clearConversionCallbacks = (): void => {
    ffmpegService.setProgressCallback(null);
    ffmpegService.setStatusCallback(null);
  };

  /**
   * Handle file selection
   *
   * Validates file, initializes FFmpeg if needed, analyzes video metadata,
   * and applies recommended settings.
   *
   * @param file - Selected video file
   */
  const handleFileSelected = async (file: File): Promise<void> => {
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

    const previousPreviewUrl = videoPreviewUrl();
    if (previousPreviewUrl) {
      URL.revokeObjectURL(previousPreviewUrl);
    }
    setVideoPreviewUrl(URL.createObjectURL(file));

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

  /**
   * Handle conversion start
   *
   * Validates video duration, shows confirmation if needed,
   * and initiates the conversion process.
   */
  const handleConvert = async (): Promise<void> => {
    const file = inputFile();
    if (!file) {
      return;
    }

    const settings = conversionSettings();

    // Validate video duration before starting conversion
    try {
      const durationValidation = await validateVideoDuration(file, settings.format);

      // Check if any warnings require user confirmation
      const needsConfirmation = durationValidation.warnings.some((w) => w.requiresConfirmation);

      if (needsConfirmation) {
        // Show confirmation modal and wait for user decision
        return new Promise<void>((resolve) => {
          showConfirmation(
            durationValidation.warnings,
            () => {
              // User confirmed - proceed with conversion
              resolve();
              performConversion(file, settings, durationValidation.duration);
            },
            () => {
              // User cancelled
              logger.info('conversion', 'User cancelled conversion after duration warning');
              resolve();
            }
          );
        });
      }

      // No confirmation needed, proceed directly
      await performConversion(file, settings, durationValidation.duration);
    } catch (validationError) {
      // If validation fails, log warning but allow conversion to proceed
      logger.warn('conversion', 'Duration validation failed, proceeding anyway', {
        error: validationError instanceof Error ? validationError.message : String(validationError),
      });
      await performConversion(file, settings);
    }
  };

  /**
   * Perform the actual video conversion
   *
   * @param file - Video file to convert
   * @param settings - Conversion settings
   * @param videoDuration - Optional video duration in milliseconds
   */
  const performConversion = async (
    file: File,
    settings: ReturnType<typeof conversionSettings>,
    videoDuration?: number
  ): Promise<void> => {
    try {
      setAppState('converting');
      setConversionProgress(0);
      setConversionStatusMessage('');
      setConversionStartTime(Date.now());
      setErrorContext(null);
      etaCalculator.reset();
      setEstimatedSecondsRemaining(null);
      lastEtaUpdate = 0;
      setMemoryWarning(false);

      logger.info('conversion', 'Starting conversion', {
        format: settings.format,
        quality: settings.quality,
        scale: settings.scale,
        fileSize: file.size,
        fileName: file.name,
        duration: videoDuration ? `${(videoDuration / 1000).toFixed(1)}s` : 'unknown',
      });

      if (memoryCheckTimer) {
        clearInterval(memoryCheckTimer);
      }
      // Check memory every 5 seconds (memory issues don't develop in 2-3 seconds)
      // Reduced from 2s to minimize unnecessary overhead during conversion
      memoryCheckTimer = setInterval(() => {
        if (isMemoryCritical()) {
          setMemoryWarning(true);
        }
      }, MEMORY_CHECK_INTERVAL);

      const progressCallback = (progress: number) => {
        const now = Date.now();
        batch(() => {
          setConversionProgress(progress);
          etaCalculator.addSample(progress);
          // Throttle ETA UI updates to max 1/second to reduce reactive computation overhead
          if (now - lastEtaUpdate >= ETA_UPDATE_INTERVAL) {
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
          duration: videoDuration ? videoDuration / MS_PER_SECOND : undefined, // Convert ms to seconds
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
        duration: `${(duration / MS_PER_SECOND).toFixed(2)}s`,
        outputSize: blob.size,
      });

      const resultId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const durationSeconds = Math.max(0, duration / MS_PER_SECOND);
      setConversionResults((results) => {
        const newResults = [
          {
            id: resultId,
            outputBlob: blob,
            originalName: file.name,
            originalSize: file.size,
            createdAt: Date.now(),
            settings: settings,
            conversionDurationSeconds: durationSeconds,
            wasTranscoded: blob.wasTranscoded,
            originalCodec: videoMetadata()?.codec,
          },
          ...results,
        ];
        return newResults.slice(0, MAX_RESULTS);
      });
      setAppState('done');
      setConversionStatusMessage('');
      setConversionStartTime(0);
      showToast('Conversion complete! Click download to save.', 'success');
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

  /**
   * Handle reset to initial state
   *
   * Clears all state, revokes object URLs, and resets to default settings.
   */
  const handleReset = (): void => {
    resetConversionRuntimeState();
    resetErrorState();
    setInputFile(null);
    const previousPreviewUrl = videoPreviewUrl();
    if (previousPreviewUrl) {
      URL.revokeObjectURL(previousPreviewUrl);
    }
    setVideoPreviewUrl(null);
    resetAnalysisState();
    resetOutputState();
    setConversionSettings(DEFAULT_CONVERSION_SETTINGS);
    void ffmpegService.clearCachedInput();
    setAppState('idle');
  };

  /**
   * Handle conversion cancellation
   *
   * Cancels ongoing conversion and returns to idle state.
   */
  const handleCancelConversion = (): void => {
    ffmpegService.cancelConversion();
    clearConversionCallbacks();
    resetConversionRuntimeState();
    setAppState('idle');
  };

  /**
   * Handle retry after error
   *
   * Re-analyzes file if in error state, otherwise performs full reset.
   */
  const handleRetry = (): void => {
    const file = inputFile();
    if (file && appState() === 'error') {
      handleFileSelected(file);
    } else {
      handleReset();
    }
  };

  /**
   * Handle error dismissal
   *
   * Clears error state while preserving file, metadata, and settings.
   */
  const handleDismissError = (): void => {
    logger.info('general', 'User dismissed error message');
    resetErrorState();
    setAppState('idle');
    // inputFile, videoMetadata, and settings remain intact
    // User can now modify settings and click Convert again
  };

  return {
    handleFileSelected,
    handleConvert,
    handleReset,
    handleCancelConversion,
    handleRetry,
    handleDismissError,
  };
}
