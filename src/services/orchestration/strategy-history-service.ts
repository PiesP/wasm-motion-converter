/**
 * Strategy History Service
 *
 * Tracks successful conversions to learn optimal paths per codec+format combination.
 * Uses sessionStorage for session-scoped learning (fresh detection each session).
 *
 * Learning Logic:
 * - Store last 50 successful conversions
 * - Calculate success rate per path for each codec+format
 * - Recommend path with highest success rate, then fastest duration
 * - Confidence = min(recordCount / 5, 1.0) (high confidence after 5+ conversions)
 */

import type { ConversionFormat } from "@t/conversion-types";
import type { ConversionPath } from "@services/orchestration/types";
import { getErrorMessage } from "@utils/error-utils";
import { logger } from "@utils/logger";

const STORAGE_KEY = "strategy_history_v1" as const;
const MAX_RECORDS = 50 as const;
const HIGH_CONFIDENCE_THRESHOLD = 5 as const; // 5+ conversions for high confidence

/**
 * Record of a single conversion
 */
export interface ConversionRecord {
  codec: string;
  format: ConversionFormat;
  path: ConversionPath;
  durationMs: number;
  success: boolean;
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
  private static instance: StrategyHistoryService | null = null;

  static getInstance(): StrategyHistoryService {
    StrategyHistoryService.instance ??= new StrategyHistoryService();
    return StrategyHistoryService.instance;
  }

  private records: ConversionRecord[] = [];

  // Enforce singleton
  private constructor() {
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

    logger.debug("conversion", "Conversion recorded to history", {
      codec: record.codec,
      format: record.format,
      path: record.path,
      success: record.success,
      durationMs: record.durationMs,
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
  getHistory(
    codec: string,
    format: ConversionFormat
  ): ConversionHistory | null {
    const normalizedCodec = this.normalizeCodec(codec);

    // Filter records for this codec+format
    const filtered = this.records.filter(
      (r) =>
        this.normalizeCodec(r.codec) === normalizedCodec && r.format === format
    );

    if (filtered.length === 0) {
      return null;
    }

    // Calculate statistics
    const totalConversions = filtered.length;
    const successfulConversions = filtered.filter((r) => r.success);
    const successRate = successfulConversions.length / totalConversions;
    const avgDurationMs =
      successfulConversions.reduce((sum, r) => sum + r.durationMs, 0) /
        successfulConversions.length || 0;

    // Find preferred path (highest success rate, then fastest)
    const pathStats = this.calculatePathStatistics(successfulConversions);
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
  getRecommendedPath(
    codec: string,
    format: ConversionFormat
  ): RecommendedPath | null {
    const history = this.getHistory(codec, format);
    if (!history) {
      return null;
    }

    const successfulRecords = history.records.filter((r) => r.success);
    if (successfulRecords.length === 0) {
      return null;
    }

    // Calculate confidence (0-1, based on number of successful conversions)
    const confidence = Math.min(
      successfulRecords.length / HIGH_CONFIDENCE_THRESHOLD,
      1.0
    );

    // Get average duration for preferred path
    const preferredPathRecords = successfulRecords.filter(
      (r) => r.path === history.statistics.preferredPath
    );
    const avgDurationMs =
      preferredPathRecords.reduce((sum, r) => sum + r.durationMs, 0) /
        preferredPathRecords.length || 0;

    return {
      path: history.statistics.preferredPath,
      confidence,
      basedOnRecords: successfulRecords.length,
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
      const parts = key.split(":");
      if (parts.length !== 2) continue; // Skip invalid keys

      const codec = parts[0]!; // Safe because we checked parts.length === 2
      const format = parts[1]!; // Safe because we checked parts.length === 2
      const successfulRecords = records.filter((r) => r.success);

      if (records.length > 0) {
        const totalConversions = records.length;
        const successRate = successfulRecords.length / totalConversions;
        const avgDurationMs =
          successfulRecords.reduce((sum, r) => sum + r.durationMs, 0) /
            successfulRecords.length || 0;
        const pathStats = this.calculatePathStatistics(successfulRecords);
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
    logger.debug("conversion", "Conversion history cleared");
  }

  /**
   * Load records from sessionStorage
   */
  private loadFromStorage(): void {
    if (
      typeof window === "undefined" ||
      typeof window.sessionStorage === "undefined"
    ) {
      return;
    }

    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }

      const storage = JSON.parse(raw) as HistoryStorage;

      // Validate version
      if (storage.version !== 1) {
        logger.debug(
          "conversion",
          "Strategy history version mismatch, clearing",
          {
            storedVersion: storage.version,
            currentVersion: 1,
          }
        );
        window.sessionStorage.removeItem(STORAGE_KEY);
        return;
      }

      // Load records
      this.records = storage.records || [];
      logger.debug(
        "conversion",
        "Strategy history loaded from sessionStorage",
        {
          recordCount: this.records.length,
        }
      );
    } catch (error) {
      logger.warn(
        "conversion",
        "Failed to load strategy history (non-critical)",
        {
          error: getErrorMessage(error),
        }
      );
    }
  }

  /**
   * Save records to sessionStorage
   */
  private saveToStorage(): void {
    if (
      typeof window === "undefined" ||
      typeof window.sessionStorage === "undefined"
    ) {
      return;
    }

    try {
      const storage: HistoryStorage = {
        records: this.records,
        maxRecords: MAX_RECORDS,
        version: 1,
      };

      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
    } catch (error) {
      logger.warn(
        "conversion",
        "Failed to save strategy history (non-critical)",
        {
          error: getErrorMessage(error),
        }
      );
    }
  }

  /**
   * Calculate statistics per path
   */
  private calculatePathStatistics(records: ConversionRecord[]): Map<
    ConversionPath,
    {
      count: number;
      totalDuration: number;
      avgDuration: number;
      successRate: number;
    }
  > {
    const stats = new Map<
      ConversionPath,
      {
        count: number;
        totalDuration: number;
        avgDuration: number;
        successRate: number;
      }
    >();

    for (const record of records) {
      if (!stats.has(record.path)) {
        stats.set(record.path, {
          count: 0,
          totalDuration: 0,
          avgDuration: 0,
          successRate: 1.0, // All records here are successful
        });
      }

      const pathStats = stats.get(record.path)!;
      pathStats.count++;
      pathStats.totalDuration += record.durationMs;
      pathStats.avgDuration = pathStats.totalDuration / pathStats.count;
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
        totalDuration: number;
        avgDuration: number;
        successRate: number;
      }
    >
  ): ConversionPath {
    if (pathStats.size === 0) {
      return "cpu"; // Default fallback
    }

    let preferredPath: ConversionPath = "cpu";
    let maxCount = 0;
    let minAvgDuration = Number.POSITIVE_INFINITY;

    for (const [path, stats] of pathStats) {
      // Prefer path with more conversions
      if (stats.count > maxCount) {
        preferredPath = path;
        maxCount = stats.count;
        minAvgDuration = stats.avgDuration;
      } else if (stats.count === maxCount) {
        // Tie-breaker: Prefer faster path
        if (stats.avgDuration < minAvgDuration) {
          preferredPath = path;
          minAvgDuration = stats.avgDuration;
        }
      }
    }

    return preferredPath;
  }

  /**
   * Normalize codec string for consistent matching
   */
  private normalizeCodec(codec: string): string {
    const lower = codec.toLowerCase();

    if (lower.includes("h264") || lower.includes("avc")) return "h264";
    if (
      lower.includes("hevc") ||
      lower.includes("h265") ||
      lower.includes("hvc")
    )
      return "hevc";
    if (lower.includes("av1") || lower.includes("av01")) return "av1";
    if (lower.includes("vp09") || lower.includes("vp9")) return "vp9";
    if (lower.includes("vp08") || lower.includes("vp8")) return "vp8";

    return lower;
  }
}

export const strategyHistoryService = StrategyHistoryService.getInstance();
