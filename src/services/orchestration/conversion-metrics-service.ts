/**
 * Conversion Metrics Service
 *
 * Lightweight session-scoped metrics collection to support tuning GPU vs CPU
 * selection without changing conversion behavior.
 *
 * Notes:
 * - Uses sessionStorage (best-effort) and keeps only a small bounded history.
 * - Intended for debugging/benchmarking; does not upload data anywhere.
 */

import type { ConversionFormat } from '@t/conversion-types';
import { createSingleton } from '@services/shared/singleton-service';
import { normalizeCodecString } from '@utils/codec-utils';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

import type { ConversionPath } from './types';

const STORAGE_KEY = 'conversion_metrics_v1' as const;
const MAX_RECORDS = 50 as const;

export type ConversionMetricOutcome = 'success' | 'error' | 'cancelled';

export interface ConversionMetricRecord {
  timestamp: number;
  codec: string;
  format: ConversionFormat;

  plannedPath: ConversionPath;
  executedPath: ConversionPath;

  encoderBackendUsed?: string | null;
  captureModeUsed?: string | null;

  durationMs: number;
  outputSizeBytes?: number | null;

  initializationMs?: number;
  analysisMs?: number;
  conversionMs?: number;
  totalMs?: number;

  outcome: ConversionMetricOutcome;
}

export interface ConversionMetricGroup {
  codec: string;
  format: ConversionFormat;
  path: ConversionPath;

  count: number;
  successCount: number;
  successRate: number;

  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
}

interface MetricsStorage {
  version: 1;
  records: ConversionMetricRecord[];
  maxRecords: number;
}

class ConversionMetricsService {
  private records: ConversionMetricRecord[] = [];

  constructor() {
    this.loadFromStorage();
  }

  record(record: ConversionMetricRecord): void {
    this.records.push({
      ...record,
      codec: normalizeCodecString(record.codec) || record.codec,
    });

    if (this.records.length > MAX_RECORDS) {
      this.records = this.records.slice(-MAX_RECORDS);
    }

    this.saveToStorage();

    logger.debug('conversion', 'Conversion recorded to metrics', {
      codec: record.codec,
      format: record.format,
      plannedPath: record.plannedPath,
      executedPath: record.executedPath,
      outcome: record.outcome,
      durationMs: record.durationMs,
      totalRecords: this.records.length,
    });
  }

  getAll(): ConversionMetricRecord[] {
    return [...this.records];
  }

  getSummary(): ConversionMetricGroup[] {
    const groups = new Map<string, ConversionMetricRecord[]>();

    for (const record of this.records) {
      const codec = normalizeCodecString(record.codec) || record.codec;
      const key = `${codec}:${record.format}:${record.executedPath}`;
      const existing = groups.get(key);
      if (existing) {
        existing.push(record);
      } else {
        groups.set(key, [record]);
      }
    }

    const results: ConversionMetricGroup[] = [];

    for (const [key, records] of groups) {
      const parts = key.split(':');
      if (parts.length !== 3) continue;

      const codec = parts[0] ?? 'unknown';
      const format = (parts[1] ?? 'gif') as ConversionFormat;
      const path = (parts[2] ?? 'cpu') as ConversionPath;

      const durations = records.map((r) => r.durationMs).filter((n) => Number.isFinite(n));
      const count = records.length;
      const successCount = records.filter((r) => r.outcome === 'success').length;

      const totalDuration = durations.reduce((sum, n) => sum + n, 0);
      const avgDurationMs = count > 0 ? Math.round(totalDuration / count) : 0;
      const minDurationMs = durations.length > 0 ? Math.min(...durations) : 0;
      const maxDurationMs = durations.length > 0 ? Math.max(...durations) : 0;

      results.push({
        codec,
        format,
        path,
        count,
        successCount,
        successRate: count > 0 ? successCount / count : 0,
        avgDurationMs,
        minDurationMs,
        maxDurationMs,
      });
    }

    // Prefer stable output ordering for easier diffing in console.
    results.sort((a, b) => {
      if (a.codec !== b.codec) return a.codec.localeCompare(b.codec);
      if (a.format !== b.format) return a.format.localeCompare(b.format);
      return a.path.localeCompare(b.path);
    });

    return results;
  }

  clear(): void {
    this.records = [];
    this.saveToStorage();
  }

  private loadFromStorage(): void {
    if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') {
      return;
    }

    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;

      const storage = JSON.parse(raw) as MetricsStorage;
      if (storage.version !== 1) {
        window.sessionStorage.removeItem(STORAGE_KEY);
        return;
      }

      this.records = Array.isArray(storage.records) ? storage.records : [];
    } catch (error) {
      logger.debug('conversion', 'Failed to load conversion metrics (non-critical)', {
        error: getErrorMessage(error),
      });
    }
  }

  private saveToStorage(): void {
    if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') {
      return;
    }

    try {
      const storage: MetricsStorage = {
        version: 1,
        records: this.records,
        maxRecords: MAX_RECORDS,
      };

      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
    } catch (error) {
      logger.debug('conversion', 'Failed to save conversion metrics (non-critical)', {
        error: getErrorMessage(error),
      });
    }
  }
}

export const conversionMetricsService = createSingleton(
  'ConversionMetricsService',
  () => new ConversionMetricsService()
);
