import { ffmpegService } from '@services/ffmpeg-service';
import { checkPerformance, getRecommendedSettings } from '@services/performance-checker-service';
import { analyzeVideo, analyzeVideoQuick } from '@services/video-analyzer-service';
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

import type { ConversionRuntimeController } from './conversion-runtime-controller';

/** Small file size threshold for quick analysis bypass (50 MB). */
const SMALL_FILE_SIZE_THRESHOLD = 50 * 1024 * 1024;

/** Short video duration threshold for quick analysis bypass (15 seconds). */
const SHORT_VIDEO_DURATION = 15;

function resetErrorState(): void {
  setErrorMessage(null);
  setErrorContext(null);
}

function resetAnalysisState(): void {
  setVideoMetadata(null);
  setPerformanceWarnings([]);
  setAutoAppliedRecommendation(false);
}

function resetOutputState(): void {
  setLoadingProgress(0);
  setLoadingStatusMessage('');
}

function shouldRunFullAnalysis(file: File, metadata: VideoMetadata | null): boolean {
  if (!metadata) {
    return true;
  }

  // Quick analysis intentionally does not provide codec/fps/bitrate.
  // Only require full analysis when we are missing basic fields.
  if (metadata.width <= 0 || metadata.height <= 0 || metadata.duration <= 0) {
    return true;
  }

  const isSmallFile = file.size <= SMALL_FILE_SIZE_THRESHOLD;
  const isShort = metadata.duration > 0 ? metadata.duration <= SHORT_VIDEO_DURATION : false;
  const isLowRes = metadata.width * metadata.height <= WARN_RESOLUTION_PIXELS;
  return !(isSmallFile && isShort && isLowRes);
}

/**
 * Handle file selection.
 *
 * Validates file, initializes FFmpeg if needed, analyzes video metadata,
 * and applies recommended settings.
 */
export async function handleFileSelected(
  file: File,
  runtime: ConversionRuntimeController
): Promise<void> {
  runtime.resetRuntimeState();
  resetErrorState();
  resetAnalysisState();
  resetOutputState();

  const validation = validateVideoFile(file);
  if (!validation.valid) {
    setErrorMessage(getErrorMessage(validation.error));
    setAppState('error');
    queueMicrotask(() => {
      document.querySelector<HTMLButtonElement>('[data-error-retry-button]')?.focus();
    });
    return;
  }

  await ffmpegService.clearCachedInput();

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

    let quickMetadata: VideoMetadata | null = null;
    const quickAnalysisPromise = analyzeVideoQuick(file)
      .then((metadata) => {
        quickMetadata = metadata;
        setVideoMetadata(metadata);
        setPerformanceWarnings(checkPerformance(file, metadata));
        return metadata;
      })
      .catch(() => null);

    await Promise.all([initPromise, quickAnalysisPromise]);

    const requiresFullAnalysis = shouldRunFullAnalysis(file, quickMetadata);
    let finalMetadata: VideoMetadata | null = quickMetadata;

    if (requiresFullAnalysis) {
      setAppState('analyzing');
      const metadata = await analyzeVideo(file);
      finalMetadata = metadata;
      setVideoMetadata(metadata);
      setPerformanceWarnings(checkPerformance(file, metadata));
    }

    if (finalMetadata) {
      const recommendation = getRecommendedSettings(file, finalMetadata, conversionSettings());
      const applied = Boolean(recommendation);
      setAutoAppliedRecommendation(applied);
      if (recommendation) {
        setConversionSettings(recommendation);
      }
    }

    setAppState('idle');
  } catch (error) {
    setErrorMessage(getErrorMessage(error));
    setAppState('error');
    queueMicrotask(() => {
      document.querySelector<HTMLButtonElement>('[data-error-retry-button]')?.focus();
    });
  }
}
