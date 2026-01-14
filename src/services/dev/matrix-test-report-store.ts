import { logger } from '@utils/logger';

/**
 * Matrix test report storage (dev-only).
 *
 * Stores per-test reports in localStorage so long-running matrix runs do not
 * lose early results due to the in-memory log ring buffer.
 */

export type MatrixTestReportIndexItem = {
  id: string;
  createdAt: number;
  fileName: string;
  totalRuns: number;
  successCount: number;
  errorCount: number;
  durationMs: number;
};

const INDEX_KEY = 'dev_matrix_test_reports_index_v1';
const REPORT_KEY_PREFIX = 'dev_matrix_test_report_v1_';
const MAX_REPORTS_TO_KEEP = 10;

const isBrowser = (): boolean =>
  typeof window !== 'undefined' && typeof localStorage !== 'undefined';

function safeParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function loadIndex(): MatrixTestReportIndexItem[] {
  if (!isBrowser()) {
    return [];
  }

  const raw = localStorage.getItem(INDEX_KEY);
  if (!raw) {
    return [];
  }

  const parsed = safeParseJson<MatrixTestReportIndexItem[]>(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function saveIndex(items: MatrixTestReportIndexItem[]): void {
  if (!isBrowser()) {
    return;
  }

  localStorage.setItem(INDEX_KEY, JSON.stringify(items));
}

export function listMatrixTestReports(): MatrixTestReportIndexItem[] {
  return loadIndex();
}

export function loadMatrixTestReport<T>(id: string): T | null {
  if (!isBrowser()) {
    return null;
  }

  const raw = localStorage.getItem(`${REPORT_KEY_PREFIX}${id}`);
  if (!raw) {
    return null;
  }

  return safeParseJson<T>(raw);
}

export function deleteMatrixTestReport(id: string): void {
  if (!isBrowser()) {
    return;
  }

  localStorage.removeItem(`${REPORT_KEY_PREFIX}${id}`);
  const nextIndex = loadIndex().filter((item) => item.id !== id);
  saveIndex(nextIndex);
}

export function clearMatrixTestReports(): void {
  if (!isBrowser()) {
    return;
  }

  for (const item of loadIndex()) {
    localStorage.removeItem(`${REPORT_KEY_PREFIX}${item.id}`);
  }
  saveIndex([]);
}

export function persistMatrixTestReport(params: {
  reportId: string;
  createdAt: number;
  fileName: string;
  totalRuns: number;
  successCount: number;
  errorCount: number;
  durationMs: number;
  reportJson: string;
}): void {
  if (!import.meta.env.DEV) {
    return;
  }

  if (!isBrowser()) {
    return;
  }

  const { reportId, reportJson } = params;

  try {
    localStorage.setItem(`${REPORT_KEY_PREFIX}${reportId}`, reportJson);

    const existing = loadIndex();
    const next: MatrixTestReportIndexItem[] = [
      {
        id: reportId,
        createdAt: params.createdAt,
        fileName: params.fileName,
        totalRuns: params.totalRuns,
        successCount: params.successCount,
        errorCount: params.errorCount,
        durationMs: params.durationMs,
      },
      ...existing.filter((item) => item.id !== reportId),
    ].slice(0, MAX_REPORTS_TO_KEEP);

    saveIndex(next);

    // Evict dropped reports.
    const keepIds = new Set(next.map((item) => item.id));
    for (const item of existing) {
      if (!keepIds.has(item.id)) {
        localStorage.removeItem(`${REPORT_KEY_PREFIX}${item.id}`);
      }
    }
  } catch (error) {
    // localStorage may be full or disabled.
    logger.warn('general', 'Failed to persist matrix test report', {
      reportId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function sanitizeFilenamePart(value: string): string {
  return value
    .replaceAll(/[^a-zA-Z0-9._-]+/g, '_')
    .replaceAll(/_+/g, '_')
    .slice(0, 80);
}

function formatTimestampForFilename(date: Date): string {
  const pad = (v: number) => v.toString().padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

export function buildMatrixTestReportFilename(params: {
  startedAt: number;
  fileName: string;
  reportId?: string;
  format: 'json' | 'jsonl';
}): string {
  const ts = formatTimestampForFilename(new Date(params.startedAt));
  const base = sanitizeFilenamePart(params.fileName);
  const suffix = params.reportId ? sanitizeFilenamePart(params.reportId).slice(0, 16) : null;
  return `matrix-test-${ts}-${base}${suffix ? `-${suffix}` : ''}.${params.format}`;
}

export function downloadTextFile(params: {
  filename: string;
  text: string;
  mimeType?: string;
}): void {
  if (typeof document === 'undefined') {
    return;
  }

  const blob = new Blob([params.text], {
    type: params.mimeType ?? 'text/plain;charset=utf-8',
  });
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
}

export function isFileSystemAccessSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function'
  );
}

export async function requestSaveFileHandle(params: {
  suggestedName: string;
  mimeType: string;
  description: string;
}): Promise<unknown> {
  const picker = (
    window as unknown as {
      showSaveFilePicker?: (options: unknown) => Promise<unknown>;
    }
  ).showSaveFilePicker;
  if (!picker) {
    return null;
  }

  return picker({
    suggestedName: params.suggestedName,
    types: [
      {
        description: params.description,
        accept: {
          [params.mimeType]: [`.${params.suggestedName.split('.').pop() ?? 'txt'}`],
        },
      },
    ],
  });
}

export async function writeTextToFileHandle(params: {
  handle: unknown;
  text: string;
}): Promise<void> {
  const h = params.handle as {
    createWritable?: () => Promise<{
      write: (data: unknown) => Promise<void>;
      close: () => Promise<void>;
    }>;
  };

  if (!h?.createWritable) {
    throw new Error('File handle does not support createWritable()');
  }

  const writable = await h.createWritable();
  await writable.write(params.text);
  await writable.close();
}
