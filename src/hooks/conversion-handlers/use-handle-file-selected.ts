// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { extractVideoMetadata } from '@services/video-metadata';
import {
  setAppState,
  setErrorContext,
  setErrorMessage,
  setInputBuffer,
  setInputFile,
  setVideoMetadata,
  setVideoPreviewUrl,
  videoPreviewUrl,
} from '@stores/conversion-store';
import type { TFunction } from '@t/i18n-types';
import { DEFAULT_FPS } from '@utils/constants';
import { focusRetryButton } from '@utils/dom-utils';
import { getErrorMessage } from '@utils/error-utils';
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
  const isStale = () => !run.isActive();

  runtime.resetRuntimeState();
  resetErrorState();
  resetAnalysisState();

  const validation = await validateVideoFile(file, t);
  if (!validation.valid) {
    logger.warn('conversion', 'File validation failed — conversion blocked', {
      fileName: file.name,
      fileSizeBytes: file.size,
      fileType: file.type,
      error: getErrorMessage(validation.error),
    });
    batch(() => {
      setErrorMessage(getErrorMessage(validation.error));
      setAppState('error');
    });
    focusRetryButton();
    return;
  }

  if (isStale()) return;

  // Show "analyzing" state before reading the file so the UI reflects
  // that work is happening (important for large files).
  setAppState('analyzing');

  // Read file once upfront, then share the buffer between metadata extraction and conversion
  const buffer = await file.arrayBuffer();
  if (isStale()) return;

  setInputFile(file);

  const previousPreviewUrl = videoPreviewUrl();
  if (previousPreviewUrl) {
    URL.revokeObjectURL(previousPreviewUrl);
  }
  setVideoPreviewUrl(URL.createObjectURL(file));

  try {
    const metadata = await extractVideoMetadata(buffer, DEFAULT_FPS);
    if (isStale()) return;

    // Store buffer only after successful metadata extraction so performConversion can reuse it
    setInputBuffer(buffer);
    setVideoMetadata(metadata);
    setAppState('idle');
  } catch (error) {
    if (isStale()) return;

    logger.warn('conversion', 'Metadata extraction failed', {
      fileName: file.name,
      fileSizeBytes: file.size,
      error: getErrorMessage(error),
    });
    batch(() => {
      setErrorMessage(getErrorMessage(error));
      setAppState('error');
    });
    focusRetryButton();
  }
}
