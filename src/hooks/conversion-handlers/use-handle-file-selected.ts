import { ffmpegService } from '@services/ffmpeg-service';
import { analyzeVideo } from '@services/video-analyzer-service';
import { setAppState, setLoadingProgress, setLoadingStatusMessage } from '@stores/app-store';
import {
  setErrorContext,
  setErrorMessage,
  setInputFile,
  setVideoMetadata,
  setVideoPreviewUrl,
  videoPreviewUrl,
} from '@stores/conversion-store';
import { getErrorMessage } from '@utils/error-utils';
import { validateVideoFile } from '@utils/file-validation';

import type { ConversionRuntimeController } from './use-conversion-runtime-controller';

const focusRetryButton = () => {
  queueMicrotask(() => {
    document.querySelector<HTMLButtonElement>('[data-error-retry-button]')?.focus();
  });
};

const resetErrorState = (): void => {
  setErrorMessage(null);
  setErrorContext(null);
};

const resetAnalysisState = (): void => {
  setVideoMetadata(null);
  setLoadingProgress(0);
  setLoadingStatusMessage('');
};

let activeSelectionId = 0;

export async function handleFileSelected(
  file: File,
  runtime: ConversionRuntimeController
): Promise<void> {
  const selectionId = (activeSelectionId += 1);
  const isStale = () => selectionId !== activeSelectionId;

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

  await ffmpegService.clearCachedInput();
  if (isStale()) {
    return;
  }

  setInputFile(file);

  const previousPreviewUrl = videoPreviewUrl();
  if (previousPreviewUrl) {
    URL.revokeObjectURL(previousPreviewUrl);
  }
  setVideoPreviewUrl(URL.createObjectURL(file));

  try {
    if (!ffmpegService.isLoaded()) {
      setAppState('loading-ffmpeg');
      await ffmpegService.initialize(setLoadingProgress, setLoadingStatusMessage);
      if (isStale()) {
        return;
      }
    }

    setAppState('analyzing');

    const metadata = await analyzeVideo(file);
    if (isStale()) {
      return;
    }

    setVideoMetadata(metadata);
    setLoadingProgress(0);
    setLoadingStatusMessage('');
    setAppState('idle');
  } catch (error) {
    if (isStale()) {
      return;
    }

    setLoadingProgress(0);
    setLoadingStatusMessage('');
    setErrorMessage(getErrorMessage(error));
    setAppState('error');
    focusRetryButton();
  }
}
