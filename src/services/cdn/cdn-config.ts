/**
 * Centralized CDN Configuration
 *
 * Single source of truth for all CDN provider settings.
 * Used by service worker, FFmpeg loading, and runtime module loading.
 *
 * Provides:
 * - Unified CDN provider list with priorities
 * - Timeout configurations
 * - Health score tracking (0-100)
 * - Dynamic provider ordering based on performance
 */

/**
 * CDN provider configuration
 */
export interface CDNProvider {
  /** Provider display name */
  name: string;
  /** Provider hostname (used for URL matching) */
  hostname: string;
  /** Base URL for the CDN */
  baseUrl: string;
  /** Priority order (1 = highest priority, try first) */
  priority: number;
  /** Request timeout in milliseconds */
  timeout: number;
  /** Health score (0-100, dynamically updated based on success/failure) */
  healthScore: number;
  /** Whether this CDN is currently enabled */
  enabled: boolean;
}

/**
 * All available CDN providers
 * Ordered by default priority
 */
export const CDN_PROVIDERS: CDNProvider[] = [
  {
    name: 'esm.sh',
    hostname: 'esm.sh',
    baseUrl: 'https://esm.sh',
    priority: 1,
    timeout: 15000, // 15 seconds
    healthScore: 100,
    enabled: true,
  },
  {
    name: 'jsdelivr',
    hostname: 'cdn.jsdelivr.net',
    baseUrl: 'https://cdn.jsdelivr.net',
    priority: 2,
    timeout: 15000,
    healthScore: 100,
    enabled: true,
  },
  {
    name: 'unpkg',
    hostname: 'unpkg.com',
    baseUrl: 'https://unpkg.com',
    priority: 3,
    timeout: 15000,
    healthScore: 100,
    enabled: true,
  },
  {
    name: 'skypack',
    hostname: 'cdn.skypack.dev',
    baseUrl: 'https://cdn.skypack.dev',
    priority: 4,
    timeout: 15000,
    healthScore: 100,
    enabled: true,
  },
];

/**
 * Timeout configurations for different scenarios
 */
export const CDN_TIMEOUTS = {
  /** Default timeout per CDN attempt */
  default: 15000,
  /** Timeout for FFmpeg core assets (larger files) */
  ffmpegCore: 90000,
  /** Timeout for critical resources */
  critical: 20000,
  /** Timeout for non-critical resources */
  nonCritical: 10000,
} as const;

/**
 * Gets enabled CDN providers sorted by priority
 *
 * @returns Array of enabled CDN providers sorted by priority (ascending)
 */
export function getEnabledProviders(): CDNProvider[] {
  return CDN_PROVIDERS.filter((p) => p.enabled).sort((a, b) => a.priority - b.priority);
}

/**
 * Gets enabled CDN providers sorted by health score (descending)
 * Falls back to priority order if health scores are equal
 *
 * @returns Array of enabled CDN providers sorted by health score
 */
export function getProvidersByHealth(): CDNProvider[] {
  return CDN_PROVIDERS.filter((p) => p.enabled).sort((a, b) => {
    // Sort by health score (descending)
    if (b.healthScore !== a.healthScore) {
      return b.healthScore - a.healthScore;
    }
    // Fallback to priority order if health scores are equal
    return a.priority - b.priority;
  });
}

/**
 * Gets a CDN provider by hostname
 *
 * @param hostname - CDN hostname to look up
 * @returns CDN provider or undefined if not found
 */
export function getProviderByHostname(hostname: string): CDNProvider | undefined {
  return CDN_PROVIDERS.find((p) => p.hostname === hostname || hostname.endsWith(`.${p.hostname}`));
}

/**
 * Gets a CDN provider by name
 *
 * @param name - CDN provider name
 * @returns CDN provider or undefined if not found
 */
export function getProviderByName(name: string): CDNProvider | undefined {
  return CDN_PROVIDERS.find((p) => p.name === name);
}

/**
 * Updates the health score for a CDN provider
 * Health scores range from 0-100
 *
 * @param hostname - CDN hostname
 * @param success - Whether the request was successful
 */
export function updateHealthScore(hostname: string, success: boolean): void {
  const provider = getProviderByHostname(hostname);
  if (!provider) return;

  if (success) {
    // Gradually increase health score on success (max 100)
    provider.healthScore = Math.min(100, provider.healthScore + 5);
  } else {
    // Decrease health score more aggressively on failure (min 0)
    provider.healthScore = Math.max(0, provider.healthScore - 10);
  }
}

/**
 * Resets all health scores to 100
 * Useful for testing or after configuration changes
 */
export function resetHealthScores(): void {
  for (const provider of CDN_PROVIDERS) {
    provider.healthScore = 100;
  }
}
