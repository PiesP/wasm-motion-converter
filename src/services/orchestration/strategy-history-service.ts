/**
 * Strategy History Service
 *
 * Tracks successful conversions to learn optimal paths per codec+format combination.
 * Uses sessionStorage for session-scoped learning (fresh detection each session).
 *
 * Learning Logic:
 * - Store last 50 successful conversions
 * - Calculate success rate per path for each codec+format (including failures)
 * - Recommend path with highest success rate, then fastest successful duration
 * - Confidence considers record count and success rate (high confidence after 5+ stable runs)
 */

import type { ConversionPath } from '@services/orchestration/types-service';
import { createSingleton } from '@services/shared/singleton-service';
import type { ConversionFormat } from '@t/conversion-types';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

const STORAGE_KEY = 'strategy_history_v2' as const;
const LEGACY_STORAGE_KEY = 'strategy_history_v1' as const;
const STORAGE_VERSION = 2 as const;
const MAX_RECORDS = 50 as const;
const HIGH_CONFIDENCE_THRESHOLD = 5 as const;
const DEFAULT_FALLBACK_PATH: ConversionPath = 'cpu';

/**
 * Failure phase attribution
 * Helps distinguish between decoder failures and encoder failures
 */
export type FailurePhase = 'decode' | 'encode' | 'other' | null;

/**
 * Record of a single conversion
 */
export interface ConversionRecord {
  codec: string;
  format: ConversionFormat;
  path: ConversionPath;
  /** Best-effort capture mode used by the GPU/WebCodecs decoder (e.g., 'demuxer', 'seek'). */
  captureModeUsed?: string | null;
  durationMs: number;
  success: boolean;
  /** Best-effort error message for failed conversions (truncated by caller). */
  errorMessage?: string;
  /** Phase where failure occurred (only set when success=false) */
  failurePhase?: FailurePhase;
  timestamp: number;
}

/**
 * Aggregated history for a codec+format combination
 */
export interface ConversionHistory {
  codec: string;
  format: ConversionFormat;
  records: ConversionRecord[];
  statistics: {
    totalConversions: number;
    successRate: number;
    avgDurationMs: number;
    preferredPath: ConversionPath;
  };
}

/**
 * Recommended path with confidence scoring
 */
interface RecommendedPath {
  path: ConversionPath;
  confidence: number; // 0-1
  basedOnRecords: number;
  avgDurationMs: number;
}

/**
 * Storage schema for sessionStorage
 */
interface HistoryStorage {
  records: ConversionRecord[];
  maxRecords: number;
  version: number;
}

type PathStats = {
  count: number;
  successCount: number;
  totalDuration: number;
  avgDuration: number;
  successRate: number;
};

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined';
}

function removeLegacyStorage(): void {
  if (!canUseStorage()) return;

  try {
    window.sessionStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function buildHistoryKey(codec: string, format: ConversionFormat): string {
  return `${codec}:${format}`;
}

function parseHistoryKey(key: string): { codec: string; format: ConversionFormat } | null {
  const parts = key.split(':');
  if (parts.length !== 2) return null;

  const [codec, format] = parts;
  if (!codec || !format) return null;

  return {
    codec,
    format: format as ConversionFormat,
  };
}

class StrategyHistoryService {
  private records: ConversionRecord[] = [];

  constructor() {
    removeLegacyStorage();
    this.loadFromStorage();
  }

  /**
   * Record a conversion result (success or failure)
   *
   * @param record - Conversion record
   */
  recordConversion(record: ConversionRecord): void {
    const normalized: ConversionRecord = {
      ...record,
      failurePhase: record.success ? null : (record.failurePhase ?? null),
    };

    this.appendRecord(normalized);
    this.saveToStorage();

    logger.debug('conversion', 'Conversion recorded to history', {
      codec: normalized.codec,
      format: normalized.format,
      path: normalized.path,
      captureModeUsed: normalized.captureModeUsed ?? null,
      success: normalized.success,
      durationMs: normalized.durationMs,
      errorMessage: normalized.success ? null : (normalized.errorMessage ?? null),
      failurePhase: normalized.failurePhase ?? null,
      totalRecords: this.records.length,
    });
  }

  /**
   * Get history for specific codec+format combination
   *
   * @param codec - Video codec
   * @param format - Output format
   * @returns Conversion history or null if no records exist
   */
  getHistory(codec: string, format: ConversionFormat): ConversionHistory | null {
    const normalizedCodec = this.normalizeCodec(codec);

    const filtered = this.records.filter(
      (record) => this.normalizeCodec(record.codec) === normalizedCodec && record.format === format
    );

    if (filtered.length === 0) {
      return null;
    }

    return {
      codec: normalizedCodec,
      format,
      records: filtered,
      statistics: this.buildStatistics(filtered),
    };
  }

  /**
   * Get recommended path based on historical data
   *
   * @param codec - Video codec
   * @param format - Output format
   * @returns Recommended path with confidence, or null if insufficient data
   */
  getRecommendedPath(codec: string, format: ConversionFormat): RecommendedPath | null {
    const history = this.getHistory(codec, format);
    if (!history) {
      return null;
    }

    const preferredPath = history.statistics.preferredPath;
    const preferredAll = history.records.filter((record) => record.path === preferredPath);
    const preferredSuccesses = preferredAll.filter((record) => record.success);

    if (preferredSuccesses.length === 0) {
      return null;
    }

    const preferredSuccessRate =
      preferredAll.length > 0 ? preferredSuccesses.length / preferredAll.length : 0;

    const confidenceByCount = Math.min(preferredAll.length / HIGH_CONFIDENCE_THRESHOLD, 1.0);
    const confidence = Math.max(0, Math.min(1, confidenceByCount * preferredSuccessRate));
    const avgDurationMs =
      preferredSuccesses.reduce((sum, record) => sum + record.durationMs, 0) /
      preferredSuccesses.length;

    return {
      path: preferredPath,
      confidence,
      basedOnRecords: preferredAll.length,
      avgDurationMs,
    };
  }

  /**
   * Get all history (for debugging)
   *
   * @returns All conversion records grouped by codec+format
   */
  getAllHistory(): ConversionHistory[] {
    const grouped = new Map<string, ConversionRecord[]>();

    for (const record of this.records) {
      const key = buildHistoryKey(this.normalizeCodec(record.codec), record.format);
      const existing = grouped.get(key);
      if (existing) {
        existing.push(record);
      } else {
        grouped.set(key, [record]);
      }
    }

    const histories: ConversionHistory[] = [];
    for (const [key, records] of grouped) {
      const parsed = parseHistoryKey(key);
      if (!parsed) continue;

      histories.push({
        codec: parsed.codec,
        format: parsed.format,
        records,
        statistics: this.buildStatistics(records),
      });
    }

    return histories;
  }

  /**
   * Clear all history (for testing)
   */
  clearHistory(): void {
    this.records = [];
    this.saveToStorage();
    logger.debug('conversion', 'Conversion history cleared');
  }

  private appendRecord(record: ConversionRecord): void {
    this.records.push(record);

    if (this.records.length > MAX_RECORDS) {
      this.records = this.records.slice(-MAX_RECORDS);
    }
  }

  private buildStatistics(records: ConversionRecord[]): ConversionHistory['statistics'] {
    const totalConversions = records.length;
    const successfulConversions = records.filter((record) => record.success);
    const successRate = totalConversions > 0 ? successfulConversions.length / totalConversions : 0;
    const avgDurationMs =
      successfulConversions.length > 0
        ? successfulConversions.reduce((sum, record) => sum + record.durationMs, 0) /
          successfulConversions.length
        : 0;
    const pathStats = this.calculatePathStatistics(records);

    return {
      totalConversions,
      successRate,
      avgDurationMs,
      preferredPath: this.selectPreferredPath(pathStats),
    };
  }

  /**
   * Load records from sessionStorage
   */
  private loadFromStorage(): void {
    if (!canUseStorage()) return;

    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }

      const storage = JSON.parse(raw) as HistoryStorage;

      if (storage.version !== STORAGE_VERSION) {
        logger.debug('conversion', 'Strategy history version mismatch, clearing', {
          storedVersion: storage.version,
          currentVersion: STORAGE_VERSION,
        });
        window.sessionStorage.removeItem(STORAGE_KEY);
        return;
      }

      this.records = Array.isArray(storage.records) ? storage.records : [];
      logger.debug('conversion', 'Strategy history loaded from sessionStorage', {
        recordCount: this.records.length,
      });
    } catch (error) {
      logger.warn('conversion', 'Failed to load strategy history (non-critical)', {
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Save records to sessionStorage
   */
  private saveToStorage(): void {
    if (!canUseStorage()) return;

    try {
      const storage: HistoryStorage = {
        records: this.records,
        maxRecords: MAX_RECORDS,
        version: STORAGE_VERSION,
      };

      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
    } catch (error) {
      logger.warn('conversion', 'Failed to save strategy history (non-critical)', {
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Calculate statistics per path
   */
  private calculatePathStatistics(records: ConversionRecord[]): Map<ConversionPath, PathStats> {
    const stats = new Map<ConversionPath, PathStats>();

    for (const record of records) {
      const pathStats = this.getPathStats(stats, record.path);
      pathStats.count += 1;

      if (record.success) {
        pathStats.successCount += 1;
        pathStats.totalDuration += record.durationMs;
        pathStats.avgDuration = pathStats.totalDuration / pathStats.successCount;
      }

      pathStats.successRate =
        pathStats.count > 0 ? pathStats.successCount / pathStats.count : pathStats.successRate;
    }

    return stats;
  }

  /**
   * Select preferred path from statistics
   *
   * Preference order:
   * 1. Highest success rate (all successful here, so tie)
   * 2. Most conversions (more data = more confidence)
   * 3. Fastest average duration
   */
  private selectPreferredPath(pathStats: Map<ConversionPath, PathStats>): ConversionPath {
    if (pathStats.size === 0) {
      return DEFAULT_FALLBACK_PATH;
    }

    let preferredPath: ConversionPath = DEFAULT_FALLBACK_PATH;
    let bestSuccessRate = -1;
    let bestSuccessCount = -1;
    let bestAvgDuration = Number.POSITIVE_INFINITY;

    for (const [path, stats] of pathStats) {
      if (stats.successCount <= 0) {
        continue;
      }

      if (stats.successRate > bestSuccessRate) {
        preferredPath = path;
        bestSuccessRate = stats.successRate;
        bestSuccessCount = stats.successCount;
        bestAvgDuration = stats.avgDuration;
        continue;
      }

      if (stats.successRate === bestSuccessRate && stats.successCount > bestSuccessCount) {
        preferredPath = path;
        bestSuccessCount = stats.successCount;
        bestAvgDuration = stats.avgDuration;
        continue;
      }

      if (
        stats.successRate === bestSuccessRate &&
        stats.successCount === bestSuccessCount &&
        stats.avgDuration < bestAvgDuration
      ) {
        preferredPath = path;
        bestAvgDuration = stats.avgDuration;
      }
    }

    return preferredPath;
  }

  private getPathStats(stats: Map<ConversionPath, PathStats>, path: ConversionPath): PathStats {
    const existing = stats.get(path);
    if (existing) return existing;

    const next: PathStats = {
      count: 0,
      successCount: 0,
      totalDuration: 0,
      avgDuration: 0,
      successRate: 0,
    };
    stats.set(path, next);
    return next;
  }

  /**
   * Normalize codec string for consistent matching
   */
  private normalizeCodec(codec: string): string {
    const lower = codec.toLowerCase();

    if (lower.includes('h264') || lower.includes('avc')) return 'h264';
    if (lower.includes('hevc') || lower.includes('h265') || lower.includes('hvc')) return 'hevc';
    if (lower.includes('av1') || lower.includes('av01')) return 'av1';
    if (lower.includes('vp09') || lower.includes('vp9')) return 'vp9';
    if (lower.includes('vp08') || lower.includes('vp8')) return 'vp8';

    return lower;
  }
}

export const strategyHistoryService = createSingleton(
  'StrategyHistoryService',
  () => new StrategyHistoryService()
);
