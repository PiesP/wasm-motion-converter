import { batch, type Setter } from 'solid-js';
import { convertVideo } from '../services/conversion-service';
import { ffmpegService } from '../services/ffmpeg-service';
import { checkPerformance, getRecommendedSettings } from '../services/performance-checker';
import { analyzeVideo, analyzeVideoQuick } from '../services/video-analyzer';
import {
  appState,
  setAppState,
  setLoadingProgress,
  setLoadingStatusMessage,
} from '../stores/app-store';
import { confirmationStore } from '../stores/confirmation-store';
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
import type { VideoMetadata } from '../types/conversion-types';
import { classifyConversionError } from '../utils/classify-conversion-error';
import { WARN_RESOLUTION_PIXELS } from '../utils/constants';
import { ETACalculator } from '../utils/eta-calculator';
import { validateVideoDuration, validateVideoFile } from '../utils/file-validation';
import { logger } from '../utils/logger';
import { isMemoryCritical } from '../utils/memory-monitor';

interface ConversionHandlersOptions {
  conversionStartTime: () => number;
  setConversionStartTime: Setter<number>;
  setEstimatedSecondsRemaining: Setter<number | null>;
  setMemoryWarning: Setter<boolean>;
}

export function useConversionHandlers(options: ConversionHandlersOptions) {
  const {
    conversionStartTime,
    setConversionStartTime,
    setEstimatedSecondsRemaining,
    setMemoryWarning,
  } = options;

  let memoryCheckTimer: ReturnType<typeof setInterval> | null = null;
  let lastEtaUpdate = 0;
  const etaCalculator = new ETACalculator();

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

  const handleConvert = async () => {
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
          confirmationStore.showConfirmation(
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

  const performConversion = async (
    file: File,
    settings: ReturnType<typeof conversionSettings>,
    videoDuration?: number
  ) => {
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
      }, 5000);

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
          duration: videoDuration ? videoDuration / 1000 : undefined, // Convert ms to seconds
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
      const durationSeconds = Math.max(0, duration / 1000);
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

  const handleReset = () => {
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

  const handleDismissError = () => {
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
