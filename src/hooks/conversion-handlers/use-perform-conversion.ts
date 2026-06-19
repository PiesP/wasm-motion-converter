// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { classifyError, validateOutput } from '@services/v2/error-recovery';
import { showConfirmation } from '@stores/confirmation-store';
import {
  conversionSettings,
  DEFAULT_CONVERSION_SETTINGS,
  setConversionSettings,
} from '@stores/conversion-settings-store';
import {
  appState,
  inputBuffer,
  inputFile,
  setAppState,
  setConversionResults,
  setConversionStatusMessage,
  setErrorContext,
  setErrorMessage,
  setInputBuffer,
  setInputFile,
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
import { createId, formatBytes } from '@utils/format-utils';
import { logger } from '@utils/logger';
import { checkMemoryForConversion, getMemoryUsageMB } from '@utils/memory-monitor';
import { batch } from 'solid-js';

import type { ConversionRuntimeController } from './use-conversion-runtime-controller';
import { handleFileSelected } from './use-handle-file-selected';
import { performConversionV2, type V2ConversionOptions } from './use-perform-conversion-v2';

const MS_PER_SECOND = 1000;

const focusDownloadButton = (): void => focusElement('[data-testid="download-result-button"]');
const focusRetryButton = (): void => focusElement('[data-testid="error-retry-button"]');

export async function handleConvert(runtime: ConversionRuntimeController): Promise<void> {
  const file = inputFile();
  if (!file) {
    logger.warn('conversion', 'Convert called but no file loaded — conversion skipped', {
      appState: appState(),
      settings: conversionSettings(),
    });
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
  videoDurationMs?: number,
  signal?: AbortSignal
): Promise<void> {
  const { isActive, runId } = runtime.startNewRun();

  try {
    batch(() => {
      setAppState('converting');
      setConversionStatusMessage('');
      setConversionResults([]);
    });
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
    logger.info('conversion', '▶ Conversion handler: use-perform-conversion.ts → V2 pipeline', {
      format: settings.format,
      quality: settings.quality,
      scale: settings.scale,
    });

    runtime.startMemoryMonitoring();

    // Pre-conversion memory check for high-risk settings (high quality + full scale)
    const md = videoMetadata();
    const isHighRisk = settings.quality === 'high' && settings.scale >= 1.0;
    let forcedDecimation: number | undefined;
    if (isHighRisk && md) {
      const estFrames = md.duration > 0 ? Math.round(md.duration * (md.framerate ?? 30)) : 300;
      const outW = Math.floor(md.width * settings.scale);
      const outH = Math.floor(md.height * settings.scale);
      const memCheck = checkMemoryForConversion(outW, outH, estFrames, settings.format);
      logger.info('conversion', 'Pre-conversion memory check', {
        level: memCheck.level,
        estimatedMB: memCheck.estimatedMB,
        availableMB: memCheck.availableMB,
        width: outW,
        height: outH,
        estFrames,
      });
      if (memCheck.level === 'critical') {
        // Force decimation to reduce memory: target 15fps
        const srcFps = md.framerate ?? 30;
        forcedDecimation = Math.max(2, Math.round(srcFps / 15));
        logger.warn('conversion', 'Forcing frame decimation due to memory pressure', {
          forcedDecimation,
          estimatedMB: memCheck.estimatedMB,
          availableMB: memCheck.availableMB,
        });
      }
    }

    const v2Options: V2ConversionOptions = {
      format: settings.format,
      quality: settings.quality,
      scale: settings.scale,
      trimStart: settings.trimStart > 0 ? settings.trimStart : 0,
      trimEnd: settings.trimEnd > 0 ? settings.trimEnd : 0,
      forceDecimation: forcedDecimation,
      smartFrameSkip: settings.smartFrameSkip,
    };

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal?.addEventListener('abort', onAbort);

    const v2Result = await performConversionV2(
      file,
      v2Options,
      (v2Progress) => {
        if (!isActive()) return;
        runtime.updateProgress(v2Progress.progress, v2Progress.phase, v2Progress.outputFrames);

        // User-friendly phase messages
        const phaseLabel =
          v2Progress.phase === 'demuxing'
            ? 'Preparing video data...'
            : v2Progress.phase === 'decoding'
              ? 'Decoding...'
              : v2Progress.phase === 'encoding'
                ? `Encoding to ${settings.format.toUpperCase()}...`
                : 'Finalizing...';

        if (
          v2Progress.currentFrame != null &&
          v2Progress.totalFrames != null &&
          v2Progress.currentFrame > 0 &&
          v2Progress.totalFrames > 0
        ) {
          runtime.updateStatus(
            `Frame ${v2Progress.currentFrame}/${v2Progress.totalFrames} — ${phaseLabel}`
          );
        } else {
          runtime.updateStatus(phaseLabel);
        }
      },
      abortController.signal,
      inputBuffer() ?? undefined
    ).finally(() => {
      signal?.removeEventListener('abort', onAbort);
    });

    if (!isActive()) return;

    const blob = v2Result.blob;

    if (blob.size === 0) {
      throw new Error('Conversion produced an empty output file');
    }

    // Validate output integrity — read only the first 16 bytes to check header
    // instead of loading the entire blob into memory (avoids 2x memory for large outputs)
    const headerBuf = await blob.slice(0, 16).arrayBuffer();
    const blobData = new Uint8Array(headerBuf);
    if (!validateOutput(blobData, settings.format)) {
      const hexHeader = Array.from(blobData.slice(0, 10))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
      logger.warn('conversion', 'Output validation failed — header mismatch', {
        format: settings.format,
        size: blobData.length,
        headerHex: hexHeader,
      });
      // Note: We intentionally do NOT throw here. Some valid outputs may have
      // non-standard headers (e.g., animated WebP with VP8L codec). The user
      // can still download and use the file. If the file is truly corrupt,
      // the browser will fail to decode it naturally.
    }

    runtime.stopMemoryMonitoring();

    const duration = Math.max(0, performance.now() - startTimeMs);
    const durationSeconds = Math.max(0, duration / MS_PER_SECOND);
    const memMB = getMemoryUsageMB();
    logger.info('conversion', 'Conversion complete', {
      format: settings.format,
      quality: settings.quality,
      scale: settings.scale,
      duration: `${durationSeconds.toFixed(2)}s`,
      outputSize: blob.size,
      outputSizeFormatted: formatBytes(blob.size),
      compressionRatio: `${((blob.size / file.size) * 100).toFixed(1)}%`,
      memoryMB: memMB ?? 'N/A',
    });

    const resultId = createId();
    const newResult: ConversionResult = {
      id: resultId,
      outputBlob: blob,
      originalName: file.name,
      originalSize: file.size,
      createdAt: performance.now(),
      settings,
      conversionDurationSeconds: durationSeconds,
    };

    // setConversionResults triggers ResultSection → ResultPreview →
    // createEffect → URL.createObjectURL → setPreviewUrl → render.
    // Clear previous results first (releasing blobs), then use queueMicrotask
    // to defer the new result into a separate microtask, breaking the
    // synchronous signal cascade that could overflow the stack.
    // For large blobs (>10MB, typically GIF), the preview is skipped
    // entirely in ResultPreview to avoid URL.createObjectURL overhead.
    setConversionResults([]);

    queueMicrotask(() => {
      setConversionResults([newResult]);
    });

    batch(() => {
      setAppState('done');
      setConversionStatusMessage('');
      runtime.resetTimingState();
    });

    focusDownloadButton();
  } catch (error) {
    if (!isActive()) return;

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

    const classified = classifyError(error);
    const context = classifyConversionError(errorMessage_, videoMetadata(), settings);

    logger.error('conversion', 'Conversion failed', {
      error: errorMessage_,
      settings,
      errorType: context.type,
      errorCode: classified.code,
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
  logger.info('conversion', 'User cancelled conversion', {
    appState: appState(),
  });
  runtime.invalidateActiveConversions();
  setAppState('cancelling');

  queueMicrotask(() => {
    runtime.resetRuntimeState();
    setAppState('idle');
  });
}

export function handleCancelAnalysis(): void {
  setAppState('cancelling');

  queueMicrotask(() => {
    setInputFile(null);
    const url = videoPreviewUrl();
    if (url) URL.revokeObjectURL(url);
    setVideoPreviewUrl(null);
    setVideoMetadata(null);
    setAppState('idle');
  });
}

export function handleReset(runtime: ConversionRuntimeController): void {
  runtime.invalidateActiveConversions();
  runtime.resetRuntimeState();
  setErrorMessage(null);
  setErrorContext(null);

  setInputFile(null);
  setInputBuffer(null);

  const previousPreviewUrl = videoPreviewUrl();
  if (previousPreviewUrl) {
    URL.revokeObjectURL(previousPreviewUrl);
  }
  setVideoPreviewUrl(null);

  batch(() => {
    setVideoMetadata(null);
    setConversionSettings(DEFAULT_CONVERSION_SETTINGS);
    setAppState('idle');
  });
}

export function handleRetry(runtime: ConversionRuntimeController): void {
  const file = inputFile();
  if (file && appState() === 'error') {
    // Clear previous results immediately to avoid flash of stale content
    setConversionResults([]);
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
