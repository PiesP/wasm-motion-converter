// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { logger } from '@utils/logger';
import type { Component } from 'solid-js';
import { Show, splitProps } from 'solid-js';

type ExportLogsButtonProps = {
  class?: string;
};

const DEFAULT_BUTTON_CLASS =
  'p-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-blue-400 dark:focus:ring-offset-gray-900';
const LOG_FILENAME_PREFIX = 'motion-converter-logs';

const formatTimestampForFilename = (date: Date): string => {
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

const downloadText = (params: { filename: string; text: string; mimeType?: string }): void => {
  if (typeof document === 'undefined') return;

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

const ExportLogsButton: Component<ExportLogsButtonProps> = (props) => {
  const [local] = splitProps(props, ['class']);

  const handleExport = (event: MouseEvent): void => {
    try {
      const format = event.altKey ? 'jsonl' : 'text';
      const now = new Date();
      const filename = `${LOG_FILENAME_PREFIX}-${formatTimestampForFilename(now)}.${format === 'jsonl' ? 'jsonl' : 'log'}`;

      if (format === 'jsonl') {
        const lines: string[] = [];
        lines.push(
          JSON.stringify({
            type: 'meta',
            schemaVersion: 1,
            app: 'motion-converter',
            exportedAt: now.toISOString(),
            url: (() => {
              try {
                return location.href;
              } catch {
                return 'unavailable';
              }
            })(),
            userAgent: (() => {
              try {
                return navigator.userAgent;
              } catch {
                return 'unavailable';
              }
            })(),
            crossOriginIsolated: (() => {
              try {
                return String(crossOriginIsolated);
              } catch {
                return 'unavailable';
              }
            })(),
            sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
          })
        );

        for (const entry of logger.getRecentEntries()) {
          lines.push(
            JSON.stringify({
              type: 'log',
              source: 'app',
              timestampMs: entry.timestampMs,
              timestampIso: entry.timestampIso,
              level: entry.level,
              category: entry.category,
              message: entry.message,
              context: entry.contextJson,
            })
          );
        }

        downloadText({
          filename,
          text: lines.join('\n'),
          mimeType: 'application/x-ndjson;charset=utf-8',
        });
        return;
      }

      const lines: string[] = [];
      lines.push('Motion Converter log export');
      lines.push(`timestamp: ${now.toISOString()}`);
      lines.push(
        `url: ${(() => {
          try {
            return location.href;
          } catch {
            return 'unavailable';
          }
        })()}`
      );
      lines.push(
        `userAgent: ${(() => {
          try {
            return navigator.userAgent;
          } catch {
            return 'unavailable';
          }
        })()}`
      );
      lines.push(
        `crossOriginIsolated: ${(() => {
          try {
            return String(crossOriginIsolated);
          } catch {
            return 'unavailable';
          }
        })()}`
      );
      lines.push(`SharedArrayBuffer: ${typeof SharedArrayBuffer !== 'undefined'}`);
      lines.push('');
      lines.push('=== Application logs ===');
      lines.push(
        ...(logger.getRecentLogs().length > 0 ? logger.getRecentLogs() : ['(no logs captured)'])
      );

      downloadText({ filename, text: lines.join('\n') });
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
        title="Export logs (Alt: JSONL format)"
        data-testid="export-logs-button"
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
