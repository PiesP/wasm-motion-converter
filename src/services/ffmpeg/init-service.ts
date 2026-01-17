import type { FFmpeg } from '@ffmpeg/ffmpeg';
import {
  clearFFmpegCache,
  type FFmpegCoreVariant,
  loadFFmpegClassWorker,
  loadFFmpegCoreAsset,
} from '@services/ffmpeg/core-assets-service';
import {
  installSecurityPolicyViolationLogger,
  installWorkerDiagnostics,
} from '@services/ffmpeg/init-diagnostics-service';
import { verifyWorkerIsolation } from '@services/ffmpeg/worker-isolation-service';
import {
  checkSWReadiness,
  isLikelyFirstVisit,
  waitForSWReady,
} from '@services/sw/sw-readiness-service';
import { TIMEOUT_FFMPEG_INIT } from '@utils/constants';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { performanceTracker } from '@utils/performance-tracker';
import { withTimeout } from '@utils/with-timeout';

const ASSET_PROGRESS_MAX = 90;
const INIT_PROGRESS_START = 92;
const INIT_PROGRESS_END = 99;
const INIT_HEARTBEAT_INTERVAL_MS = 1_200;
const INIT_HEARTBEAT_STEP_MS = 4_000;
const INIT_SLOW_LOAD_TIMEOUT_MS = 15_000;
const INIT_SLOW_NETWORK_DELAY_MS = 12_000;
const INIT_STATUS_URL_PREVIEW_LENGTH = 50;
const INIT_TIME_WARNING_THRESHOLD = 7;
const PROGRESS_MIN = 0;
const PROGRESS_MAX = 100;
const DOWNLOAD_STATUS_THRESHOLD = 25;
const INIT_PROGRESS_WORKER_CHECK = 2;
const NETWORK_SLOW_STATUS =
  'Network seems slow. If this persists, check your connection or firewall.';
const STATUS_WAITING_SW = 'Waiting for Service Worker to take control...';
const STATUS_SW_READY = 'Service Worker active. Continuing initialization...';
const STATUS_DOWNLOAD_PREFIX = 'Downloading FFmpeg assets';
const STATUS_VALIDATING_ASSETS = 'Validating FFmpeg assets...';
const STATUS_INIT_RUNTIME = 'Initializing FFmpeg runtime...';
const STATUS_INIT_DONE = 'FFmpeg ready.';
const STATUS_SW_NOT_READY =
  'Service Worker not ready. Continuing without offline cache (refresh later to enable it).';
const STATUS_INIT_SLOW = 'Still initializing FFmpeg runtime (first run can take up to a minute)...';
const ERROR_OFFLINE_FIRST_VISIT =
  'Cannot initialize FFmpeg while offline on first visit. ' +
  'Please connect to the internet and try again. ' +
  'After the first conversion, offline conversions will work.';
const ERROR_WORKER_LOAD_FAILED =
  'Failed to load FFmpeg worker. Please refresh the page and try again. ' +
  'If the problem persists, check your browser settings or try a different browser.';
const ERROR_WORKER_TERMINATED =
  'FFmpeg worker failed to initialize. This is often caused by blocked module/blob workers ' +
  'or strict browser security settings. Try disabling ad blockers, using an InPrivate window, ' +
  'or testing another browser.';
const ERROR_CACHE_CORRUPT =
  'FFmpeg cache may be corrupted. Cache has been cleared. ' +
  'Please refresh the page to re-download FFmpeg assets.';
const ERROR_OFFLINE_GENERIC =
  'Cannot complete FFmpeg initialization while offline. ' +
  'Please connect to the internet or try again after caching is complete.';

type InitEnvironmentSnapshot = {
  online?: boolean;
  visibilityState?: DocumentVisibilityState;
  documentHidden?: boolean;
  hasFocus?: boolean;
  isSecureContext?: boolean;
  hardwareConcurrency?: number;
  deviceMemoryGB?: number;
  isLikelyFirstVisit?: boolean;
  swReadiness?: ReturnType<typeof checkSWReadiness>;
  connection?: {
    effectiveType?: string;
    downlinkMbps?: number;
    rttMs?: number;
    saveData?: boolean;
  };
};

const getInitEnvironmentSnapshot = (): InitEnvironmentSnapshot => {
  if (typeof navigator === 'undefined') {
    return {};
  }

  const navigatorWithMemory = navigator as Navigator & {
    deviceMemory?: number;
    connection?: {
      effectiveType?: string;
      downlink?: number;
      rtt?: number;
      saveData?: boolean;
    };
  };

  const hasDocument = typeof document !== 'undefined';
  const connection = navigatorWithMemory.connection;

  return {
    online: navigator.onLine,
    visibilityState: hasDocument ? document.visibilityState : undefined,
    documentHidden: hasDocument ? document.hidden : undefined,
    hasFocus:
      hasDocument && typeof document.hasFocus === 'function' ? document.hasFocus() : undefined,
    isSecureContext: typeof isSecureContext !== 'undefined' ? isSecureContext : undefined,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGB: navigatorWithMemory.deviceMemory,
    isLikelyFirstVisit: isLikelyFirstVisit(),
    swReadiness: checkSWReadiness(),
    connection: connection
      ? {
          effectiveType: connection.effectiveType,
          downlinkMbps: connection.downlink,
          rttMs: connection.rtt,
          saveData: connection.saveData,
        }
      : undefined,
  };
};

const SW_CONTROL_TIMEOUT_MS = 30_000;

const ensureServiceWorkerControl = async (callbacks: FFmpegInitCallbacks): Promise<void> => {
  const readiness = checkSWReadiness();

  if (!readiness.isSupported) {
    logger.warn('ffmpeg', 'Service Workers not supported; skipping SW gate');
    return;
  }

  if (readiness.isReady) {
    return;
  }

  callbacks.reportStatus(STATUS_WAITING_SW);
  logger.info('ffmpeg', 'Waiting for Service Worker control before FFmpeg init', {
    timeoutMs: SW_CONTROL_TIMEOUT_MS,
    readiness,
  });

  const swReady = await waitForSWReady(SW_CONTROL_TIMEOUT_MS);

  if (!swReady) {
    logger.warn('ffmpeg', 'Service Worker not ready; continuing FFmpeg init without SW control', {
      timeoutMs: SW_CONTROL_TIMEOUT_MS,
      readiness: checkSWReadiness(),
      initSnapshot: getInitEnvironmentSnapshot(),
    });
    callbacks.reportStatus(STATUS_SW_NOT_READY);
    return;
  }

  callbacks.reportStatus(STATUS_SW_READY);
};

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
  coreVariant?: FFmpegCoreVariant;
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
  const coreVariant: FFmpegCoreVariant = options.coreVariant ?? 'mt';
  let downloadProgress = 0;
  let initHeartbeatId: ReturnType<typeof setInterval> | number | null = null;
  let initStatusTimeoutId: ReturnType<typeof setTimeout> | number | null = null;
  let visibilityChangeHandler: (() => void) | null = null;
  let removeSecurityPolicyListener: (() => void) | null = null;

  const reportProgress = (value: number): void => {
    const clamped = Math.min(PROGRESS_MAX, Math.max(PROGRESS_MIN, Math.round(value)));
    callbacks.reportProgress(clamped);
  };

  const applyDownloadProgress = (weight: number, message: string) => (url: string) => {
    downloadProgress = Math.min(ASSET_PROGRESS_MAX, downloadProgress + weight);
    reportProgress(downloadProgress);
    callbacks.reportStatus(message);
    return url;
  };

  const resolveFFmpegAssets = async (): Promise<[string, string, string, string]> => {
    const coreLabel = coreVariant === 'mt' ? 'multithreaded' : 'single-threaded';
    callbacks.reportStatus(`${STATUS_DOWNLOAD_PREFIX} (${coreLabel}) from CDN...`);

    performanceTracker.startPhase('ffmpeg-download', {
      cdn: 'unified-system',
      core: coreVariant,
    });
    logger.performance('Starting FFmpeg asset download (unified CDN system with 4-CDN cascade)');

    // Load all three assets in parallel
    // Each asset will try all 4 CDN providers (esm.sh → jsdelivr → unpkg → skypack)
    return await Promise.all([
      loadFFmpegClassWorker().then(applyDownloadProgress(10, 'FFmpeg class worker downloaded.')),
      loadFFmpegCoreAsset(
        'ffmpeg-core.js',
        'text/javascript',
        'FFmpeg core script',
        coreVariant
      ).then(applyDownloadProgress(10, 'FFmpeg core script downloaded.')),
      loadFFmpegCoreAsset(
        'ffmpeg-core.wasm',
        'application/wasm',
        'FFmpeg core WASM',
        coreVariant
      ).then(applyDownloadProgress(60, 'FFmpeg core WASM downloaded.')),
      loadFFmpegCoreAsset(
        'ffmpeg-core.worker.js',
        'text/javascript',
        'FFmpeg worker',
        coreVariant
      ).then(applyDownloadProgress(10, 'FFmpeg worker downloaded.')),
    ]);
  };

  const slowNetworkTimer =
    typeof window !== 'undefined'
      ? window.setTimeout(() => {
          if (downloadProgress < DOWNLOAD_STATUS_THRESHOLD) {
            callbacks.reportStatus(NETWORK_SLOW_STATUS);
          }
        }, INIT_SLOW_NETWORK_DELAY_MS)
      : null;

  try {
    if (typeof document !== 'undefined') {
      visibilityChangeHandler = () => {
        logger.info('ffmpeg', 'Document visibility changed during FFmpeg init', {
          visibilityState: document.visibilityState,
          documentHidden: document.hidden,
          hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : undefined,
        });
      };
      document.addEventListener('visibilitychange', visibilityChangeHandler);
    }

    removeSecurityPolicyListener = installSecurityPolicyViolationLogger('ffmpeg-init');

    logger.debug('ffmpeg', 'FFmpeg init preflight snapshot', getInitEnvironmentSnapshot());
    await ensureServiceWorkerControl(callbacks);

    callbacks.reportStatus('Checking FFmpeg worker environment...');
    logger.debug('ffmpeg', 'FFmpeg init environment snapshot', getInitEnvironmentSnapshot());
    reportProgress(INIT_PROGRESS_WORKER_CHECK);
    await verifyWorkerIsolation();

    reportProgress(INIT_PROGRESS_WORKER_CHECK);
    const [classWorkerUrl, coreUrl, wasmUrl, workerUrl] = await resolveFFmpegAssets();
    performanceTracker.endPhase('ffmpeg-download');
    logger.performance('FFmpeg asset download complete');

    // Validate blob URLs are accessible before passing to ffmpeg.load()
    callbacks.reportStatus(STATUS_VALIDATING_ASSETS);
    await Promise.all([
      validateBlobUrl(classWorkerUrl, 'classWorker'),
      validateBlobUrl(coreUrl, 'core'),
      validateBlobUrl(wasmUrl, 'wasm'),
      validateBlobUrl(workerUrl, 'worker'),
    ]);
    logger.debug('ffmpeg', 'All blob URLs validated successfully');

    const initBaseProgress = Math.max(downloadProgress, INIT_PROGRESS_START);
    reportProgress(initBaseProgress);
    callbacks.reportStatus(STATUS_INIT_RUNTIME);

    const initStartTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let initProgress = initBaseProgress;

    if (typeof window !== 'undefined') {
      initHeartbeatId = window.setInterval(() => {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const elapsedMs = now - initStartTime;
        const progressBoost = Math.min(
          INIT_TIME_WARNING_THRESHOLD,
          Math.floor(elapsedMs / INIT_HEARTBEAT_STEP_MS)
        );
        const nextProgress = Math.min(INIT_PROGRESS_END, initBaseProgress + progressBoost);
        if (nextProgress > initProgress) {
          initProgress = nextProgress;
          reportProgress(nextProgress);
        }
      }, INIT_HEARTBEAT_INTERVAL_MS);

      initStatusTimeoutId = window.setTimeout(() => {
        callbacks.reportStatus(STATUS_INIT_SLOW);
        logger.warn('ffmpeg', 'FFmpeg initialization taking longer than expected', {
          elapsedMs: Math.round(
            (typeof performance !== 'undefined' ? performance.now() : Date.now()) - initStartTime
          ),
          initSnapshot: getInitEnvironmentSnapshot(),
        });
      }, INIT_SLOW_LOAD_TIMEOUT_MS);
    }

    performanceTracker.startPhase('ffmpeg-init');
    logger.performance('Starting FFmpeg initialization');

    logger.debug('ffmpeg', 'Calling ffmpeg.load() with blob URLs', {
      classWorkerUrl: classWorkerUrl.substring(0, INIT_STATUS_URL_PREVIEW_LENGTH),
      coreUrl: coreUrl.substring(0, INIT_STATUS_URL_PREVIEW_LENGTH),
      wasmUrl: wasmUrl.substring(0, INIT_STATUS_URL_PREVIEW_LENGTH),
      workerUrl: workerUrl.substring(0, INIT_STATUS_URL_PREVIEW_LENGTH),
    });

    const loadStartTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const restoreWorkerDiagnostics = installWorkerDiagnostics({
      phase: 'ffmpeg-load',
      knownWorkerUrls: {
        [classWorkerUrl]: 'ffmpeg-class-worker',
        [workerUrl]: 'ffmpeg-core-worker',
      },
    });

    try {
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
        () => {
          logger.warn('ffmpeg', 'FFmpeg load timed out', {
            downloadProgress,
            coreVariant,
            initSnapshot: getInitEnvironmentSnapshot(),
          });
          options.terminate();
        }
      );
    } catch (error) {
      const elapsedMs = Math.round(
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) - loadStartTime
      );
      logger.error('ffmpeg', 'FFmpeg load failed', {
        elapsedMs,
        coreVariant,
        error: getErrorMessage(error),
        initSnapshot: getInitEnvironmentSnapshot(),
      });
      throw error;
    } finally {
      restoreWorkerDiagnostics();
    }

    const loadElapsedMs = Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - loadStartTime
    );
    logger.debug('ffmpeg', 'FFmpeg load resolved', {
      elapsedMs: loadElapsedMs,
      coreVariant,
    });

    performanceTracker.endPhase('ffmpeg-init');
    logger.performance('FFmpeg initialization complete');

    reportProgress(PROGRESS_MAX);
    callbacks.reportStatus(STATUS_INIT_DONE);
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
        throw new Error(ERROR_OFFLINE_FIRST_VISIT);
      }
      throw new Error(ERROR_WORKER_LOAD_FAILED);
    }

    if (errorMsg.includes('called FFmpeg.terminate()')) {
      throw new Error(ERROR_WORKER_TERMINATED);
    }

    // Handle cache corruption errors
    if (errorMsg.includes('Blob URL') || errorMsg.includes('Cache may be corrupted')) {
      // Clear cache for recovery
      await clearFFmpegCache();
      throw new Error(ERROR_CACHE_CORRUPT);
    }

    // Generic offline error
    if (isOffline) {
      throw new Error(ERROR_OFFLINE_GENERIC);
    }

    throw error;
  } finally {
    if (slowNetworkTimer) {
      clearTimeout(slowNetworkTimer);
    }
    if (initHeartbeatId) {
      clearInterval(initHeartbeatId);
    }
    if (initStatusTimeoutId) {
      clearTimeout(initStatusTimeoutId);
    }
    if (visibilityChangeHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', visibilityChangeHandler);
    }
    if (removeSecurityPolicyListener) {
      removeSecurityPolicyListener();
    }
  }
}
