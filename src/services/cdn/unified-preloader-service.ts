/**
 * Unified CDN Preloader Service
 *
 * Preloads all external dependencies at app startup to ensure
 * reliable operation. Runs after Service Worker is ready.
 *
 * Features:
 * - Preloads FFmpeg core, encoders, and demuxers
 * - Progress callbacks for UI feedback
 * - Cache-aware loading (fast on return visits)
 * - Validates cached assets before reporting complete
 */

import { buildRuntimeModuleUrls } from '@services/cdn/runtime-dep-urls-service';
import { loadFFmpegAsset, loadFFmpegClassWorker } from '@services/ffmpeg/core-assets-service';
import { ffmpegService } from '@services/ffmpeg-service';
import { waitForSWReady } from '@services/sw/sw-readiness-service';
import { loadFromCDN } from '@utils/cdn-loader';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

/**
 * Preload progress state
 */
export interface PreloadProgress {
  phase: 'waiting-sw' | 'downloading' | 'initializing-ffmpeg' | 'validating' | 'complete' | 'error';
  currentFile: string;
  completedFiles: number;
  totalFiles: number;
  percentage: number;
  error?: string;
}

export type PreloadProgressCallback = (progress: PreloadProgress) => void;

/**
 * Asset definition for preloading
 */
interface PreloadAsset {
  id: string;
  label: string;
  load: () => Promise<unknown>;
  weight: number; // Relative weight for progress calculation
}

/**
 * All assets to preload
 * Weights are approximate relative sizes for progress calculation
 */
const PRELOAD_ASSETS: PreloadAsset[] = [
  // FFmpeg core assets (largest, highest priority)
  {
    id: 'ffmpeg-wasm',
    label: 'FFmpeg core (WASM)',
    load: () => loadFFmpegAsset('ffmpeg-core.wasm', 'application/wasm', 'FFmpeg core WASM'),
    weight: 85, // ~31MB out of ~32MB total
  },
  {
    id: 'ffmpeg-js',
    label: 'FFmpeg core (JS)',
    load: () => loadFFmpegAsset('ffmpeg-core.js', 'text/javascript', 'FFmpeg core script'),
    weight: 3,
  },
  {
    id: 'ffmpeg-worker',
    label: 'FFmpeg worker',
    load: () => loadFFmpegAsset('ffmpeg-core.worker.js', 'text/javascript', 'FFmpeg worker'),
    weight: 2,
  },
  {
    id: 'ffmpeg-class-worker',
    label: 'FFmpeg class worker',
    load: loadFFmpegClassWorker,
    weight: 2,
  },
  // Encoder libraries (loaded via import for now)
  {
    id: 'modern-gif',
    label: 'GIF encoder',
    load: () => import('modern-gif'),
    weight: 3,
  },
  // Demuxer libraries (loaded from CDN)
  {
    id: 'mp4box',
    label: 'MP4 demuxer',
    load: () => loadFromCDN('mp4box.js', buildRuntimeModuleUrls('mp4box')),
    weight: 2,
  },
  {
    id: 'web-demuxer',
    label: 'WebM demuxer',
    load: () => loadFromCDN('web-demuxer', buildRuntimeModuleUrls('web-demuxer')),
    weight: 1,
  },
];

/**
 * Preload state singleton
 */
let preloadComplete = false;
let preloadInProgress = false;
let preloadError: string | null = null;

/**
 * Check if preload has completed successfully
 */
export function isPreloadComplete(): boolean {
  return preloadComplete;
}

/**
 * Calculate total weight for progress
 */
const totalWeight = PRELOAD_ASSETS.reduce((sum, asset) => sum + asset.weight, 0);

/**
 * Preload all external dependencies
 *
 * @param onProgress - Optional progress callback
 * @returns Promise that resolves when all assets are loaded
 */
export async function preloadAllDependencies(onProgress?: PreloadProgressCallback): Promise<void> {
  if (preloadComplete) {
    logger.debug('general', 'Preload already complete, skipping');
    onProgress?.({
      phase: 'complete',
      currentFile: '',
      completedFiles: PRELOAD_ASSETS.length,
      totalFiles: PRELOAD_ASSETS.length,
      percentage: 100,
    });
    return;
  }

  if (preloadInProgress) {
    logger.debug('general', 'Preload already in progress');
    return;
  }

  preloadInProgress = true;
  preloadError = null;

  const emitProgress = (progress: PreloadProgress): void => {
    if (!onProgress) {
      return;
    }

    try {
      onProgress(progress);
    } catch (error) {
      logger.warn('general', 'Progress callback error', {
        error: getErrorMessage(error),
      });
    }
  };

  try {
    // Phase 1: Wait for Service Worker
    emitProgress({
      phase: 'waiting-sw',
      currentFile: 'Service Worker',
      completedFiles: 0,
      totalFiles: PRELOAD_ASSETS.length,
      percentage: 0,
    });

    logger.info('general', 'Waiting for Service Worker to be ready');
    const swReady = await waitForSWReady(15000);

    if (!swReady) {
      logger.warn('general', 'Service Worker not ready; proceeding anyway');
    } else {
      logger.info('general', 'Service Worker ready');
    }

    // Phase 2: Download assets
    let completedWeight = 0;
    let completedCount = 0;

    for (const asset of PRELOAD_ASSETS) {
      emitProgress({
        phase: 'downloading',
        currentFile: asset.label,
        completedFiles: completedCount,
        totalFiles: PRELOAD_ASSETS.length,
        percentage: Math.round((completedWeight / totalWeight) * 100),
      });

      logger.debug('general', `Loading ${asset.label}`, { id: asset.id });

      try {
        await asset.load();
      } catch (error) {
        logger.warn('general', `Failed to load ${asset.label}`, {
          id: asset.id,
          error: getErrorMessage(error),
        });
      } finally {
        completedWeight += asset.weight;
        completedCount++;
      }

      logger.debug('general', `Loaded ${asset.label}`, {
        id: asset.id,
        progress: Math.round((completedWeight / totalWeight) * 100),
      });
    }

    // Phase 3: Initialize FFmpeg runtime
    emitProgress({
      phase: 'initializing-ffmpeg',
      currentFile: 'FFmpeg runtime',
      completedFiles: PRELOAD_ASSETS.length,
      totalFiles: PRELOAD_ASSETS.length,
      percentage: 95,
    });

    logger.info('general', 'Initializing FFmpeg runtime');

    try {
      await ffmpegService.initialize(
        (progress) => {
          // Map 0-100 init progress to 95-99 overall
          const mappedProgress = 95 + Math.round(progress * 0.04);
          emitProgress({
            phase: 'initializing-ffmpeg',
            currentFile: 'FFmpeg runtime',
            completedFiles: PRELOAD_ASSETS.length,
            totalFiles: PRELOAD_ASSETS.length,
            percentage: Math.min(mappedProgress, 99),
          });
        },
        (status) => {
          emitProgress({
            phase: 'initializing-ffmpeg',
            currentFile: status,
            completedFiles: PRELOAD_ASSETS.length,
            totalFiles: PRELOAD_ASSETS.length,
            percentage: 98,
          });
        }
      );
      logger.info('general', 'FFmpeg runtime initialized');
    } catch (ffmpegError) {
      // Log but don't fail - FFmpeg can be initialized on-demand when selecting a file
      logger.warn(
        'general',
        'FFmpeg initialization failed during preload, will retry on file selection',
        {
          error: getErrorMessage(ffmpegError),
        }
      );
    }

    // Phase 4: Complete
    preloadComplete = true;
    preloadInProgress = false;

    emitProgress({
      phase: 'complete',
      currentFile: '',
      completedFiles: PRELOAD_ASSETS.length,
      totalFiles: PRELOAD_ASSETS.length,
      percentage: 100,
    });

    logger.info('general', 'All dependencies preloaded successfully');
  } catch (error) {
    preloadInProgress = false;
    preloadError = getErrorMessage(error);

    emitProgress({
      phase: 'error',
      currentFile: '',
      completedFiles: 0,
      totalFiles: PRELOAD_ASSETS.length,
      percentage: 0,
      error: preloadError,
    });

    logger.error('general', 'Preload failed', { error: preloadError });
    throw error;
  }
}
