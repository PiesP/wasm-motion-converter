// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import {
  setAppState,
  setErrorContext,
  setErrorMessage,
  setInputFile,
  setLoadingProgress,
  setLoadingStatusMessage,
  setVideoMetadata,
  setVideoPreviewUrl,
  videoPreviewUrl,
} from '@stores/conversion-store';
import { focusElement } from '@utils/dom-utils';
import { getErrorMessage } from '@utils/error-utils';
import { validateVideoFile } from '@utils/file-validation';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';

import type { ConversionRuntimeController } from './use-conversion-runtime-controller';

const focusRetryButton = (): void => focusElement('[data-testid="error-retry-button"]');

const resetErrorState = (): void => {
  setErrorMessage(null);
  setErrorContext(null);
};

const resetAnalysisState = (): void => {
  setVideoMetadata(null);
  setLoadingProgress(0);
  setLoadingStatusMessage('');
};

/**
 * Extract video metadata using MediaBunny (no FFmpeg needed).
 */
async function extractMetadata(file: File) {
  const source = new BufferSource(await file.arrayBuffer());
  const input = new Input({ formats: ALL_FORMATS, source });

  try {
    const videoTracks = await input.getVideoTracks();
    const track = videoTracks[0];
    if (!track) throw new Error('No video track found');

    const config = await track.getDecoderConfig();
    if (!config) throw new Error('Unable to obtain VideoDecoderConfig');

    const duration = await track.computeDuration();
    const width = config.codedWidth ?? 0;
    const height = config.codedHeight ?? 0;

    // Extract codec string (e.g. "avc1.42E01E" → "avc1")
    const codec = config.codec?.split('.')[0] ?? 'unknown';

    // Estimate frame rate from config if available
    const framerate = 30; // Default; MediaBunny doesn't always expose this directly

    return {
      width,
      height,
      duration,
      codec,
      framerate,
      bitrate: 0,
    };
  } finally {
    input.dispose();
  }
}

export async function handleFileSelected(
  file: File,
  runtime: ConversionRuntimeController
): Promise<void> {
  const run = runtime.startNewRun();
  const isStale = () => !run.isActive();

  runtime.resetRuntimeState();
  resetErrorState();
  resetAnalysisState();

  const validation = validateVideoFile(file);
  if (!validation.valid) {
    setErrorMessage(getErrorMessage(validation.error));
    setAppState('error');
    focusRetryButton();
    return;
  }

  if (isStale()) return;

  setInputFile(file);

  const previousPreviewUrl = videoPreviewUrl();
  if (previousPreviewUrl) {
    URL.revokeObjectURL(previousPreviewUrl);
  }
  setVideoPreviewUrl(URL.createObjectURL(file));

  try {
    setAppState('analyzing');
    setLoadingStatusMessage('Reading video metadata...');

    const metadata = await extractMetadata(file);
    if (isStale()) return;

    setVideoMetadata(metadata);
    setLoadingProgress(0);
    setLoadingStatusMessage('');
    setAppState('idle');
  } catch (error) {
    if (isStale()) return;

    setLoadingProgress(0);
    setLoadingStatusMessage('');
    setErrorMessage(getErrorMessage(error));
    setAppState('error');
    focusRetryButton();
  }
}
