import type { FFmpeg } from '@ffmpeg/ffmpeg';

import { TIMEOUT_FFMPEG_INIT } from '@utils/constants';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { performanceTracker } from '@utils/performance-tracker';
import { withTimeout } from '@utils/with-timeout';
import { waitForSWReady, isLikelyFirstVisit } from '@services/sw/sw-readiness';
import { clearFFmpegCache, loadFFmpegAsset, loadFFmpegClassWorker } from './core-assets';
import { verifyWorkerIsolation } from './worker-isolation';

/**
 * Validate that a blob URL is accessible before passing to ffmpeg.load().
 * Catches corrupted cache entries that create invalid blob URLs.
 */
async function validateBlobUrl(url: string, label: string): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Blob URL not accessible: ${response.status}`);
    }
  } catch (error) {
    logger.error('ffmpeg', `Blob URL validation failed for ${label}`, {
      url: url.substring(0, 50),
      error: getErrorMessage(error),
    });
    throw new Error(`Failed to validate ${label} blob URL. Cache may be corrupted.`);
  }
}

export type FFmpegInitCallbacks = {
  reportProgress: (progress: number) => void;
  reportStatus: (message: string) => void;
};

export type FFmpegInitOptions = {
  terminate: () => void;
};

/**
 * Initialize an FFmpeg instance by verifying worker isolation, downloading core assets,
 * and calling `ffmpeg.load()` with timeout protection.
 */
export async function initializeFFmpegRuntime(
  ffmpeg: FFmpeg,
  callbacks: FFmpegInitCallbacks,
  options: FFmpegInitOptions
): Promise<void> {
  let downloadProgress = 0;

  const reportProgress = (value: number): void => {
    const clamped = Math.min(100, Math.max(0, Math.round(value)));
    callbacks.reportProgress(clamped);
  };

  const applyDownloadProgress = (weight: number, message: string) => (url: string) => {
    downloadProgress = Math.min(90, downloadProgress + weight);
    reportProgress(downloadProgress);
    callbacks.reportStatus(message);
    return url;
  };

  const resolveFFmpegAssets = async (): Promise<[string, string, string, string]> => {
    callbacks.reportStatus('Downloading FFmpeg assets from CDN...');

    performanceTracker.startPhase('ffmpeg-download', { cdn: 'unified-system' });
    logger.performance('Starting FFmpeg asset download (unified CDN system with 4-CDN cascade)');

    // Load all three assets in parallel
    // Each asset will try all 4 CDN providers (esm.sh → jsdelivr → unpkg → skypack)
    return await Promise.all([
      loadFFmpegClassWorker().then(applyDownloadProgress(10, 'FFmpeg class worker downloaded.')),
      loadFFmpegAsset('ffmpeg-core.js', 'text/javascript', 'FFmpeg core script').then(
        applyDownloadProgress(10, 'FFmpeg core script downloaded.')
      ),
      loadFFmpegAsset('ffmpeg-core.wasm', 'application/wasm', 'FFmpeg core WASM').then(
        applyDownloadProgress(60, 'FFmpeg core WASM downloaded.')
      ),
      loadFFmpegAsset('ffmpeg-core.worker.js', 'text/javascript', 'FFmpeg worker').then(
        applyDownloadProgress(10, 'FFmpeg worker downloaded.')
      ),
    ]);
  };

  const slowNetworkTimer =
    typeof window !== 'undefined'
      ? window.setTimeout(() => {
          if (downloadProgress < 25) {
            callbacks.reportStatus(
              'Network seems slow. If this persists, check your connection or firewall.'
            );
          }
        }, 12_000)
      : null;

  try {
    // CRITICAL: Wait for Service Worker on first visit
    // This prevents CORS errors when loading @ffmpeg/ffmpeg from CDN
    if (isLikelyFirstVisit()) {
      callbacks.reportStatus('Preparing app for first use...');
      const swReady = await waitForSWReady(5000);

      if (!swReady) {
        logger.warn('ffmpeg', 'Service Worker not ready; first conversion may fail', {
          timeoutMs: 5000,
        });
        callbacks.reportStatus(
          'Service Worker not ready. If conversion fails, please refresh and try again.'
        );
      } else {
        callbacks.reportStatus('App ready. Starting conversion...');
      }
    }

    callbacks.reportStatus('Checking FFmpeg worker environment...');
    reportProgress(2);
    await verifyWorkerIsolation();

    reportProgress(5);
    const [classWorkerUrl, coreUrl, wasmUrl, workerUrl] = await resolveFFmpegAssets();
    performanceTracker.endPhase('ffmpeg-download');
    logger.performance('FFmpeg asset download complete');

    // Validate blob URLs are accessible before passing to ffmpeg.load()
    callbacks.reportStatus('Validating FFmpeg assets...');
    await Promise.all([
      validateBlobUrl(classWorkerUrl, 'classWorker'),
      validateBlobUrl(coreUrl, 'core'),
      validateBlobUrl(wasmUrl, 'wasm'),
      validateBlobUrl(workerUrl, 'worker'),
    ]);
    logger.debug('ffmpeg', 'All blob URLs validated successfully');

    reportProgress(Math.max(downloadProgress, 90));
    callbacks.reportStatus('Initializing FFmpeg runtime...');

    performanceTracker.startPhase('ffmpeg-init');
    logger.performance('Starting FFmpeg initialization');

    logger.debug('ffmpeg', 'Calling ffmpeg.load() with blob URLs', {
      classWorkerUrl: classWorkerUrl.substring(0, 50),
      coreUrl: coreUrl.substring(0, 50),
      wasmUrl: wasmUrl.substring(0, 50),
      workerUrl: workerUrl.substring(0, 50),
    });

    await withTimeout(
      ffmpeg.load({
        classWorkerURL: classWorkerUrl,
        coreURL: coreUrl,
        wasmURL: wasmUrl,
        workerURL: workerUrl,
      }),
      TIMEOUT_FFMPEG_INIT,
      `FFmpeg initialization timed out after ${
        TIMEOUT_FFMPEG_INIT / 1000
      } seconds. Please check your internet connection and try again.`,
      () => options.terminate()
    );

    performanceTracker.endPhase('ffmpeg-init');
    logger.performance('FFmpeg initialization complete');

    reportProgress(100);
    callbacks.reportStatus('FFmpeg ready.');
  } catch (error) {
    options.terminate();

    logger.error('ffmpeg', 'FFmpeg initialization failed', {
      error: getErrorMessage(error),
    });

    const errorMsg = error instanceof Error ? error.message : String(error);

    // Check if offline
    const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;

    // ENHANCED: Detect worker CORS errors
    if (errorMsg.includes('Worker') && errorMsg.includes('cannot be accessed')) {
      if (isOffline) {
        throw new Error(
          'Cannot initialize FFmpeg while offline on first visit. ' +
            'Please connect to the internet and try again. ' +
            'After the first conversion, offline conversions will work.'
        );
      } else {
        throw new Error(
          'Failed to load FFmpeg worker. Please refresh the page and try again. ' +
            'If the problem persists, check your browser settings or try a different browser.'
        );
      }
    }

    if (errorMsg.includes('called FFmpeg.terminate()')) {
      throw new Error(
        'FFmpeg worker failed to initialize. This is often caused by blocked module/blob workers ' +
          'or strict browser security settings. Try disabling ad blockers, using an InPrivate window, ' +
          'or testing another browser.'
      );
    }

    // Handle cache corruption errors
    if (errorMsg.includes('Blob URL') || errorMsg.includes('Cache may be corrupted')) {
      // Clear cache for recovery
      await clearFFmpegCache();
      throw new Error(
        'FFmpeg cache may be corrupted. Cache has been cleared. ' +
          'Please refresh the page to re-download FFmpeg assets.'
      );
    }

    // Generic offline error
    if (isOffline) {
      throw new Error(
        'Cannot complete FFmpeg initialization while offline. ' +
          'Please connect to the internet or try again after caching is complete.'
      );
    }

    throw error;
  } finally {
    if (slowNetworkTimer) {
      clearTimeout(slowNetworkTimer);
    }
  }
}
