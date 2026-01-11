import type { FFmpeg } from '@ffmpeg/ffmpeg';

import { FFMPEG_CORE_BASE_URLS, TIMEOUT_FFMPEG_INIT } from '@utils/constants';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { performanceTracker } from '@utils/performance-tracker';
import { withTimeout } from '@utils/with-timeout';
import { loadFFmpegAsset } from './core-assets';
import { verifyWorkerIsolation } from './worker-isolation';

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

  const resolveFFmpegAssets = async (): Promise<[string, string, string]> => {
    let lastError: unknown;

    for (const baseUrl of FFMPEG_CORE_BASE_URLS) {
      try {
        const hostLabel = (() => {
          try {
            return new URL(baseUrl).host;
          } catch {
            return baseUrl;
          }
        })();

        callbacks.reportStatus(`Downloading FFmpeg assets from ${hostLabel}...`);

        performanceTracker.startPhase('ffmpeg-download', { cdn: hostLabel });
        logger.performance(`Starting FFmpeg asset download from ${hostLabel}`);

        return await Promise.all([
          loadFFmpegAsset(
            `${baseUrl}/ffmpeg-core.js`,
            'text/javascript',
            'FFmpeg core script'
          ).then(applyDownloadProgress(10, 'FFmpeg core script downloaded.')),
          loadFFmpegAsset(
            `${baseUrl}/ffmpeg-core.wasm`,
            'application/wasm',
            'FFmpeg core WASM'
          ).then(applyDownloadProgress(60, 'FFmpeg core WASM downloaded.')),
          loadFFmpegAsset(
            `${baseUrl}/ffmpeg-core.worker.js`,
            'text/javascript',
            'FFmpeg worker'
          ).then(applyDownloadProgress(10, 'FFmpeg worker downloaded.')),
        ]);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error('Unable to download FFmpeg assets from available CDNs.');
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
    callbacks.reportStatus('Checking FFmpeg worker environment...');
    reportProgress(2);
    await verifyWorkerIsolation();

    reportProgress(5);
    const [coreUrl, wasmUrl, workerUrl] = await resolveFFmpegAssets();
    performanceTracker.endPhase('ffmpeg-download');
    logger.performance('FFmpeg asset download complete');

    reportProgress(Math.max(downloadProgress, 90));
    callbacks.reportStatus('Initializing FFmpeg runtime...');

    performanceTracker.startPhase('ffmpeg-init');
    logger.performance('Starting FFmpeg initialization');

    await withTimeout(
      ffmpeg.load({
        coreURL: coreUrl,
        wasmURL: wasmUrl,
        workerURL: workerUrl,
      }),
      TIMEOUT_FFMPEG_INIT,
      `FFmpeg initialization timed out after ${TIMEOUT_FFMPEG_INIT / 1000} seconds. Please check your internet connection and try again.`,
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

    if (error instanceof Error && error.message.includes('called FFmpeg.terminate()')) {
      throw new Error(
        'FFmpeg worker failed to initialize. This is often caused by blocked module/blob workers or strict browser security settings. Try disabling ad blockers, using an InPrivate window, or testing another browser.'
      );
    }

    throw error;
  } finally {
    if (slowNetworkTimer) {
      clearTimeout(slowNetworkTimer);
    }
  }
}
