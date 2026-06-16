// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import { ffmpegService } from '@services/cpu-path/ffmpeg-pipeline-service';
import {
  cancelConversion,
  convertVideo,
} from '@services/orchestration/conversion-orchestrator-service';
import { showConfirmation } from '@stores/confirmation-store';
import {
  conversionSettings,
  DEFAULT_CONVERSION_SETTINGS,
  setConversionSettings,
} from '@stores/conversion-settings-store';
import {
  appState,
  inputFile,
  MAX_RESULTS,
  setAppState,
  setConversionResults,
  setConversionStatusMessage,
  setErrorContext,
  setErrorMessage,
  setInputFile,
  setLoadingProgress,
  setLoadingStatusMessage,
  setVideoMetadata,
  setVideoPreviewUrl,
  videoMetadata,
  videoPreviewUrl,
} from '@stores/conversion-store';
import type { ConversionResult, ConversionSettings } from '@t/conversion-types';
import { isCancellationError } from '@utils/cancellation-context';
import { classifyConversionError } from '@utils/classify-conversion-error';
import { focusElement } from '@utils/dom-utils';
import { getErrorMessage } from '@utils/error-utils';
import { validateVideoDuration } from '@utils/file-validation';
import { createId } from '@utils/format-utils';
import { logger } from '@utils/logger';
import { batch } from 'solid-js';

import type { ConversionRuntimeController } from './use-conversion-runtime-controller';
import { handleFileSelected } from './use-handle-file-selected';

const MS_PER_SECOND = 1000;

const focusDownloadButton = (): void => focusElement('[data-testid="download-result-button"]');
const focusRetryButton = (): void => focusElement('[data-error-retry-button]');

export async function handleConvert(runtime: ConversionRuntimeController): Promise<void> {
  const file = inputFile();
  if (!file) {
    return;
  }

  const settings = conversionSettings();

  try {
    const durationValidation = await validateVideoDuration(file, settings.format);
    const needsConfirmation = durationValidation.warnings.some(
      (warning) => warning.requiresConfirmation
    );

    if (needsConfirmation) {
      return new Promise<void>((resolve) => {
        showConfirmation(
          durationValidation.warnings,
          () => {
            resolve();
            void performConversion(file, settings, runtime, durationValidation.duration).catch(
              (error) =>
                logger.error('conversion', 'Post-confirmation conversion failed', {
                  error: getErrorMessage(error),
                })
            );
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

async function performConversion(
  file: File,
  settings: ConversionSettings,
  runtime: ConversionRuntimeController,
  videoDurationMs?: number
): Promise<void> {
  const { isActive, runId } = runtime.startNewRun();

  try {
    setAppState('converting');
    setConversionStatusMessage('');
    const startTimeMs = performance.now();
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

    const result = await convertVideo({
      file,
      format: settings.format,
      options: {
        quality: settings.quality,
        scale: settings.scale,
        duration: videoDurationMs ? videoDurationMs / MS_PER_SECOND : undefined,
        trimStart: settings.trimStart > 0 ? settings.trimStart : undefined,
        trimEnd: settings.trimEnd > 0 ? settings.trimEnd : undefined,
      },
      metadata: videoMetadata() ?? undefined,
      onProgress: progressCallback,
      onStatus: statusCallback,
    });

    if (!isActive()) {
      return;
    }

    const blob = result.blob;

    runtime.stopMemoryMonitoring();

    const duration = Math.max(0, performance.now() - startTimeMs);
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
      createdAt: performance.now(),
      settings,
      conversionDurationSeconds: durationSeconds,
      wasTranscoded: blob.wasTranscoded,
      originalCodec: videoMetadata()?.codec,
    };

    setConversionResults((results) => [newResult, ...results].slice(0, MAX_RESULTS));

    batch(() => {
      setAppState('done');
      setConversionStatusMessage('');
      runtime.resetTimingState();
    });

    focusDownloadButton();
  } catch (error) {
    if (!isActive()) {
      return;
    }

    try {
      runtime.stopMemoryMonitoring();
    } catch (timerError) {
      logger.warn('conversion', 'Error clearing memory timer', {
        error: getErrorMessage(timerError),
      });
    }

    const errorMessage_ = getErrorMessage(error) || 'Conversion failed';

    if (isCancellationError(error)) {
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

    focusRetryButton();
  }
}

export function handleCancelConversion(runtime: ConversionRuntimeController): void {
  runtime.invalidateActiveConversions();
  setAppState('cancelling');

  // queueMicrotask ensures UI renders the cancelling state before cleanup begins
  queueMicrotask(() => {
    cancelConversion();
    runtime.resetRuntimeState();
    setAppState('idle');
  });
}

/**
 * Cancel during FFmpeg download phase.
 * Resets input state so the user can start fresh with a different file.
 */
export function handleCancelFFmpegLoad(): void {
  setAppState('cancelling');

  queueMicrotask(() => {
    cancelConversion();

    setInputFile(null);
    const url = videoPreviewUrl();
    if (url) URL.revokeObjectURL(url);
    setVideoPreviewUrl(null);
    setLoadingProgress(0);
    setLoadingStatusMessage('');
    setAppState('idle');
  });
}

/**
 * Cancel during video analysis phase.
 * Resets input state so the user can start fresh with a different file.
 */
export function handleCancelAnalysis(): void {
  setAppState('cancelling');

  queueMicrotask(() => {
    cancelConversion();

    setInputFile(null);
    const url = videoPreviewUrl();
    if (url) URL.revokeObjectURL(url);
    setVideoPreviewUrl(null);
    setVideoMetadata(null);
    setLoadingProgress(0);
    setLoadingStatusMessage('');
    setAppState('idle');
  });
}

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
    setVideoMetadata(null);

    setLoadingProgress(0);
    setLoadingStatusMessage('');

    setConversionSettings(DEFAULT_CONVERSION_SETTINGS);
    setAppState('idle');
  });

  void ffmpegService.clearCachedInput().catch((error) =>
    logger.debug('ffmpeg', 'Non-critical: clearCachedInput failed', {
      error: getErrorMessage(error),
    })
  );
}

export function handleRetry(runtime: ConversionRuntimeController): void {
  const file = inputFile();
  if (file && appState() === 'error') {
    void handleFileSelected(file, runtime).catch((error) =>
      logger.error('conversion', 'Retry file selection failed', { error: getErrorMessage(error) })
    );
  } else {
    handleReset(runtime);
  }
}

export function handleDismissError(): void {
  logger.info('general', 'User dismissed error message');
  setErrorMessage(null);
  setErrorContext(null);
  setAppState('idle');
}
