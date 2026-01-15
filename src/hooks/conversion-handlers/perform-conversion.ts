import { ffmpegService } from '@services/ffmpeg-service';

import { cancelConversion, convertVideo } from '@services/orchestration/conversion-orchestrator';
import {
  appState,
  setAppState,
  setLoadingProgress,
  setLoadingStatusMessage,
} from '@stores/app-store';
import { showConfirmation } from '@stores/confirmation-store';
import { setErrorContext, setErrorMessage } from '@stores/conversion-error-store';
import {
  inputFile,
  setInputFile,
  setVideoMetadata,
  setVideoPreviewUrl,
  videoMetadata,
  videoPreviewUrl,
} from '@stores/conversion-media-store';
import {
  setAutoAppliedRecommendation,
  setPerformanceWarnings,
} from '@stores/conversion-performance-store';
import { setConversionStatusMessage } from '@stores/conversion-progress-store';
import { MAX_RESULTS, setConversionResults } from '@stores/conversion-result-store';
import {
  conversionSettings,
  DEFAULT_CONVERSION_SETTINGS,
  setConversionSettings,
} from '@stores/conversion-settings-store';
import type { ConversionResult, ConversionSettings } from '@t/conversion-types';
import { classifyConversionError } from '@utils/classify-conversion-error';
import { createId } from '@utils/create-id';
import { getErrorMessage } from '@utils/error-utils';
import { validateVideoDuration } from '@utils/file-validation';
import { logger } from '@utils/logger';
import { batch } from 'solid-js';

import type { ConversionRuntimeController } from './conversion-runtime-controller';
import { handleFileSelected } from './handle-file-selected';

/** Milliseconds per second conversion factor. */
const MS_PER_SECOND = 1000;

function clearConversionCallbacks(): void {
  ffmpegService.setProgressCallback(null);
  ffmpegService.setStatusCallback(null);
}

/**
 * Handle conversion start.
 *
 * Validates video duration, shows confirmation if needed, and initiates the conversion.
 */
export async function handleConvert(runtime: ConversionRuntimeController): Promise<void> {
  const file = inputFile();
  if (!file) {
    return;
  }

  const settings = conversionSettings();

  try {
    const durationValidation = await validateVideoDuration(file, settings.format);
    const needsConfirmation = durationValidation.warnings.some((w) => w.requiresConfirmation);

    if (needsConfirmation) {
      return new Promise<void>((resolve) => {
        showConfirmation(
          durationValidation.warnings,
          () => {
            resolve();
            void performConversion(file, settings, runtime, durationValidation.duration);
          },
          () => {
            logger.info('conversion', 'User cancelled conversion after duration warning');
            resolve();
          }
        );
      });
    }

    await performConversion(file, settings, runtime, durationValidation.duration);
  } catch (validationError) {
    logger.warn('conversion', 'Duration validation failed, proceeding anyway', {
      error: getErrorMessage(validationError),
    });
    await performConversion(file, settings, runtime);
  }
}

/**
 * Perform the actual video conversion.
 */
export async function performConversion(
  file: File,
  settings: ConversionSettings,
  runtime: ConversionRuntimeController,
  videoDurationMs?: number
): Promise<void> {
  const { isActive, runId } = runtime.startNewRun();

  try {
    setAppState('converting');
    setConversionStatusMessage('');
    const startTimeMs = Date.now();
    runtime.prepareForNewConversion(startTimeMs);
    setErrorContext(null);

    logger.info('conversion', 'UI conversion started', {
      runId,
      fileName: file.name,
      fileSizeBytes: file.size,
      format: settings.format,
      quality: settings.quality,
      scale: settings.scale,
      durationMs: videoDurationMs,
    });

    runtime.startMemoryMonitoring();

    const progressCallback = (progress: number) => {
      if (!isActive()) {
        return;
      }
      runtime.updateProgress(progress);
    };

    const statusCallback = (message: string) => {
      if (!isActive()) {
        return;
      }
      runtime.updateStatus(message);
    };

    // NOTE: FFmpeg callbacks still needed until CPU path fully migrates to pipeline abstraction.
    ffmpegService.setProgressCallback(progressCallback);
    ffmpegService.setStatusCallback(statusCallback);

    const result = await convertVideo({
      file,
      format: settings.format,
      options: {
        quality: settings.quality,
        scale: settings.scale,
        duration: videoDurationMs ? videoDurationMs / MS_PER_SECOND : undefined,
      },
      metadata: videoMetadata() ?? undefined,
      onProgress: progressCallback,
      onStatus: statusCallback,
    });

    if (!isActive()) {
      return;
    }

    const blob = result.blob;

    clearConversionCallbacks();
    runtime.stopMemoryMonitoring();

    const duration = Math.max(0, Date.now() - startTimeMs);
    logger.debug('conversion', 'Conversion result received by UI layer', {
      duration: `${(duration / MS_PER_SECOND).toFixed(2)}s`,
      outputSize: blob.size,
    });

    const resultId = createId();
    const durationSeconds = Math.max(0, duration / MS_PER_SECOND);
    const newResult: ConversionResult = {
      id: resultId,
      outputBlob: blob,
      originalName: file.name,
      originalSize: file.size,
      createdAt: Date.now(),
      settings,
      conversionDurationSeconds: durationSeconds,
      wasTranscoded: blob.wasTranscoded,
      originalCodec: videoMetadata()?.codec,
    };

    setConversionResults((results) => {
      return [newResult, ...results].slice(0, MAX_RESULTS);
    });

    batch(() => {
      setAppState('done');
      setConversionStatusMessage('');
      runtime.resetTimingState();
    });

    queueMicrotask(() => {
      document.querySelector<HTMLButtonElement>('[data-download-button]')?.focus();
    });
  } catch (error) {
    if (!isActive()) {
      return;
    }

    try {
      clearConversionCallbacks();
    } catch (callbackError) {
      logger.warn('conversion', 'Error clearing callbacks', {
        error: getErrorMessage(callbackError),
      });
    }

    try {
      runtime.stopMemoryMonitoring();
    } catch (timerError) {
      logger.warn('conversion', 'Error clearing memory timer', {
        error: getErrorMessage(timerError),
      });
    }

    const errorMessage_ = getErrorMessage(error) || 'Conversion failed';

    if (
      errorMessage_.includes('cancelled by user') ||
      errorMessage_.includes('called FFmpeg.terminate()')
    ) {
      batch(() => {
        setConversionStatusMessage('');
        runtime.resetTimingState();
        setAppState('idle');
      });
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

    batch(() => {
      setConversionStatusMessage('');
      runtime.resetTimingState();
      setErrorMessage(context.originalError);
      setErrorContext(context);
      setAppState('error');
    });

    queueMicrotask(() => {
      document.querySelector<HTMLButtonElement>('[data-error-retry-button]')?.focus();
    });
  }
}

/** Cancel the active conversion and reset UI state back to idle. */
export function handleCancelConversion(runtime: ConversionRuntimeController): void {
  runtime.invalidateActiveConversions();
  cancelConversion();
  clearConversionCallbacks();
  runtime.resetRuntimeState();
  setAppState('idle');
}

/** Reset to initial state (clears file, metadata, results, and runtime state). */
export function handleReset(runtime: ConversionRuntimeController): void {
  runtime.invalidateActiveConversions();
  runtime.resetRuntimeState();
  setErrorMessage(null);
  setErrorContext(null);

  setInputFile(null);

  const previousPreviewUrl = videoPreviewUrl();
  if (previousPreviewUrl) {
    URL.revokeObjectURL(previousPreviewUrl);
  }
  setVideoPreviewUrl(null);

  batch(() => {
    // Clear metadata and warnings but preserve results.
    // (Users may want to keep previous outputs available.)
    setVideoMetadata(null);
    setPerformanceWarnings([]);
    setAutoAppliedRecommendation(false);

    setLoadingProgress(0);
    setLoadingStatusMessage('');

    setConversionSettings(DEFAULT_CONVERSION_SETTINGS);
    setAppState('idle');
  });

  void ffmpegService.clearCachedInput();
}

/** Retry after an error by re-processing the currently selected file, if any. */
export function handleRetry(runtime: ConversionRuntimeController): void {
  const file = inputFile();
  if (file && appState() === 'error') {
    // Re-run file selection pipeline to restore metadata & warnings.
    // The UI will move back to idle on success.
    void handleFileSelected(file, runtime);
  } else {
    handleReset(runtime);
  }
}

/** Dismiss the error state while keeping the selected file and settings. */
export function handleDismissError(): void {
  logger.info('general', 'User dismissed error message');
  setErrorMessage(null);
  setErrorContext(null);
  setAppState('idle');
}
