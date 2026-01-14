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

// Versioned key to avoid stale strategy tuning after algorithm changes.
const STORAGE_KEY = 'conversion_metrics_v2' as const;
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

export type GifEncoderBackend = 'ffmpeg-palette' | 'modern-gif-worker';

export interface GifEncoderRecommendation {
  codec: string;
  format: 'gif';
  executedPath: 'gpu';
  recommendedEncoder: GifEncoderBackend;
  confidence: number;
  reason: string;
}

interface MetricsStorage {
  version: 2;
  records: ConversionMetricRecord[];
  maxRecords: number;
}

class ConversionMetricsService {
  private records: ConversionMetricRecord[] = [];

  constructor() {
    // Best-effort cleanup for older schema keys.
    try {
      if (typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined') {
        window.sessionStorage.removeItem('conversion_metrics_v1');
      }
    } catch {
      // Ignore
    }
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

  /**
   * Recommend the most stable GIF encoder on the GPU/WebCodecs path.
   *
   * This uses only local session metrics and does not upload data.
   * The intent is to avoid catastrophic outliers by preferring lower p90 duration
   * once we have enough samples.
   */
  getGifEncoderRecommendation(codec: string): GifEncoderRecommendation | null {
    const normalizedCodec = normalizeCodecString(codec) || codec;

    const relevantAll = this.records
      .filter(
        (r) =>
          (normalizeCodecString(r.codec) || r.codec) === normalizedCodec &&
          r.format === 'gif' &&
          r.executedPath === 'gpu' &&
          (r.encoderBackendUsed === 'ffmpeg-palette' ||
            r.encoderBackendUsed === 'modern-gif-worker')
      )
      .sort((a, b) => a.timestamp - b.timestamp);

    // Prefer the most recent evidence to reflect current build behavior.
    // This is especially important for ffmpeg-palette where performance can change
    // significantly after algorithm tweaks.
    const RECENT_SAMPLE_LIMIT = 12;
    const relevantRecent = relevantAll.slice(-RECENT_SAMPLE_LIMIT);
    const relevant = relevantRecent.length > 0 ? relevantRecent : relevantAll;

    const byEncoder = new Map<GifEncoderBackend, ConversionMetricRecord[]>();
    for (const r of relevant) {
      const enc = r.encoderBackendUsed as GifEncoderBackend;
      const existing = byEncoder.get(enc);
      if (existing) {
        existing.push(r);
      } else {
        byEncoder.set(enc, [r]);
      }
    }

    const getStats = (encoder: GifEncoderBackend) => {
      const rows = byEncoder.get(encoder) ?? [];
      const total = rows.length;
      const successes = rows.filter((r) => r.outcome === 'success');
      const successCount = successes.length;
      const successRate = total > 0 ? successCount / total : 0;
      const durations = successes
        .map((r) => r.durationMs)
        .filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);

      const quantile = (q: number): number | null => {
        if (durations.length === 0) return null;
        const pos = (durations.length - 1) * q;
        const base = Math.floor(pos);
        const rest = pos - base;
        const a = durations[base]!;
        const b = durations[Math.min(base + 1, durations.length - 1)]!;
        return a + (b - a) * rest;
      };

      return {
        total,
        successCount,
        successRate,
        p50: quantile(0.5),
        p90: quantile(0.9),
      };
    };

    const palette = getStats('ffmpeg-palette');
    const modern = getStats('modern-gif-worker');

    // Require enough samples to make a recommendation.
    // Keep this low so the system can adapt quickly after a build update.
    const minTotalSamples = 3;
    if (palette.total + modern.total < minTotalSamples) {
      return null;
    }

    // Prefer the encoder with better success rate first.
    const successRateDelta = modern.successRate - palette.successRate;
    if (Math.abs(successRateDelta) >= 0.2) {
      const recommendedEncoder: GifEncoderBackend =
        successRateDelta > 0 ? 'modern-gif-worker' : 'ffmpeg-palette';

      const confidence =
        Math.min(1, (palette.total + modern.total) / 10) *
        Math.max(modern.successRate, palette.successRate);

      return {
        codec: normalizedCodec,
        format: 'gif',
        executedPath: 'gpu',
        recommendedEncoder,
        confidence,
        reason: 'success_rate',
      };
    }

    // Otherwise, prefer the more stable encoder (lower p90 among successes).
    // If p90 is missing for one encoder, prefer the one that has it.
    const modernP90 = modern.p90;
    const paletteP90 = palette.p90;

    if (modernP90 !== null && paletteP90 !== null) {
      const recommendedEncoder: GifEncoderBackend =
        modernP90 <= paletteP90 ? 'modern-gif-worker' : 'ffmpeg-palette';

      // Confidence increases with samples and decreases if either encoder has low success rate.
      const confidence =
        Math.min(1, (palette.total + modern.total) / 12) *
        Math.max(modern.successRate, palette.successRate);

      return {
        codec: normalizedCodec,
        format: 'gif',
        executedPath: 'gpu',
        recommendedEncoder,
        confidence,
        reason: 'p90_stability',
      };
    }

    if (modernP90 !== null && paletteP90 === null) {
      return {
        codec: normalizedCodec,
        format: 'gif',
        executedPath: 'gpu',
        recommendedEncoder: 'modern-gif-worker',
        confidence: Math.min(1, modern.total / 8) * modern.successRate,
        reason: 'insufficient_palette_data',
      };
    }

    if (paletteP90 !== null && modernP90 === null) {
      return {
        codec: normalizedCodec,
        format: 'gif',
        executedPath: 'gpu',
        recommendedEncoder: 'ffmpeg-palette',
        confidence: Math.min(1, palette.total / 8) * palette.successRate,
        reason: 'insufficient_modern_data',
      };
    }

    return null;
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
      if (storage.version !== 2) {
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
        version: 2,
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
