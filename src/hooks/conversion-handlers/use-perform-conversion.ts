// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { runPipelineWithFallback } from '@services/conversion-worker/main-thread-proxy';
import { arrayBufferToHex } from '@services/conversion-worker/protocol';
import { validateOutput } from '@services/error-recovery';
import { showConfirmation } from '@stores/confirmation-store';
import {
  conversionSettings,
  DEFAULT_CONVERSION_SETTINGS,
  setConversionSettings,
} from '@stores/conversion-settings-store';
import {
  appState,
  getInputBuffer,
  inputFile,
  setAppState,
  setConversionElapsedMs,
  setConversionFps,
  setConversionResults,
  setConversionStatusMessage,
  setErrorContext,
  setErrorMessage,
  setInputBuffer,
  setInputFile,
  setVideoMetadata,
  setVideoPreviewUrl,
  transitionToState,
  videoMetadata,
  videoPreviewUrl,
} from '@stores/conversion-store';
import type {
  ConversionFormat,
  ConversionQuality,
  ConversionResult,
  ConversionScale,
  ConversionSettings,
  ProgressCallback,
  SmartFrameSkipMode,
} from '@t/conversion-types';
import type { TFunction } from '@t/i18n-types';
import { isCancellationError } from '@utils/cancellation-context';
import { classifyConversionError } from '@utils/classify-conversion-error';
import { focusElement, focusRetryButton } from '@utils/dom-utils';
import { getErrorMessage } from '@utils/error-utils';
import { validateVideoDuration } from '@utils/file-validation';
import { createId, formatBytes } from '@utils/format-utils';
import { logger } from '@utils/logger';
import { checkMemoryForConversion, getMemoryUsageMB } from '@utils/memory-monitor';
import { batch } from 'solid-js';
import type { ConversionRuntimeController } from './use-conversion-runtime-controller';
import { handleFileSelected } from './use-handle-file-selected';

export interface ConversionOptions {
  format: ConversionFormat;
  quality: ConversionQuality;
  scale: ConversionScale;
  trimStart: number;
  trimEnd: number;
  /** Force frame decimation (overrides auto-decimation) */
  forceDecimation?: number;
  /** Smart frame skip mode — similarity-based frame deduplication */
  smartFrameSkip?: SmartFrameSkipMode;
}

/**
 * Module-level reference to the AbortController for the currently active
 * conversion. Set by performConversion and read by handleCancelConversion
 * so that the user's Stop button actually aborts the pipeline.
 */
let activeAbortController: AbortController | null = null;

const focusDownloadButton = (): void => focusElement('[data-testid="download-result-button"]');

export async function handleConvert(
  runtime: ConversionRuntimeController,
  t: TFunction
): Promise<void> {
  const file = inputFile();
  if (!file) {
    logger.warn('conversion', 'Convert called but no file loaded — conversion skipped', {
      appState: appState(),
      settings: conversionSettings(),
    });
    return;
  }

  const settings = conversionSettings();
  // Note: t parameter added by caller

  try {
    const durationValidation = await validateVideoDuration(
      file,
      settings.format,
      t,
      videoMetadata()?.framerate
    );
    const needsConfirmation = durationValidation.warnings.some(
      (warning) => warning.requiresConfirmation
    );

    if (needsConfirmation) {
      return new Promise<void>((resolve) => {
        showConfirmation(
          durationValidation.warnings,
          () => {
            void performConversion(file, settings, runtime, t, durationValidation.duration)
              .catch((error) => {
                logger.error('conversion', 'Post-confirmation conversion failed', {
                  error: getErrorMessage(error),
                });
                batch(() => {
                  setConversionStatusMessage('');
                  runtime.resetTimingState();
                  const context = classifyConversionError(
                    getErrorMessage(error) || t('error.conversionFailed'),
                    videoMetadata(),
                    settings,
                    undefined,
                    t
                  );
                  setErrorMessage(context.originalError);
                  setErrorContext(context);
                  transitionToState('error');
                });
                focusRetryButton();
              })
              .finally(() => resolve());
          },
          () => {
            logger.info('conversion', 'User cancelled conversion after duration warning');
            resolve();
          }
        );
      });
    }

    await performConversion(file, settings, runtime, t, durationValidation.duration);
  } catch (validationError) {
    logger.warn('conversion', 'Duration validation failed, proceeding anyway', {
      error: getErrorMessage(validationError),
    });
    await performConversion(file, settings, runtime, t);
  }
}

async function performConversion(
  file: File,
  settings: ConversionSettings,
  runtime: ConversionRuntimeController,
  t: TFunction,
  videoDurationMs?: number,
  signal?: AbortSignal
): Promise<void> {
  const { isActive, runId } = runtime.startNewRun();

  try {
    batch(() => {
      transitionToState('converting');
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
    logger.info('conversion', '▶ Conversion handler: use-perform-conversion.ts → pipeline', {
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
      const outW = Math.max(1, Math.floor(md.width * settings.scale));
      const outH = Math.max(1, Math.floor(md.height * settings.scale));
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

    const abortController = new AbortController();
    activeAbortController = abortController;
    signal?.addEventListener('abort', () => abortController.abort(), { once: true });

    const conversionOptions: ConversionOptions = {
      format: settings.format,
      quality: settings.quality,
      scale: settings.scale,
      trimStart: settings.trimStart > 0 ? settings.trimStart : 0,
      trimEnd: settings.trimEnd > 0 ? settings.trimEnd : 0,
      forceDecimation: forcedDecimation,
      smartFrameSkip: settings.smartFrameSkip,
    };

    let buffer: ArrayBuffer;
    try {
      buffer = getInputBuffer() ?? (await file.arrayBuffer());
    } catch (err) {
      logger.error('conversion', 'Failed to read input file buffer', {
        fileName: file.name,
        fileSizeBytes: file.size,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    if (abortController.signal.aborted) {
      logger.info('conversion', 'Conversion cancelled before pipeline start', {
        fileName: file.name,
        format: settings.format,
      });
      throw new DOMException('Cancelled', 'AbortError');
    }

    const progressCallback: ProgressCallback = (progress) => {
      if (!isActive()) return;
      runtime.updateProgress(progress.progress, progress.phase, progress.outputFrames);
      setConversionFps(progress.fps ?? undefined);
      setConversionElapsedMs(progress.elapsedMs ?? undefined);

      const phaseLabel =
        progress.phase === 'demuxing'
          ? t('progress.preparing')
          : progress.phase === 'decoding'
            ? t('progress.decoding')
            : progress.phase === 'encoding'
              ? t('progress.encoding')
              : t('progress.finalizing');

      if (
        progress.currentFrame != null &&
        progress.totalFrames != null &&
        progress.currentFrame > 0 &&
        progress.totalFrames > 0
      ) {
        const fpsLabel = progress.fps != null && progress.fps > 0 ? ` @ ${progress.fps}fps` : '';
        runtime.updateStatus(
          `Frame ${progress.currentFrame}/${progress.totalFrames} — ${phaseLabel}${fpsLabel}`
        );
      } else {
        runtime.updateStatus(phaseLabel);
      }
    };

    // Build SerializedDecoderConfig from video metadata (needed for Worker path)
    const decoderConfig = md?.config;
    const serializedConfig = decoderConfig
      ? {
          codec: decoderConfig.codec,
          codedWidth: decoderConfig.codedWidth ?? 0,
          codedHeight: decoderConfig.codedHeight ?? 0,
          ...(decoderConfig.displayAspectWidth && decoderConfig.displayAspectHeight
            ? {
                displayAspectWidth: decoderConfig.displayAspectWidth,
                displayAspectHeight: decoderConfig.displayAspectHeight,
              }
            : {}),
          ...(decoderConfig.hardwareAcceleration
            ? { hardwareAcceleration: decoderConfig.hardwareAcceleration }
            : {}),
          ...(decoderConfig.description
            ? { description: arrayBufferToHex(decoderConfig.description as ArrayBuffer) }
            : {}),
        }
      : null;

    if (!serializedConfig) {
      throw new Error('Unable to extract VideoDecoderConfig — cannot run conversion pipeline');
    }

    // Build SerializedConversionOptions (Worker-compatible format)
    const fps = md?.framerate ?? 30;
    const serializedOptions = {
      format: conversionOptions.format,
      quality: conversionOptions.quality,
      fps,
      scale: conversionOptions.scale,
      trimStart: conversionOptions.trimStart,
      trimEnd: conversionOptions.trimEnd,
      maxFrames: 0, // 0 = no limit
      forceDecimation: conversionOptions.forceDecimation,
      smartFrameSkip: conversionOptions.smartFrameSkip,
    };

    // Run via Worker with automatic fallback to main thread on error
    const output = await runPipelineWithFallback(
      buffer,
      serializedConfig,
      serializedOptions,
      progressCallback,
      abortController.signal,
      file // pass File for on-demand BlobSource reading
    );

    const mimeType = settings.format === 'gif' ? 'image/gif' : 'image/webp';
    const blob = new Blob([output], { type: mimeType });

    if (!isActive()) return;

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
    const durationSeconds = Math.max(0, duration / 1000);
    const memMB = getMemoryUsageMB();
    logger.info('conversion', 'Conversion complete', {
      format: settings.format,
      quality: settings.quality,
      scale: settings.scale,
      duration: `${durationSeconds.toFixed(2)}s`,
      outputSize: blob.size,
      outputSizeFormatted: formatBytes(blob.size),
      outputSizePercent: `${((blob.size / file.size) * 100).toFixed(1)}%`,
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
    // Use queueMicrotask to defer the new result into a separate microtask,
    // breaking the synchronous signal cascade that could overflow the stack.
    setConversionResults([]);

    queueMicrotask(() => {
      setConversionResults([newResult]);
    });

    batch(() => {
      transitionToState('done');
      setConversionStatusMessage('');
      runtime.resetTimingState();
      // Release input buffer — no longer needed after conversion completes.
      // This allows GC of the original file data (up to 500MB).
      setInputBuffer(null);
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

    const errorMessage_ = getErrorMessage(error) || t('error.conversionFailed');

    if (isCancellationError(error)) {
      batch(() => {
        setConversionStatusMessage('');
        runtime.resetTimingState();
        setAppState('idle');
        // Release input buffer on cancellation too
        setInputBuffer(null);
      });
      return;
    }

    const context = classifyConversionError(errorMessage_, videoMetadata(), settings, undefined, t);

    logger.error('conversion', 'Conversion failed', {
      error: errorMessage_,
      settings,
      errorType: context.type,
      errorCode: context.code,
    });

    batch(() => {
      setConversionStatusMessage('');
      runtime.resetTimingState();
      setErrorMessage(context.originalError);
      setErrorContext(context);
      transitionToState('error');
    });

    focusRetryButton();
  } finally {
    // Release the module-level abort controller so a stale reference
    // cannot abort a future conversion.
    activeAbortController = null;
  }
}

export function handleCancelConversion(runtime: ConversionRuntimeController): void {
  logger.info('conversion', 'User cancelled conversion', {
    appState: appState(),
  });
  // Abort the active pipeline so demux/decode/encode can stop immediately
  activeAbortController?.abort();
  activeAbortController = null;
  runtime.invalidateActiveConversions();
  setAppState('cancelling');

  // Capture current seq so the microtask only resets state if no new conversion
  // has started between now and when the microtask runs.
  const cancelledSeq = runtime.getActiveConversionSeq();
  queueMicrotask(() => {
    // Only reset if no new conversion has started since cancel was triggered
    if (runtime.getActiveConversionSeq() !== cancelledSeq) return;
    runtime.resetRuntimeState();
    setAppState('idle');
  });
}

export function handleCancelAnalysis(): void {
  batch(() => {
    setAppState('cancelling');
  });

  // Revoke blob URL immediately (not deferred) to prevent race condition
  // where a new file's preview URL could be revoked by a queued microtask.
  const url = videoPreviewUrl();
  if (url) URL.revokeObjectURL(url);

  queueMicrotask(() => {
    batch(() => {
      setInputFile(null);
      setVideoPreviewUrl(null);
      setVideoMetadata(null);
      setAppState('idle');
    });
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

export function handleRetry(runtime: ConversionRuntimeController, t: TFunction): void {
  const file = inputFile();
  if (file && appState() === 'error') {
    // Clear previous results immediately to avoid flash of stale content
    setConversionResults([]);
    // If we already have valid video metadata (e.g., from a previous
    // file-selection phase), skip re-extracting it and go straight to
    // conversion. This avoids redundant buffer reads + decoder config
    // extraction when only the conversion itself failed.
    if (videoMetadata()?.config) {
      const settings = conversionSettings();
      void performConversion(file, settings, runtime, t).catch((error) =>
        logger.error('conversion', 'Retry conversion failed', { error: getErrorMessage(error) })
      );
    } else {
      void handleFileSelected(file, runtime, t).catch((error) =>
        logger.error('conversion', 'Retry file selection failed', { error: getErrorMessage(error) })
      );
    }
  } else {
    handleReset(runtime);
  }
}

export function handleDismissError(): void {
  logger.info('general', 'User dismissed error message');
  batch(() => {
    setErrorMessage(null);
    setErrorContext(null);

    const previousPreviewUrl = videoPreviewUrl();
    if (previousPreviewUrl) {
      URL.revokeObjectURL(previousPreviewUrl);
    }
    setVideoPreviewUrl(null);
    // Clear inputFile too — revoking the preview URL without clearing the file
    // creates orphaned state where inputFile is set but videoPreviewUrl is null.
    setInputFile(null);

    setAppState('idle');
  });
}
