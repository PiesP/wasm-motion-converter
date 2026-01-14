/**
 * CDN Health Tracking Service
 *
 * Tracks success/failure rates for each CDN provider.
 * Stores metrics in localStorage with 7-day TTL.
 * Uses exponential decay to reduce impact of old metrics.
 *
 * Health scores (0-100):
 * - 100: Perfect (all requests succeed)
 * - 80-99: Good (occasional failures)
 * - 50-79: Degraded (frequent failures)
 * - 0-49: Poor (mostly failures)
 */

import { getProviderByHostname, updateHealthScore } from './cdn-config';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

/**
 * CDN health metric entry
 */
interface HealthMetric {
  /** CDN provider hostname */
  hostname: string;
  /** Number of successful requests */
  successCount: number;
  /** Number of failed requests */
  failureCount: number;
  /** Total number of requests */
  totalCount: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Last updated timestamp */
  lastUpdated: number;
}

/**
 * CDN health tracking data structure
 */
interface HealthTrackingData {
  /** Version of the tracking data format */
  version: number;
  /** Metrics for each CDN provider */
  metrics: Record<string, HealthMetric>;
  /** When the data was created */
  createdAt: number;
}

const STORAGE_KEY = 'cdn_health_tracking';
const STORAGE_VERSION = 1;
const TTL_DAYS = 7;
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Loads health tracking data from localStorage
 *
 * @returns Health tracking data or null if not found/expired
 */
function loadHealthData(): HealthTrackingData | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;

    const data = JSON.parse(stored) as HealthTrackingData;

    // Check version compatibility
    if (data.version !== STORAGE_VERSION) {
      logger.warn('cdn', 'CDN health tracking version mismatch; clearing stored data', {
        storedVersion: data.version,
        expectedVersion: STORAGE_VERSION,
      });
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    // Check TTL
    const age = Date.now() - data.createdAt;
    if (age > TTL_MS) {
      logger.info('cdn', 'CDN health tracking data expired; clearing', {
        ageMs: age,
        ttlMs: TTL_MS,
      });
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    return data;
  } catch (error) {
    logger.warn('cdn', 'Failed to load CDN health tracking data', {
      error: getErrorMessage(error),
    });
    return null;
  }
}

/**
 * Saves health tracking data to localStorage
 *
 * @param data - Health tracking data to save
 */
function saveHealthData(data: HealthTrackingData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (error) {
    logger.warn('cdn', 'Failed to save CDN health tracking data', {
      error: getErrorMessage(error),
    });
  }
}

/**
 * Gets or creates health tracking data
 *
 * @returns Health tracking data
 */
function getOrCreateHealthData(): HealthTrackingData {
  const existing = loadHealthData();
  if (existing) return existing;

  return {
    version: STORAGE_VERSION,
    metrics: {},
    createdAt: Date.now(),
  };
}

/**
 * Gets or creates a health metric for a CDN provider
 *
 * @param data - Health tracking data
 * @param hostname - CDN hostname
 * @returns Health metric for the provider
 */
function getOrCreateMetric(data: HealthTrackingData, hostname: string): HealthMetric {
  if (!data.metrics[hostname]) {
    data.metrics[hostname] = {
      hostname,
      successCount: 0,
      failureCount: 0,
      totalCount: 0,
      successRate: 1.0, // Start with optimistic assumption
      lastUpdated: Date.now(),
    };
  }
  return data.metrics[hostname];
}

/**
 * Applies exponential decay to reduce impact of old metrics
 * Metrics older than 24 hours are gradually weighted less
 *
 * @param metric - Health metric to decay
 */
function applyExponentialDecay(metric: HealthMetric): void {
  const age = Date.now() - metric.lastUpdated;
  const ageHours = age / (60 * 60 * 1000);

  // Apply decay if metrics are older than 1 hour
  if (ageHours > 1) {
    // Decay factor: 0.9^hours (10% decay per hour)
    const decayFactor = 0.9 ** ageHours;

    // Apply decay to counts (but keep at least 1 for stability)
    metric.successCount = Math.max(1, Math.floor(metric.successCount * decayFactor));
    metric.failureCount = Math.max(0, Math.floor(metric.failureCount * decayFactor));
    metric.totalCount = metric.successCount + metric.failureCount;

    // Recalculate success rate
    metric.successRate = metric.totalCount > 0 ? metric.successCount / metric.totalCount : 1.0;
  }
}

/**
 * Records a CDN request result
 *
 * @param hostname - CDN hostname
 * @param success - Whether the request was successful
 */
export function recordCdnRequest(hostname: string, success: boolean): void {
  const data = getOrCreateHealthData();
  const metric = getOrCreateMetric(data, hostname);

  // Apply exponential decay before adding new data
  applyExponentialDecay(metric);

  // Update counts
  if (success) {
    metric.successCount++;
  } else {
    metric.failureCount++;
  }
  metric.totalCount = metric.successCount + metric.failureCount;

  // Calculate new success rate
  metric.successRate = metric.totalCount > 0 ? metric.successCount / metric.totalCount : 1.0;
  metric.lastUpdated = Date.now();

  // Update health score in CDN config
  updateHealthScore(hostname, success);

  // Save to localStorage
  saveHealthData(data);

  // Log health status (dev-only to avoid noisy production consoles)
  logger.debug('cdn', 'CDN request recorded', {
    hostname,
    success,
    successRatePct: Number((metric.successRate * 100).toFixed(1)),
    totalRequests: metric.totalCount,
  });
}

/**
 * Gets health metrics for all CDN providers
 *
 * @returns Map of hostname to health metric
 */
export function getAllHealthMetrics(): Record<string, HealthMetric> {
  const data = loadHealthData();
  if (!data) return {};

  // Apply decay to all metrics before returning
  for (const metric of Object.values(data.metrics)) {
    applyExponentialDecay(metric);
  }

  return data.metrics;
}

/**
 * Gets health metric for a specific CDN provider
 *
 * @param hostname - CDN hostname
 * @returns Health metric or null if not found
 */
export function getHealthMetric(hostname: string): HealthMetric | null {
  const metrics = getAllHealthMetrics();
  return metrics[hostname] || null;
}

/**
 * Resets health tracking data for all CDN providers
 */
export function resetHealthTracking(): void {
  localStorage.removeItem(STORAGE_KEY);
  logger.info('cdn', 'CDN health tracking data reset');
}

/**
 * Gets a health status summary for all CDN providers
 *
 * @returns Array of health summaries sorted by success rate
 */
export function getHealthSummary(): Array<{
  hostname: string;
  successRate: number;
  totalRequests: number;
  status: 'excellent' | 'good' | 'degraded' | 'poor';
}> {
  const metrics = getAllHealthMetrics();

  return Object.values(metrics)
    .map((metric) => {
      let status: 'excellent' | 'good' | 'degraded' | 'poor';
      if (metric.successRate >= 0.95) status = 'excellent';
      else if (metric.successRate >= 0.8) status = 'good';
      else if (metric.successRate >= 0.5) status = 'degraded';
      else status = 'poor';

      return {
        hostname: metric.hostname,
        successRate: metric.successRate,
        totalRequests: metric.totalCount,
        status,
      };
    })
    .sort((a, b) => b.successRate - a.successRate);
}

/**
 * Initializes health tracking by loading stored data
 * and updating health scores in CDN config
 */
export function initializeHealthTracking(): void {
  const metrics = getAllHealthMetrics();

  // Update health scores in CDN config based on stored metrics
  for (const [hostname, metric] of Object.entries(metrics)) {
    const provider = getProviderByHostname(hostname);
    if (provider) {
      // Convert success rate to health score (0-100)
      provider.healthScore = Math.round(metric.successRate * 100);
    }
  }

  const summary = getHealthSummary();
  if (summary.length > 0) {
    logger.info('cdn', 'Initialized CDN health tracking from stored metrics', {
      summary,
    });
  }
}
