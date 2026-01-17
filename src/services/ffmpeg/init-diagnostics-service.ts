import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

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
const IMPORT_SPECIFIER_SAMPLE_LIMIT = 6;
const MESSAGE_PREVIEW_LENGTH = 160;
const CSP_PREVIEW_LENGTH = 200;
const WORKER_URL_PREFIX_LENGTH = 70;
const WORKER_URL_MAX_LENGTH = 90;
const WORKER_MESSAGE_LOG_LIMIT = 3;
const WORKER_MESSAGE_SUPPRESS_THRESHOLD = 4;
const WORKER_KEY_SAMPLE_LIMIT = 8;
const PERMISSIONS_POLICY_SAMPLE_LIMIT = 10;

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
    importSpecifiersSample: specifierList.slice(0, IMPORT_SPECIFIER_SAMPLE_LIMIT),
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
      preview: data.slice(0, MESSAGE_PREVIEW_LENGTH),
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
      keys: keys.slice(0, WORKER_KEY_SAMPLE_LIMIT),
      keysTotal: keys.length,
    };
  }

  return { kind: typeof data };
};

const formatWorkerUrl = (value: string): string => {
  if (value.length <= WORKER_URL_MAX_LENGTH) {
    return value;
  }
  return `${value.slice(0, WORKER_URL_PREFIX_LENGTH)}...`;
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
    preview: content.slice(0, CSP_PREVIEW_LENGTH),
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
    allowedFeaturesSample: allowedFeatures.slice(0, PERMISSIONS_POLICY_SAMPLE_LIMIT),
  };
};

export const installSecurityPolicyViolationLogger = (phase: string): (() => void) => {
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

export const installWorkerDiagnostics = ({
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

        if (count <= WORKER_MESSAGE_LOG_LIMIT) {
          logger.debug('ffmpeg', 'Worker message during FFmpeg init', {
            phase,
            label,
            payload: summarizeWorkerMessage(event.data),
          });
        } else if (count === WORKER_MESSAGE_SUPPRESS_THRESHOLD) {
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
