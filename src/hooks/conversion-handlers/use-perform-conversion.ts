// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { getErrorMessage, isCancellationError } from '@piesp/browser-core/error';
import { runPipelineWithFallback } from '@services/conversion-worker/main-thread-proxy';
import { validateOutput } from '@services/error-recovery';
import { showConfirmation } from '@stores/confirmation-store';
import { conversionSettings } from '@stores/conversion-settings-store';
import {
  appState,
  getInputBuffer,
  inputFile,
  setAppState,
  setConversionElapsedMs,
  setConversionFps,
  setConversionResults,
  setConversionStatusMessage,
  setCurrentFrame,
  setErrorContext,
  setErrorMessage,
  setInputBuffer,
  setInputFile,
  setTotalFrames,
  setVideoMetadata,
  setVideoPreviewUrl,
  transitionToState,
  videoMetadata,
  videoPreviewUrl,
} from '@stores/conversion-store';
import type {
  ConversionProgress,
  ConversionResult,
  ConversionSettings,
  ProgressCallback,
  ProgressPhase,
  VideoMetadata,
} from '@t/conversion-types';
import type { TFunction, TranslationKey } from '@t/i18n-types';
import { classifyConversionError } from '@utils/classify-conversion-error';
import { WORKER_MAX_MEMORY_MB } from '@utils/constants';
import { focusElement, focusRetryButton } from '@utils/dom-utils';
import { validateVideoDuration } from '@utils/file-validation';
import { createId, formatBytes } from '@utils/format-utils';
import { logger } from '@utils/logger';
import { checkMemoryForConversion, getMemoryUsageMB } from '@utils/memory-monitor';
import { batch } from 'solid-js';
import {
  buildConversionMemoryPlan,
  resolveMemoryPressureDecimation,
  serializeConversionInputs,
} from './conversion-planning';
import type {
  ConversionIntent,
  ConversionRuntimeController,
} from './use-conversion-runtime-controller';
import { handleFileSelected } from './use-handle-file-selected';

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

  // Guard against double-click: abort any in-flight conversion and prevent
  // a second pipeline from starting while the first is still running.
  if (appState() === 'converting') {
    logger.warn('conversion', 'Convert called while already converting — skipping');
    return;
  }
  // Also guard during the analyzing → converting transition
  if (appState() === 'analyzing') {
    logger.warn('conversion', 'Convert called while analyzing — skipping');
    return;
  }
  const intent = runtime.beginConversionIntent();
  if (!intent) {
    logger.warn('conversion', 'Convert called while another request is being prepared — skipping');
    return;
  }

  const settings = conversionSettings();

  try {
    const durationValidation = await validateVideoDuration(
      file,
      settings.format,
      t,
      videoMetadata()?.framerate,
      intent.signal
    );
    if (!intent.isActive()) return;
    const needsConfirmation = durationValidation.warnings.some(
      (warning) => warning.requiresConfirmation
    );

    if (needsConfirmation) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          intent.signal.removeEventListener('abort', settle);
          resolve();
        };
        intent.signal.addEventListener('abort', settle, { once: true });
        showConfirmation(
          durationValidation.warnings,
          () => {
            if (!intent.isActive()) {
              settle();
              return;
            }
            void performConversion(file, settings, runtime, t, intent, durationValidation.duration)
              .catch((error) => {
                logger.error('conversion', 'Post-confirmation conversion failed', {
                  error: getErrorMessage(error),
                });
                batch(() => {
                  setConversionStatusMessage('');
                  runtime.resetRuntimeState();
                  const context = classifyConversionError(
                    getErrorMessage(error) || t('error.conversionFailed'),
                    videoMetadata(),
                    settings,
                    t
                  );
                  setErrorMessage(context.originalError);
                  setErrorContext(context);
                  transitionToState('error');
                });
                focusRetryButton();
              })
              .finally(settle);
          },
          () => {
            logger.info('conversion', 'User cancelled conversion after duration warning');
            settle();
          }
        );
        if (intent.signal.aborted) settle();
      });
      return;
    }

    await performConversion(file, settings, runtime, t, intent, durationValidation.duration);
  } catch (validationError) {
    if (!intent.isActive() || isCancellationError(validationError)) return;
    logger.warn('conversion', 'Duration validation failed, proceeding anyway', {
      error: getErrorMessage(validationError),
    });
    await performConversion(file, settings, runtime, t, intent);
  } finally {
    const wasCancelled = intent.signal.aborted;
    runtime.finishConversionIntent(intent);
    if (wasCancelled && appState() === 'cancelling') {
      batch(() => {
        runtime.resetRuntimeState();
        setAppState('idle');
      });
    }
  }
}

async function performConversion(
  file: File,
  settings: ConversionSettings,
  runtime: ConversionRuntimeController,
  t: TFunction,
  intent: ConversionIntent,
  videoDurationMs?: number
): Promise<void> {
  const { isActive, runId, signal } = intent;

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

    const metadata = videoMetadata();
    const forcedDecimation = runMemoryCheck(metadata, settings);

    // The GIF worker protocol transfers an ArrayBuffer. WebP runs on the main
    // thread with BlobSource, so avoid retaining a full-file copy for that path.
    const buffer = settings.format === 'gif' ? await readInputBuffer(file) : undefined;
    if (signal.aborted) {
      throw new DOMException('Cancelled', 'AbortError');
    }

    const progressCallback = createProgressCallback(isActive, runtime, t);
    const { serializedConfig, serializedOptions } = serializeConversionInputs(
      metadata,
      forcedDecimation,
      settings
    );

    const output = await executePipeline(
      buffer,
      serializedConfig,
      serializedOptions,
      progressCallback,
      signal,
      file,
      metadata?.duration,
      metadata?.framerate
    );

    // Pipeline has consumed the buffer — release immediately so GC
    // can reclaim up to 500 MB before handleResult allocates more.
    setInputBuffer(null);

    const blob = validateOutputBlob(output, settings);
    handleResult(blob, file, settings, runtime, startTimeMs, isActive);
    focusDownloadButton();
  } catch (error) {
    await handleConversionError(error, isActive, runtime, t, settings);
  }
}

// ─── Private Step Functions ────────────────────────────────────────────

function runMemoryCheck(
  metadata: VideoMetadata | null,
  settings: ConversionSettings
): number | undefined {
  const plan = buildConversionMemoryPlan(metadata, settings);
  if (!plan) return undefined;

  const memCheck = checkMemoryForConversion(
    plan.width,
    plan.height,
    plan.estimatedFrames,
    plan.format
  );
  logger.info('conversion', 'Pre-conversion memory check', {
    level: memCheck.level,
    estimatedMB: memCheck.estimatedMB,
    availableMB: memCheck.availableMB,
    width: plan.width,
    height: plan.height,
    estFrames: plan.estimatedFrames,
  });

  const forcedDecimation = resolveMemoryPressureDecimation(plan, memCheck.level);
  if (forcedDecimation !== undefined) {
    logger.warn('conversion', 'Forcing frame decimation due to memory pressure', {
      forcedDecimation,
      estimatedMB: memCheck.estimatedMB,
      availableMB: memCheck.availableMB,
    });
  }

  return forcedDecimation;
}

async function readInputBuffer(file: File): Promise<ArrayBuffer> {
  try {
    return getInputBuffer() ?? (await file.arrayBuffer());
  } catch (err) {
    logger.error('conversion', 'Failed to read input file buffer', {
      fileName: file.name,
      fileSizeBytes: file.size,
      error: getErrorMessage(err),
    });
    throw err;
  }
}

function createProgressCallback(
  isActive: () => boolean,
  runtime: ConversionRuntimeController,
  t: TFunction
): ProgressCallback {
  return (progress) => {
    if (!isActive()) return;
    runtime.updateProgress(progress.progress, progress.phase, progress.outputFrames);
    runtime.updateMemoryUsage(progress.memoryMB);
    setConversionFps(progress.fps ?? undefined);
    setConversionElapsedMs(progress.elapsedMs ?? undefined);
    if (progress.currentFrame != null) setCurrentFrame(progress.currentFrame);
    if (progress.totalFrames != null) setTotalFrames(progress.totalFrames);
    runtime.updateStatus(formatConversionProgressStatus(progress, t));
  };
}

const PROGRESS_PHASE_LABEL_KEYS = {
  demuxing: 'progress.preparing',
  decoding: 'progress.decoding',
  encoding: 'progress.encoding',
  assembling: 'progress.finalizing',
} as const satisfies Record<ProgressPhase, TranslationKey>;

export function formatConversionProgressStatus(
  progress: Pick<ConversionProgress, 'phase' | 'currentFrame' | 'totalFrames' | 'fps'>,
  t: TFunction
): string {
  const phase = t(PROGRESS_PHASE_LABEL_KEYS[progress.phase]);
  if (
    progress.currentFrame == null ||
    progress.totalFrames == null ||
    progress.currentFrame <= 0 ||
    progress.totalFrames <= 0
  ) {
    return phase;
  }

  const frame = t('progress.frameCounter', {
    current: progress.currentFrame,
    total: progress.totalFrames,
  });
  if (progress.fps > 0) {
    return t('progress.statusFrameFps', { frame, phase, fps: progress.fps });
  }
  return t('progress.statusFrame', { frame, phase });
}

async function executePipeline(
  buffer: ArrayBuffer | undefined,
  serializedConfig: ReturnType<typeof serializeConversionInputs>['serializedConfig'],
  serializedOptions: ReturnType<typeof serializeConversionInputs>['serializedOptions'],
  progressCallback: ProgressCallback,
  signal: AbortSignal,
  file: File,
  duration?: number,
  framerate?: number
): Promise<ArrayBuffer> {
  if (!serializedConfig) {
    throw new Error('Unable to extract VideoDecoderConfig — cannot run conversion pipeline');
  }

  // WebP: skip Worker pipeline — wasm-webp hangs in Worker context (WASM preload
  // from main document is not accessible to Workers). Main-thread OffscreenCanvas
  // path is faster and more reliable.
  const isWebP = serializedOptions.format === 'webp';
  if (isWebP) {
    const { runConversionPipeline } = await import('@services/conversion-pipeline');
    const request = {
      inputBlob: file,
      fileName: file.name,
      format: 'webp' as const,
      quality: serializedOptions.quality,
      scale: serializedOptions.scale,
      trimStart: serializedOptions.trimStart,
      trimEnd: serializedOptions.trimEnd,
      maxMemoryMB: WORKER_MAX_MEMORY_MB,
      maxFrames: serializedOptions.maxFrames,
      maxOutputBytes: serializedOptions.maxOutputBytes,
      forceDecimation: serializedOptions.forceDecimation,
      smartFrameSkip: serializedOptions.smartFrameSkip ?? 'off',
    };
    return runConversionPipeline(
      request as Parameters<typeof runConversionPipeline>[0],
      progressCallback as Parameters<typeof runConversionPipeline>[1],
      signal
    );
  }

  if (!buffer) {
    throw new Error('Unable to read the input video for GIF conversion');
  }

  return runPipelineWithFallback(
    buffer,
    serializedConfig as unknown as Parameters<typeof runPipelineWithFallback>[1],
    serializedOptions,
    progressCallback,
    signal,
    file,
    duration,
    framerate
  );
}

function validateOutputBlob(output: ArrayBuffer, settings: ConversionSettings): Blob {
  if (output.byteLength === 0) {
    throw new Error('Conversion produced an empty output file');
  }

  const header = new Uint8Array(output, 0, Math.min(output.byteLength, 16));
  if (!validateOutput(header, settings.format)) {
    throw new Error(`Conversion produced an invalid output header for ${settings.format}`);
  }

  const mimeType = settings.format === 'gif' ? 'image/gif' : 'image/webp';
  return new Blob([output], { type: mimeType });
}

function handleResult(
  blob: Blob,
  file: File,
  settings: ConversionSettings,
  runtime: ConversionRuntimeController,
  startTimeMs: number,
  isActive: () => boolean
): void {
  // Guard against stale results from superseded conversion runs.
  // If a new file was selected or conversion cancelled while the pipeline
  // was running, the result belongs to an old run and must be discarded.
  if (!isActive()) {
    logger.warn('conversion', 'handleResult called for stale run — discarding result', {
      outputSize: blob.size,
      format: settings.format,
    });
    return;
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
    runtime.resetRuntimeState();
    // Input buffer was already released after pipeline completion
    // in performConversion — no need to clear again.
  });
}

async function handleConversionError(
  error: unknown,
  isActive: () => boolean,
  runtime: ConversionRuntimeController,
  t: TFunction,
  settings: ConversionSettings
): Promise<void> {
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
    // Always release the input buffer on cancellation — even if this run
    // was superseded by a later file selection (isActive() === false).
    // The buffer can be up to 500 MB.
    setInputBuffer(null);

    if (!isActive()) {
      // This run was superseded — abort is already handled by later run.
      // Just clean up and bail out.
      runtime.stopMemoryMonitoring();
      return;
    }

    batch(() => {
      setConversionStatusMessage('');
      runtime.resetRuntimeState();
      setAppState('idle');
    });
    return;
  }

  const context = classifyConversionError(errorMessage_, videoMetadata(), settings, t);

  logger.error('conversion', 'Conversion failed', {
    error: errorMessage_,
    settings,
    errorType: context.type,
    errorCode: context.code,
  });

  batch(() => {
    setConversionStatusMessage('');
    runtime.resetRuntimeState();
    setErrorMessage(context.originalError);
    setErrorContext(context);
    transitionToState('error');
  });

  focusRetryButton();
}

export function handleCancelConversion(runtime: ConversionRuntimeController): void {
  logger.info('conversion', 'User cancelled conversion', {
    appState: appState(),
  });
  // Abort preparation or the active pipeline and invalidate its ownership token.
  runtime.abortConversionIntent();

  // Always release the input buffer on cancel — even if no pipeline was
  // in flight (e.g., cancel during duration validation).  The buffer can
  // be up to 500 MB and must be freed regardless of timing.
  setInputBuffer(null);

  setAppState('cancelling');
}

export function handleCancelAnalysis(runtime: ConversionRuntimeController): void {
  // Invalidate any in-flight conversions so queued microtasks from
  // this analysis can't override a newly started file selection.
  runtime.invalidateActiveConversions();

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
    // NOTE: conversion settings are intentionally preserved so the user's
    // format/quality/scale/trim/smartFrameSkip choices survive a file change.
    // Only file-related state is cleared here.
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
      const intent = runtime.beginConversionIntent();
      if (!intent) return;
      void performConversion(file, settings, runtime, t, intent)
        .catch((error) =>
          logger.error('conversion', 'Retry conversion failed', { error: getErrorMessage(error) })
        )
        .finally(() => runtime.finishConversionIntent(intent));
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
    // Dismiss abandons retry, so release the potentially large input buffer and
    // its metadata together with the rest of the file-scoped state.
    setInputBuffer(null);
    setVideoMetadata(null);

    setAppState('idle');
  });
}
