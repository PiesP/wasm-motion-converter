import { ffmpegService } from '@services/ffmpeg-service';
import { logger } from '@utils/logger';
import { type Component, Show, splitProps } from 'solid-js';

type ExportOptions = {
  includeVerboseFfmpegProgress: boolean;
  format: 'text' | 'jsonl';
};

type ExportLogsButtonProps = {
  class?: string;
};

const DEFAULT_BUTTON_CLASS =
  'p-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-blue-400 dark:focus:ring-offset-gray-900';
const LOG_FILENAME_PREFIX = 'motion-converter-logs';
const STDOUT_PREFIX = '[stdout] ';
const STDERR_PREFIX = '[stderr] ';

const NOISY_FFMPEG_PROGRESS_KEYS = new Set([
  'frame',
  'fps',
  'stream_0_0_q',
  'bitrate',
  'total_size',
  'out_time_us',
  'out_time_ms',
  'out_time',
  'dup_frames',
  'drop_frames',
  'speed',
  'progress',
]);

const formatTimestampForFilename = (date: Date): string => {
  const pad = (value: number) => value.toString().padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
};

const buildExportFilename = (format: ExportOptions['format'], timestamp: Date): string => {
  const suffix = format === 'jsonl' ? 'jsonl' : 'log';
  return `${LOG_FILENAME_PREFIX}-${formatTimestampForFilename(timestamp)}.${suffix}`;
};

const downloadText = (params: { filename: string; text: string; mimeType?: string }): void => {
  if (typeof document === 'undefined') {
    return;
  }

  const blob = new Blob([params.text], {
    type: params.mimeType ?? 'text/plain;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);

  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = params.filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(url);
  }
};

const isNoisyFfmpegProgressStdoutLine = (line: string): boolean => {
  if (!line.startsWith(STDOUT_PREFIX)) {
    return false;
  }

  const key = line.slice(STDOUT_PREFIX.length).split('=')[0]?.trim() ?? '';
  if (!key) {
    return false;
  }

  return NOISY_FFMPEG_PROGRESS_KEYS.has(key);
};

const filterFfmpegLogsForExport = (
  logs: string[],
  options: ExportOptions
): { logs: string[]; removedCount: number } => {
  if (options.includeVerboseFfmpegProgress) {
    return { logs, removedCount: 0 };
  }

  const filtered: string[] = [];
  let removedCount = 0;

  for (const line of logs) {
    if (line === '[stderr] Aborted()') {
      removedCount += 1;
      continue;
    }

    if (isNoisyFfmpegProgressStdoutLine(line)) {
      removedCount += 1;
      continue;
    }

    filtered.push(line);
  }

  return { logs: filtered, removedCount };
};

const tryParseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const safeValue = (resolve: () => string, fallback: string): string => {
  try {
    return resolve();
  } catch {
    return fallback;
  }
};

const buildExportText = (options: ExportOptions): string => {
  const now = new Date();

  const envLines: string[] = [];
  envLines.push('dropconvert-wasm log export');
  envLines.push(`timestamp: ${now.toISOString()}`);
  envLines.push(`url: ${safeValue(() => location.href, 'unavailable')}`);
  envLines.push(`userAgent: ${safeValue(() => navigator.userAgent, 'unavailable')}`);
  envLines.push(
    `crossOriginIsolated: ${safeValue(() => String(crossOriginIsolated), 'unavailable')}`
  );
  envLines.push(`SharedArrayBuffer: ${typeof SharedArrayBuffer !== 'undefined'}`);

  const appLogs = logger.getRecentLogs();
  const rawFfmpegLogs = ffmpegService.getRecentFFmpegLogs();
  const { logs: ffmpegLogs, removedCount } = filterFfmpegLogsForExport(rawFfmpegLogs, options);

  const lines: string[] = [];
  lines.push(...envLines);
  lines.push('');
  lines.push('=== App logs (logger) ===');
  lines.push(...(appLogs.length > 0 ? appLogs : ['(no app logs captured)']));
  lines.push('');
  lines.push('=== FFmpeg recent logs (ffmpeg core ring buffer) ===');
  if (!options.includeVerboseFfmpegProgress && removedCount > 0) {
    lines.push(
      `note: filtered ${removedCount} noisy FFmpeg progress/stdout lines (Shift-click Export Logs to include verbose output)`
    );
  }
  lines.push(...(ffmpegLogs.length > 0 ? ffmpegLogs : ['(no ffmpeg logs captured)']));
  lines.push('');

  return lines.join('\n');
};

const buildExportJsonl = (options: ExportOptions): string => {
  const now = new Date();

  const rawFfmpegLogs = ffmpegService.getRecentFFmpegLogs();
  const { logs: ffmpegLogs, removedCount } = filterFfmpegLogsForExport(rawFfmpegLogs, options);

  const meta: Record<string, unknown> = {
    type: 'meta',
    schemaVersion: 1,
    app: 'dropconvert-wasm',
    exportedAt: now.toISOString(),
    url: safeValue(() => location.href, 'unavailable'),
    userAgent: safeValue(() => navigator.userAgent, 'unavailable'),
    crossOriginIsolated: safeValue(() => String(crossOriginIsolated), 'unavailable'),
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    includeVerboseFfmpegProgress: options.includeVerboseFfmpegProgress,
    filteredFfmpegProgressLines: options.includeVerboseFfmpegProgress ? 0 : removedCount,
  };

  const lines: string[] = [];
  lines.push(JSON.stringify(meta));

  for (const entry of logger.getRecentEntries()) {
    const context = entry.contextJson ? tryParseJson(entry.contextJson) : undefined;
    lines.push(
      JSON.stringify({
        type: 'log',
        source: 'app',
        timestampMs: entry.timestampMs,
        timestampIso: entry.timestampIso,
        time: entry.time,
        level: entry.level,
        category: entry.category,
        message: entry.message,
        conversionProgress: entry.conversionProgress,
        context,
        line: entry.line,
      })
    );
  }

  for (const line of ffmpegLogs) {
    const stream = line.startsWith(STDOUT_PREFIX)
      ? 'stdout'
      : line.startsWith(STDERR_PREFIX)
        ? 'stderr'
        : null;

    lines.push(
      JSON.stringify({
        type: 'log',
        source: 'ffmpeg',
        stream,
        line,
      })
    );
  }

  return lines.join('\n');
};

const ExportLogsButton: Component<ExportLogsButtonProps> = (props) => {
  const [local] = splitProps(props, ['class']);

  const handleExport = (event: MouseEvent): void => {
    try {
      const includeVerboseFfmpegProgress = event.shiftKey === true;
      const format: ExportOptions['format'] = event.altKey === true ? 'jsonl' : 'text';

      logger.info('general', 'Exporting logs', {
        includeVerboseFfmpegProgress,
        format,
      });

      const now = new Date();
      const filename = buildExportFilename(format, now);

      if (format === 'jsonl') {
        const text = buildExportJsonl({ includeVerboseFfmpegProgress, format });
        downloadText({
          filename,
          text,
          mimeType: 'application/x-ndjson;charset=utf-8',
        });
        return;
      }

      const text = buildExportText({ includeVerboseFfmpegProgress, format });
      downloadText({ filename, text });
    } catch (error) {
      logger.error('general', 'Failed to export logs', { error });
    }
  };

  const buttonClass = () => local.class ?? DEFAULT_BUTTON_CLASS;

  return (
    <Show when={import.meta.env.DEV}>
      <button
        type="button"
        onClick={handleExport}
        class={buttonClass()}
        aria-label="Export logs"
        title="Export logs (Shift: verbose FFmpeg progress, Alt: JSONL for AI analysis)"
      >
        <svg
          class="w-5 h-5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <title>Download icon</title>
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4"
          />
        </svg>
      </button>
    </Show>
  );
};

export default ExportLogsButton;
