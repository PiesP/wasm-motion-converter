// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { getErrorMessage } from '@piesp/browser-core/error';
import { checkVideoDecoderSupport } from '@services/video-decoder-support';
import { extractVideoMetadata } from '@services/video-metadata';
import { conversionSettings, setConversionSettings } from '@stores/conversion-settings-store';
import {
  setErrorContext,
  setErrorMessage,
  setInputBuffer,
  setInputFile,
  setVideoMetadata,
  setVideoPreviewUrl,
  transitionToState,
  videoPreviewUrl,
} from '@stores/conversion-store';
import type { TFunction } from '@t/i18n-types';
import { classifyConversionError } from '@utils/classify-conversion-error';
import { DEFAULT_FPS } from '@utils/constants';
import { focusRetryButton } from '@utils/dom-utils';
import { validateVideoFile } from '@utils/file-validation';
import { logger } from '@utils/logger';
import { batch } from 'solid-js';
import type { ConversionRuntimeController } from './use-conversion-runtime-controller';

const resetErrorState = (): void => {
  batch(() => {
    setErrorMessage(null);
    setErrorContext(null);
  });
};

const resetAnalysisState = (): void => {
  setVideoMetadata(null);
};

export async function handleFileSelected(
  file: File,
  runtime: ConversionRuntimeController,
  t: TFunction
): Promise<void> {
  const run = runtime.startNewRun();
  if (!run) return;
  const isStale = () => !run.isActive();

  runtime.resetRuntimeState();
  resetErrorState();
  resetAnalysisState();

  const validation = await validateVideoFile(file, t);
  if (isStale()) {
    runtime.finishAnalysisRun(run);
    return;
  }

  if (!validation.valid) {
    logger.warn('conversion', 'File validation failed — conversion blocked', {
      fileName: file.name,
      fileSizeBytes: file.size,
      fileType: file.type,
      error: getErrorMessage(validation.error),
    });
    batch(() => {
      setErrorMessage(getErrorMessage(validation.error));
      transitionToState('error');
    });
    focusRetryButton();
    runtime.finishAnalysisRun(run);
    return;
  }

  // Trim points belong to the previously selected video. Carrying them into
  // another file can produce an empty or unintended range, especially when
  // the next video is shorter.
  setConversionSettings({ ...conversionSettings(), trimStart: 0, trimEnd: 0 });

  // Show "analyzing" state before reading the file so the UI reflects
  // that work is happening (important for large files).
  transitionToState('analyzing');

  setInputFile(file);

  const previousPreviewUrl = videoPreviewUrl();
  if (previousPreviewUrl) {
    URL.revokeObjectURL(previousPreviewUrl);
  }
  setVideoPreviewUrl(URL.createObjectURL(file));

  try {
    // BlobSource lets MediaBunny read only the ranges needed for metadata.
    // Keep the file itself as the source of truth and materialize an
    // ArrayBuffer later only when the GIF worker path needs one.
    const metadata = await extractVideoMetadata(file, DEFAULT_FPS, run.signal);
    if (isStale()) return;

    const decoderConfig = metadata.config;
    if (decoderConfig) {
      const decoderSupported = await checkVideoDecoderSupport(decoderConfig);
      if (isStale()) return;
      if (decoderSupported === false) {
        const message = `Unsupported codec configuration: ${decoderConfig.codec}`;
        const context = classifyConversionError(message, metadata, conversionSettings(), t);
        logger.warn('conversion', 'Decoder support preflight failed — conversion blocked', {
          fileName: file.name,
          codec: decoderConfig.codec,
        });
        batch(() => {
          setErrorMessage(context.originalError);
          setErrorContext(context);
          transitionToState('error');
        });
        focusRetryButton();
        return;
      }
    }

    setVideoMetadata(metadata);
    transitionToState('idle');
  } catch (error) {
    if (isStale()) return;

    // Clear buffer reference so GC can reclaim the file data on error
    setInputBuffer(null);

    logger.warn('conversion', 'Metadata extraction failed', {
      fileName: file.name,
      fileSizeBytes: file.size,
      error: getErrorMessage(error),
    });
    batch(() => {
      setErrorMessage(getErrorMessage(error));
      transitionToState('error');
    });
    focusRetryButton();
  } finally {
    runtime.finishAnalysisRun(run);
  }
}
