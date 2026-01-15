import type { FFmpeg } from '@ffmpeg/ffmpeg';

import { TIMEOUT_FFMPEG_INIT } from '@utils/constants';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { performanceTracker } from '@utils/performance-tracker';
import { withTimeout } from '@utils/with-timeout';
import { checkSWReadiness, isLikelyFirstVisit, waitForSWReady } from '@services/sw/sw-readiness';
import {
  clearFFmpegCache,
  loadFFmpegClassWorker,
  loadFFmpegCoreAsset,
  type FFmpegCoreVariant,
} from './core-assets';
import { verifyWorkerIsolation } from './worker-isolation';

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

  callbacks.reportStatus('Waiting for Service Worker to take control...');
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
    callbacks.reportStatus(
      'Service Worker not ready. Continuing without offline cache (refresh later to enable it).'
    );
    return;
  }

  callbacks.reportStatus('Service Worker active. Continuing initialization...');
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

type WorkerDiagnosticsOptions = {
  phase: string;
  knownWorkerUrls?: Record<string, string>;
};

type PermissionsPolicyLike = {
  allowedFeatures?: () => string[];
};

type ScriptAnalysisSummary = {
  byteLength: number;
  lineCount: number;
  importSpecifiersSample: string[];
  importSpecifiersTotal: number;
  relativeImportCount: number;
  absoluteImportCount: number;
  bareImportCount: number;
  hasImportScripts: boolean;
  truncated: boolean;
};

const MAX_SCRIPT_ANALYSIS_CHARS = 200_000;

const summarizeWorkerScript = (source: string): ScriptAnalysisSummary => {
  const truncated = source.length > MAX_SCRIPT_ANALYSIS_CHARS;
  const snippet = truncated ? source.slice(0, MAX_SCRIPT_ANALYSIS_CHARS) : source;

  const specifiers = new Set<string>();
  const importRegexes = [
    /import\s+[^'"\n]+\s+from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]/g,
  ];

  for (const regex of importRegexes) {
    let match: RegExpExecArray | null;
    match = regex.exec(snippet);
    while (match) {
      if (match[1]) {
        specifiers.add(match[1]);
      }
      match = regex.exec(snippet);
    }
  }

  const importScriptsRegex = /importScripts\(([^)]+)\)/g;
  let hasImportScripts = false;
  let importScriptsMatch: RegExpExecArray | null = importScriptsRegex.exec(snippet);
  while (importScriptsMatch) {
    hasImportScripts = true;
    importScriptsMatch = importScriptsRegex.exec(snippet);
  }

  const specifierList = Array.from(specifiers);
  let relativeImportCount = 0;
  let absoluteImportCount = 0;
  let bareImportCount = 0;

  for (const specifier of specifierList) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      relativeImportCount += 1;
    } else if (specifier.startsWith('http:') || specifier.startsWith('https:')) {
      absoluteImportCount += 1;
    } else {
      bareImportCount += 1;
    }
  }

  return {
    byteLength: snippet.length,
    lineCount: snippet.split('\n').length,
    importSpecifiersSample: specifierList.slice(0, 6),
    importSpecifiersTotal: specifierList.length,
    relativeImportCount,
    absoluteImportCount,
    bareImportCount,
    hasImportScripts,
    truncated,
  };
};

const analyzeWorkerScript = async (
  scriptUrl: string,
  label: string,
  phase: string
): Promise<void> => {
  try {
    const response = await fetch(scriptUrl);
    if (!response.ok) {
      throw new Error(`Worker script fetch failed: ${response.status}`);
    }

    const text = await response.text();
    const summary = summarizeWorkerScript(text);
    logger.info('ffmpeg', 'Worker script analysis', {
      phase,
      label,
      scriptUrl: formatWorkerUrl(scriptUrl),
      summary,
    });
  } catch (error) {
    logger.warn('ffmpeg', 'Worker script analysis failed', {
      phase,
      label,
      scriptUrl: formatWorkerUrl(scriptUrl),
      error: getErrorMessage(error),
    });
  }
};

const summarizeWorkerMessage = (data: unknown): Record<string, unknown> => {
  if (data === null) {
    return { kind: 'null' };
  }

  if (typeof data === 'undefined') {
    return { kind: 'undefined' };
  }

  if (typeof data === 'string') {
    return {
      kind: 'string',
      length: data.length,
      preview: data.slice(0, 160),
    };
  }

  if (typeof data === 'number' || typeof data === 'boolean' || typeof data === 'bigint') {
    return { kind: typeof data, value: data };
  }

  if (data instanceof Error) {
    return { kind: 'Error', message: data.message };
  }

  if (data instanceof ArrayBuffer) {
    return { kind: 'ArrayBuffer', byteLength: data.byteLength };
  }

  if (ArrayBuffer.isView(data)) {
    return { kind: data.constructor.name, byteLength: data.byteLength };
  }

  if (typeof data === 'object' && data) {
    const keys = Object.keys(data as Record<string, unknown>);
    return {
      kind: 'object',
      keys: keys.slice(0, 8),
      keysTotal: keys.length,
    };
  }

  return { kind: typeof data };
};

const formatWorkerUrl = (value: string): string => {
  if (value.length <= 90) {
    return value;
  }
  return `${value.slice(0, 70)}...`;
};

const getCspMetaSummary = (): {
  contentLength: number;
  preview: string;
} | null => {
  if (typeof document === 'undefined') {
    return null;
  }

  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  if (!meta || !(meta instanceof HTMLMetaElement) || !meta.content) {
    return null;
  }

  const content = meta.content.trim();
  return {
    contentLength: content.length,
    preview: content.slice(0, 200),
  };
};

const getPermissionsPolicySummary = (): {
  supported: boolean;
  allowedFeaturesCount?: number;
  allowedFeaturesSample?: string[];
} => {
  if (typeof document === 'undefined') {
    return { supported: false };
  }

  const policy = (document as Document & { permissionsPolicy?: PermissionsPolicyLike })
    .permissionsPolicy;
  if (!policy || typeof policy.allowedFeatures !== 'function') {
    return { supported: false };
  }

  const allowedFeatures = policy.allowedFeatures();
  return {
    supported: true,
    allowedFeaturesCount: allowedFeatures.length,
    allowedFeaturesSample: allowedFeatures.slice(0, 10),
  };
};

const installSecurityPolicyViolationLogger = (phase: string): (() => void) => {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
    return () => undefined;
  }

  const handler = (event: SecurityPolicyViolationEvent) => {
    logger.error('ffmpeg', 'Security policy violation during FFmpeg init', {
      phase,
      blockedURI: event.blockedURI,
      effectiveDirective: event.effectiveDirective,
      violatedDirective: event.violatedDirective,
      originalPolicy: event.originalPolicy?.slice(0, 300),
      disposition: event.disposition,
      sourceFile: event.sourceFile,
      lineNumber: event.lineNumber,
      columnNumber: event.columnNumber,
      sample: event.sample,
      statusCode: event.statusCode,
    });
  };

  logger.info('ffmpeg', 'Security policy diagnostics enabled for FFmpeg init', {
    phase,
    cspMeta: getCspMetaSummary(),
    permissionsPolicy: getPermissionsPolicySummary(),
  });

  document.addEventListener('securitypolicyviolation', handler);
  return () => document.removeEventListener('securitypolicyviolation', handler);
};

const installWorkerDiagnostics = ({
  phase,
  knownWorkerUrls = {},
}: WorkerDiagnosticsOptions): (() => void) => {
  const globalScope = globalThis as typeof globalThis & {
    Worker?: typeof Worker;
  };
  const OriginalWorker = globalScope.Worker;

  if (!OriginalWorker) {
    return () => undefined;
  }

  if ((OriginalWorker as { __ffmpegDiagnosticsWrapped?: boolean }).__ffmpegDiagnosticsWrapped) {
    return () => undefined;
  }

  const messageCounts = new WeakMap<Worker, number>();
  const workerScriptUrls = new WeakMap<Worker, string>();
  const workerLabels = new WeakMap<Worker, string>();

  class DiagnosticWorker extends OriginalWorker {
    constructor(scriptURL: string | URL, options?: WorkerOptions) {
      try {
        super(scriptURL, options);
      } catch (error) {
        const urlString = typeof scriptURL === 'string' ? scriptURL : scriptURL.toString();
        const label = knownWorkerUrls[urlString] ?? 'unknown';
        logger.error('ffmpeg', 'Worker construction failed during FFmpeg init', {
          phase,
          label,
          scriptUrl: formatWorkerUrl(urlString),
          options: options ? { type: options.type, name: options.name } : undefined,
          error: getErrorMessage(error),
        });
        throw error;
      }

      const urlString = typeof scriptURL === 'string' ? scriptURL : scriptURL.toString();
      const label = knownWorkerUrls[urlString] ?? 'unknown';

      workerScriptUrls.set(this, urlString);
      workerLabels.set(this, label);

      logger.info('ffmpeg', 'Worker created during FFmpeg init', {
        phase,
        label,
        scriptUrl: formatWorkerUrl(urlString),
        options: options ? { type: options.type, name: options.name } : undefined,
      });

      const logMessage = (event: MessageEvent) => {
        const count = (messageCounts.get(this) ?? 0) + 1;
        messageCounts.set(this, count);

        if (count <= 3) {
          logger.debug('ffmpeg', 'Worker message during FFmpeg init', {
            phase,
            label,
            payload: summarizeWorkerMessage(event.data),
          });
        } else if (count === 4) {
          logger.debug('ffmpeg', 'Worker message logging suppressed (too many messages)', {
            phase,
            label,
          });
        }
      };

      const logMessageError = (event: MessageEvent) => {
        logger.error('ffmpeg', 'Worker messageerror during FFmpeg init', {
          phase,
          label,
          payload: summarizeWorkerMessage(event.data),
        });
      };

      const logError = (event: ErrorEvent) => {
        const scriptUrl = workerScriptUrls.get(this);
        const workerLabel = workerLabels.get(this) ?? label;
        logger.error('ffmpeg', 'Worker error during FFmpeg init', {
          phase,
          label: workerLabel,
          message: event.message,
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          error: event.error ? getErrorMessage(event.error) : undefined,
          isTrusted: event.isTrusted,
        });

        if (scriptUrl) {
          void analyzeWorkerScript(scriptUrl, workerLabel, phase);
        }
      };

      this.addEventListener('message', logMessage);
      this.addEventListener('messageerror', logMessageError);
      this.addEventListener('error', logError);
    }
  }

  try {
    (OriginalWorker as { __ffmpegDiagnosticsWrapped?: boolean }).__ffmpegDiagnosticsWrapped = true;
    globalScope.Worker = DiagnosticWorker as typeof Worker;
    logger.debug('ffmpeg', 'Worker diagnostics enabled for FFmpeg init', {
      phase,
    });
  } catch (error) {
    logger.warn('ffmpeg', 'Failed to install Worker diagnostics', {
      phase,
      error: getErrorMessage(error),
    });
    return () => undefined;
  }

  return () => {
    if (globalScope.Worker === DiagnosticWorker) {
      globalScope.Worker = OriginalWorker;
    }
    (OriginalWorker as { __ffmpegDiagnosticsWrapped?: boolean }).__ffmpegDiagnosticsWrapped = false;
    logger.debug('ffmpeg', 'Worker diagnostics disabled for FFmpeg init', {
      phase,
    });
  };
};

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
    const coreLabel = coreVariant === 'mt' ? 'multithreaded' : 'single-threaded';
    callbacks.reportStatus(`Downloading FFmpeg assets (${coreLabel}) from CDN...`);

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
          if (downloadProgress < 25) {
            callbacks.reportStatus(
              'Network seems slow. If this persists, check your connection or firewall.'
            );
          }
        }, 12_000)
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

    const initBaseProgress = Math.max(downloadProgress, 92);
    reportProgress(initBaseProgress);
    callbacks.reportStatus('Initializing FFmpeg runtime...');

    const initStartTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let initProgress = initBaseProgress;

    if (typeof window !== 'undefined') {
      initHeartbeatId = window.setInterval(() => {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const elapsedMs = now - initStartTime;
        const progressBoost = Math.min(7, Math.floor(elapsedMs / 4000));
        const nextProgress = Math.min(99, initBaseProgress + progressBoost);
        if (nextProgress > initProgress) {
          initProgress = nextProgress;
          reportProgress(nextProgress);
        }
      }, 1200);

      initStatusTimeoutId = window.setTimeout(() => {
        callbacks.reportStatus(
          'Still initializing FFmpeg runtime (first run can take up to a minute)...'
        );
        logger.warn('ffmpeg', 'FFmpeg initialization taking longer than expected', {
          elapsedMs: Math.round(
            (typeof performance !== 'undefined' ? performance.now() : Date.now()) - initStartTime
          ),
          initSnapshot: getInitEnvironmentSnapshot(),
        });
      }, 15_000);
    }

    performanceTracker.startPhase('ffmpeg-init');
    logger.performance('Starting FFmpeg initialization');

    logger.debug('ffmpeg', 'Calling ffmpeg.load() with blob URLs', {
      classWorkerUrl: classWorkerUrl.substring(0, 50),
      coreUrl: coreUrl.substring(0, 50),
      wasmUrl: wasmUrl.substring(0, 50),
      workerUrl: workerUrl.substring(0, 50),
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
