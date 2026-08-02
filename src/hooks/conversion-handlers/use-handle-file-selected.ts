// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { getErrorMessage } from '@piesp/browser-core/error';
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
      transitionToState('error');
    });
    focusRetryButton();
    return;
  }

  if (isStale()) return;

  // Trim points belong to the previously selected video. Carrying them into
  // another file can produce an empty or unintended range, especially when
  // the next video is shorter.
  setConversionSettings({ ...conversionSettings(), trimStart: 0, trimEnd: 0 });

  // Show "analyzing" state before reading the file so the UI reflects
  // that work is happening (important for large files).
  transitionToState('analyzing');

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
    // Pass a copy of the buffer to extractVideoMetadata so the original
    // stays intact (mediabunny's BufferSource may detach the buffer on dispose).
    const metadata = await extractVideoMetadata(buffer.slice(0), DEFAULT_FPS);
    if (isStale()) return;

    // Store buffer only after successful metadata extraction so performConversion can reuse it
    setInputBuffer(buffer);
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
  }
}
