import { ffmpegService } from '@services/ffmpeg-service';
import { checkPerformance, getRecommendedSettings } from '@services/performance-checker-service';
import {
  analyzeVideo,
  analyzeVideoCodecOnly,
  analyzeVideoQuick,
} from '@services/video-analyzer-service';
import { setAppState, setLoadingProgress, setLoadingStatusMessage } from '@stores/app-store';
import { setErrorContext, setErrorMessage } from '@stores/conversion-error-store';
import {
  setInputFile,
  setVideoMetadata,
  setVideoPreviewUrl,
  videoPreviewUrl,
} from '@stores/conversion-media-store';
import {
  setAutoAppliedRecommendation,
  setPerformanceWarnings,
} from '@stores/conversion-performance-store';
import { conversionSettings, setConversionSettings } from '@stores/conversion-settings-store';
import type { VideoMetadata } from '@t/conversion-types';
import { WARN_RESOLUTION_PIXELS } from '@utils/constants';
import { getErrorMessage } from '@utils/error-utils';
import { validateVideoFile } from '@utils/file-validation';

import type { ConversionRuntimeController } from './use-conversion-runtime-controller';

const SMALL_FILE_SIZE_THRESHOLD = 50 * 1024 * 1024;
const SHORT_VIDEO_DURATION = 15;

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
  setPerformanceWarnings([]);
  setAutoAppliedRecommendation(false);
};

const resetOutputState = (): void => {
  setLoadingProgress(0);
  setLoadingStatusMessage('');
};

const shouldRunFullAnalysis = (file: File, metadata: VideoMetadata | null): boolean => {
  if (!metadata) {
    return true;
  }

  if (metadata.width <= 0 || metadata.height <= 0 || metadata.duration <= 0) {
    return true;
  }

  const isSmallFile = file.size <= SMALL_FILE_SIZE_THRESHOLD;
  const isShort = metadata.duration > 0 ? metadata.duration <= SHORT_VIDEO_DURATION : false;
  const isLowRes = metadata.width * metadata.height <= WARN_RESOLUTION_PIXELS;
  return !(isSmallFile && isShort && isLowRes);
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
  resetOutputState();

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
    const needsInit = !ffmpegService.isLoaded();
    const initPromise = needsInit
      ? ffmpegService.initialize(setLoadingProgress, setLoadingStatusMessage)
      : Promise.resolve();

    if (needsInit) {
      setAppState('loading-ffmpeg');
    }

    const quickAnalysisPromise: Promise<VideoMetadata | null> = analyzeVideoQuick(file)
      .then((metadata) => {
        if (isStale()) {
          return null;
        }
        setVideoMetadata(metadata);
        setPerformanceWarnings(checkPerformance(file, metadata));
        return metadata;
      })
      .catch(() => null);

    const quickMetadata = await quickAnalysisPromise;
    await initPromise;
    if (isStale()) {
      return;
    }

    const requiresFullAnalysis = shouldRunFullAnalysis(file, quickMetadata);
    let finalMetadata: VideoMetadata | null = quickMetadata;

    if (requiresFullAnalysis) {
      setAppState('analyzing');
      const metadata = await analyzeVideo(file);
      if (isStale()) {
        return;
      }
      finalMetadata = metadata;
      setVideoMetadata(metadata);
      setPerformanceWarnings(checkPerformance(file, metadata));
    } else if (quickMetadata) {
      try {
        const codecMetadata = await analyzeVideoCodecOnly(file);
        if (isStale()) {
          return;
        }
        const mergedMetadata: VideoMetadata = {
          width: quickMetadata.width,
          height: quickMetadata.height,
          duration: quickMetadata.duration,
          codec: codecMetadata.codec,
          framerate: codecMetadata.framerate,
          bitrate: codecMetadata.bitrate,
        };
        finalMetadata = mergedMetadata;
        setVideoMetadata(mergedMetadata);
      } catch {
        // Keep quick metadata if codec probe fails.
      }
    }

    if (finalMetadata) {
      const recommendation = getRecommendedSettings(file, finalMetadata, conversionSettings());
      const applied = Boolean(recommendation);
      setAutoAppliedRecommendation(applied);
      if (recommendation) {
        setConversionSettings(recommendation);
      }
    }

    if (!isStale()) {
      setAppState('idle');
    }
  } catch (error) {
    if (isStale()) {
      return;
    }
    setErrorMessage(getErrorMessage(error));
    setAppState('error');
    focusRetryButton();
  }
}
