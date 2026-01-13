import type { Component } from 'solid-js';
import { Show } from 'solid-js';
import { ffmpegService } from '@services/ffmpeg-service';
import { logger } from '@utils/logger';

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

const downloadText = (params: { filename: string; text: string; mimeType?: string }): void => {
  if (typeof document === 'undefined') {
    return;
  }

  const blob = new Blob([params.text], { type: params.mimeType ?? 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = params.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
};

const buildExportText = (): string => {
  const now = new Date();

  const envLines: string[] = [];
  envLines.push('dropconvert-wasm log export');
  envLines.push(`timestamp: ${now.toISOString()}`);

  try {
    envLines.push(`url: ${typeof location !== 'undefined' ? location.href : 'unavailable'}`);
  } catch {
    envLines.push('url: unavailable');
  }

  try {
    envLines.push(
      `userAgent: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'unavailable'}`
    );
  } catch {
    envLines.push('userAgent: unavailable');
  }

  try {
    envLines.push(
      `crossOriginIsolated: ${typeof crossOriginIsolated !== 'undefined' ? String(crossOriginIsolated) : 'unavailable'}`
    );
  } catch {
    envLines.push('crossOriginIsolated: unavailable');
  }

  envLines.push(`SharedArrayBuffer: ${typeof SharedArrayBuffer !== 'undefined'}`);

  const appLogs = logger.getRecentLogs();
  const ffmpegLogs = ffmpegService.getRecentFFmpegLogs();

  const lines: string[] = [];
  lines.push(...envLines);
  lines.push('');
  lines.push('=== App logs (logger) ===');
  lines.push(...(appLogs.length > 0 ? appLogs : ['(no app logs captured)']));
  lines.push('');
  lines.push('=== FFmpeg recent logs (ffmpeg core ring buffer) ===');
  lines.push(...(ffmpegLogs.length > 0 ? ffmpegLogs : ['(no ffmpeg logs captured)']));
  lines.push('');

  return lines.join('\n');
};

type ExportLogsButtonProps = {
  class?: string;
};

/**
 * Export Logs button (dev mode only).
 *
 * Downloads a clean text file containing recent app logs and the recent FFmpeg ring buffer.
 */
const ExportLogsButton: Component<ExportLogsButtonProps> = (props) => {
  const handleExport = (): void => {
    try {
      logger.info('general', 'Exporting logs');
      const text = buildExportText();
      const filename = `motion-converter-logs-${formatTimestampForFilename(new Date())}.log`;
      downloadText({ filename, text });
    } catch (error) {
      logger.error('general', 'Failed to export logs', { error });
    }
  };

  return (
    <Show when={import.meta.env.DEV}>
      <button
        type="button"
        onClick={handleExport}
        class={
          props.class ??
          'p-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-blue-400 dark:focus:ring-offset-gray-900'
        }
        aria-label="Export logs"
        title="Export logs"
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
