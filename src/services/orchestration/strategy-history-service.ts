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

import type { ConversionFormat } from '@t/conversion-types';
import type { ConversionPath } from '@services/orchestration/types';
import { createSingleton } from '@services/shared/singleton-service';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

// Versioned key to avoid stale path recommendations after algorithm changes.
const STORAGE_KEY = 'strategy_history_v2' as const;
const MAX_RECORDS = 50 as const;
const HIGH_CONFIDENCE_THRESHOLD = 5 as const; // 5+ conversions for high confidence

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

class StrategyHistoryService {
  private records: ConversionRecord[] = [];

  constructor() {
    // Best-effort cleanup for older schema keys.
    try {
      if (typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined') {
        window.sessionStorage.removeItem('strategy_history_v1');
      }
    } catch {
      // Ignore
    }
    this.loadFromStorage();
  }

  /**
   * Record a conversion result (success or failure)
   *
   * @param record - Conversion record
   */
  recordConversion(record: ConversionRecord): void {
    // Add to in-memory records
    this.records.push(record);

    // Keep only last MAX_RECORDS
    if (this.records.length > MAX_RECORDS) {
      this.records = this.records.slice(-MAX_RECORDS);
    }

    // Persist to sessionStorage
    this.saveToStorage();

    logger.debug('conversion', 'Conversion recorded to history', {
      codec: record.codec,
      format: record.format,
      path: record.path,
      captureModeUsed: record.captureModeUsed ?? null,
      success: record.success,
      durationMs: record.durationMs,
      errorMessage: record.success ? null : (record.errorMessage ?? null),
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

    // Filter records for this codec+format
    const filtered = this.records.filter(
      (r) => this.normalizeCodec(r.codec) === normalizedCodec && r.format === format
    );

    if (filtered.length === 0) {
      return null;
    }

    // Calculate aggregate statistics
    const totalConversions = filtered.length;
    const successfulConversions = filtered.filter((r) => r.success);
    const successRate = totalConversions > 0 ? successfulConversions.length / totalConversions : 0;
    const avgDurationMs =
      successfulConversions.length > 0
        ? successfulConversions.reduce((sum, r) => sum + r.durationMs, 0) /
          successfulConversions.length
        : 0;

    // Find preferred path (highest success rate, then fastest successful duration)
    const pathStats = this.calculatePathStatistics(filtered);
    const preferredPath = this.selectPreferredPath(pathStats);

    return {
      codec: normalizedCodec,
      format,
      records: filtered,
      statistics: {
        totalConversions,
        successRate,
        avgDurationMs,
        preferredPath,
      },
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
    const preferredAll = history.records.filter((r) => r.path === preferredPath);
    const preferredSuccesses = preferredAll.filter((r) => r.success);

    if (preferredSuccesses.length === 0) {
      return null;
    }

    const preferredSuccessRate =
      preferredAll.length > 0 ? preferredSuccesses.length / preferredAll.length : 0;

    // Confidence: require both enough samples and a stable success rate.
    const confidenceByCount = Math.min(preferredAll.length / HIGH_CONFIDENCE_THRESHOLD, 1.0);
    const confidence = Math.max(0, Math.min(1, confidenceByCount * preferredSuccessRate));

    const avgDurationMs =
      preferredSuccesses.reduce((sum, r) => sum + r.durationMs, 0) / preferredSuccesses.length;

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

    // Group records by codec+format
    for (const record of this.records) {
      const key = `${this.normalizeCodec(record.codec)}:${record.format}`;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(record);
    }

    // Convert to ConversionHistory objects
    const histories: ConversionHistory[] = [];
    for (const [key, records] of grouped) {
      const parts = key.split(':');
      if (parts.length !== 2) continue; // Skip invalid keys

      const codec = parts[0]!; // Safe because we checked parts.length === 2
      const format = parts[1]!; // Safe because we checked parts.length === 2
      const successfulRecords = records.filter((r) => r.success);

      if (records.length > 0) {
        const totalConversions = records.length;
        const successRate = successfulRecords.length / totalConversions;
        const avgDurationMs =
          successfulRecords.reduce((sum, r) => sum + r.durationMs, 0) / successfulRecords.length ||
          0;
        const pathStats = this.calculatePathStatistics(records);
        const preferredPath = this.selectPreferredPath(pathStats);

        histories.push({
          codec,
          format: format as ConversionFormat,
          records,
          statistics: {
            totalConversions,
            successRate,
            avgDurationMs,
            preferredPath,
          },
        });
      }
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

  /**
   * Load records from sessionStorage
   */
  private loadFromStorage(): void {
    if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') {
      return;
    }

    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }

      const storage = JSON.parse(raw) as HistoryStorage;

      // Validate version
      if (storage.version !== 2) {
        logger.debug('conversion', 'Strategy history version mismatch, clearing', {
          storedVersion: storage.version,
          currentVersion: 2,
        });
        window.sessionStorage.removeItem(STORAGE_KEY);
        return;
      }

      // Load records
      this.records = storage.records || [];
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
    if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') {
      return;
    }

    try {
      const storage: HistoryStorage = {
        records: this.records,
        maxRecords: MAX_RECORDS,
        version: 2,
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
  private calculatePathStatistics(records: ConversionRecord[]): Map<
    ConversionPath,
    {
      count: number;
      successCount: number;
      totalDuration: number;
      avgDuration: number;
      successRate: number;
    }
  > {
    const stats = new Map<
      ConversionPath,
      {
        count: number;
        successCount: number;
        totalDuration: number;
        avgDuration: number;
        successRate: number;
      }
    >();

    for (const record of records) {
      if (!stats.has(record.path)) {
        stats.set(record.path, {
          count: 0,
          successCount: 0,
          totalDuration: 0,
          avgDuration: 0,
          successRate: 0,
        });
      }

      const pathStats = stats.get(record.path)!;
      pathStats.count++;

      if (record.success) {
        pathStats.successCount++;
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
  private selectPreferredPath(
    pathStats: Map<
      ConversionPath,
      {
        count: number;
        successCount: number;
        totalDuration: number;
        avgDuration: number;
        successRate: number;
      }
    >
  ): ConversionPath {
    if (pathStats.size === 0) {
      return 'cpu'; // Default fallback
    }

    let preferredPath: ConversionPath = 'cpu';
    let bestSuccessRate = -1;
    let bestSuccessCount = -1;
    let bestAvgDuration = Number.POSITIVE_INFINITY;

    for (const [path, stats] of pathStats) {
      // Exclude paths that never succeeded.
      if (stats.successCount <= 0) {
        continue;
      }

      // 1) Highest success rate
      if (stats.successRate > bestSuccessRate) {
        preferredPath = path;
        bestSuccessRate = stats.successRate;
        bestSuccessCount = stats.successCount;
        bestAvgDuration = stats.avgDuration;
        continue;
      }

      // 2) Tie-breaker: more successful samples
      if (stats.successRate === bestSuccessRate && stats.successCount > bestSuccessCount) {
        preferredPath = path;
        bestSuccessCount = stats.successCount;
        bestAvgDuration = stats.avgDuration;
        continue;
      }

      // 3) Tie-breaker: faster average duration among successes
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
