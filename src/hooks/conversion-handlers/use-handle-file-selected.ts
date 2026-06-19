// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

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
import { DEFAULT_FPS } from '@utils/constants';
import { focusElement } from '@utils/dom-utils';
import { getErrorMessage } from '@utils/error-utils';
import { validateVideoFile } from '@utils/file-validation';
import { logger } from '@utils/logger';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { batch } from 'solid-js';

import type { ConversionRuntimeController } from './use-conversion-runtime-controller';

const focusRetryButton = (): void => focusElement('[data-testid="error-retry-button"]');

const resetErrorState = (): void => {
  batch(() => {
    setErrorMessage(null);
    setErrorContext(null);
  });
};

const resetAnalysisState = (): void => {
  setVideoMetadata(null);
};

/**
 * Extract video metadata using MediaBunny (no FFmpeg needed).
 * Accepts an optional pre-read ArrayBuffer to avoid double-loading large files.
 */
async function extractMetadata(file: File, existingBuffer?: ArrayBuffer) {
  const buffer = existingBuffer ?? (await file.arrayBuffer());
  const source = new BufferSource(buffer);
  const input = new Input({ formats: ALL_FORMATS, source });

  try {
    const videoTracks = await input.getVideoTracks();
    const track = videoTracks[0];
    if (!track) throw new Error('No video track found');

    const config = await track.getDecoderConfig();
    if (!config) throw new Error('Unable to obtain VideoDecoderConfig');

    const duration = await track.computeDuration();
    // displayAspectWidth/Height: present when pixel aspect ratio is non-square (mediabunny v1.40.0+).
    // These represent the display dimensions directly.
    const cfg = config as unknown as Record<string, number>;
    const width = cfg.displayAspectWidth ?? cfg.displayWidth ?? config.codedWidth ?? 0;
    const height = cfg.displayAspectHeight ?? cfg.displayHeight ?? config.codedHeight ?? 0;

    // Extract codec string (e.g. "avc1.42E01E" → "avc1")
    const codec = config.codec?.split('.')[0] ?? 'unknown';

    // Estimate frame rate from config if available
    const framerate = DEFAULT_FPS; // Default; MediaBunny doesn't always expose this directly

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
  setInputBuffer(buffer);

  const previousPreviewUrl = videoPreviewUrl();
  if (previousPreviewUrl) {
    URL.revokeObjectURL(previousPreviewUrl);
  }
  setVideoPreviewUrl(URL.createObjectURL(file));

  try {
    const metadata = await extractMetadata(file, buffer);
    if (isStale()) return;

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
