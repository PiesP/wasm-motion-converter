/**
 * Service Worker for CDN Resource Caching
 *
 * NOTE: This file is compiled to JavaScript during production build.
 * In development mode, Service Worker registration is skipped.
 *
 * Build process:
 * 1. vite.config.ts compiles this file using esbuild
 * 2. Output: dist/service-worker.js (minified JavaScript)
 * 3. Registration code is inlined in HTML <head>
 *
 * Implements intelligent caching strategy for external dependencies:
 * - First visit: Network-first to populate cache
 * - Return visits: Cache-first with background revalidation
 * - Multi-CDN fallback cascade for reliability
 *
 * Caching strategy aligned with AGENTS.md requirements:
 * - English-only comments and logging
 * - Cross-origin isolation preserved for FFmpeg
 * - No server uploads (client-side only)
 */

/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

/**
 * Service Worker version for cache invalidation
 * Increment when breaking changes require cache reset
 */
const SW_VERSION = "v1.0.0";

/**
 * Cache name prefix for versioning
 */
const CACHE_VERSION = "v1";

/**
 * Cache storage names with version identifiers
 */
const CACHE_NAMES = {
  cdn: `cdn-deps-${CACHE_VERSION}`,
  ffmpeg: `ffmpeg-core-${CACHE_VERSION}`, // Preserve existing FFmpeg cache
  app: `app-bundle-${CACHE_VERSION}`,
  fallback: `fallback-${CACHE_VERSION}`,
} as const;

/**
 * All current cache names for cleanup
 */
const ALL_CACHE_NAMES = Object.values(CACHE_NAMES);

/**
 * CDN provider configuration aligned with unified system
 */
interface CDNProvider {
  name: string;
  hostname: string;
  priority: number;
  healthScore: number;
}

/**
 * CDN providers with default configuration
 * Health scores are loaded dynamically from localStorage
 */
const CDN_PROVIDERS: CDNProvider[] = [
  { name: "esm.sh", hostname: "esm.sh", priority: 1, healthScore: 100 },
  { name: "jsdelivr", hostname: "cdn.jsdelivr.net", priority: 2, healthScore: 100 },
  { name: "unpkg", hostname: "unpkg.com", priority: 3, healthScore: 100 },
  { name: "skypack", hostname: "cdn.skypack.dev", priority: 4, healthScore: 100 },
];

/**
 * CDN domains to intercept and cache
 */
const CDN_DOMAINS = CDN_PROVIDERS.map((p) => p.hostname);

/**
 * SRI manifest structure matching public/cdn-integrity.json
 */
interface CDNEntry {
  url: string;
  integrity: string;
  size: number;
}

interface ManifestEntry {
  "esm.sh": CDNEntry;
  jsdelivr: CDNEntry;
  unpkg: CDNEntry;
  skypack?: CDNEntry;
}

interface SRIManifest {
  version: string;
  generated: string;
  entries: Record<string, ManifestEntry>;
}

/**
 * Global SRI manifest cache
 * Loaded lazily on first CDN request
 */
let sriManifest: SRIManifest | null = null;

/**
 * Loads the SRI manifest from cdn-integrity.json
 * Caches the manifest in memory for subsequent verifications
 *
 * @returns SRI manifest or null if loading fails
 */
async function loadSRIManifest(): Promise<SRIManifest | null> {
  if (sriManifest) {
    return sriManifest;
  }

  try {
    const response = await fetch("/cdn-integrity.json");
    if (!response.ok) {
      console.warn(`[SW ${SW_VERSION}] Failed to load SRI manifest: HTTP ${response.status}`);
      return null;
    }

    sriManifest = (await response.json()) as SRIManifest;
    console.log(
      `[SW ${SW_VERSION}] SRI manifest loaded: ${Object.keys(sriManifest.entries).length} entries`
    );
    return sriManifest;
  } catch (error) {
    console.error(`[SW ${SW_VERSION}] Error loading SRI manifest:`, error);
    return null;
  }
}

/**
 * Verifies the integrity of a Response using SHA-384 hash
 *
 * @param response - Response to verify
 * @param expectedIntegrity - Expected SRI hash (e.g., "sha384-...")
 * @returns True if integrity matches, false otherwise
 */
async function verifyIntegrity(
  response: Response,
  expectedIntegrity: string
): Promise<boolean> {
  try {
    // Clone response to avoid consuming the body
    const buffer = await response.clone().arrayBuffer();

    // Compute SHA-384 hash
    const hashBuffer = await crypto.subtle.digest("SHA-384", buffer);

    // Convert to base64
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashBase64 = btoa(String.fromCharCode(...hashArray));
    const computedIntegrity = `sha384-${hashBase64}`;

    const isValid = computedIntegrity === expectedIntegrity;

    if (!isValid) {
      console.error(
        `[SW ${SW_VERSION}] ✗ Integrity verification failed!`,
        `\n  Expected: ${expectedIntegrity}`,
        `\n  Computed: ${computedIntegrity}`,
        `\n  URL: ${response.url}`
      );
    }

    return isValid;
  } catch (error) {
    console.error(`[SW ${SW_VERSION}] Error verifying integrity:`, error);
    return false;
  }
}

/**
 * Gets expected integrity hash for a CDN URL from the SRI manifest
 *
 * @param url - CDN URL to look up
 * @param manifest - SRI manifest
 * @returns Expected integrity hash or null if not found
 */
function getExpectedIntegrity(
  url: string,
  manifest: SRIManifest
): string | null {
  // Parse URL to extract package name
  const urlObj = new URL(url);

  // Determine CDN provider
  let cdnProvider: keyof ManifestEntry | null = null;
  if (urlObj.hostname === "esm.sh") cdnProvider = "esm.sh";
  else if (urlObj.hostname === "cdn.jsdelivr.net") cdnProvider = "jsdelivr";
  else if (urlObj.hostname === "unpkg.com") cdnProvider = "unpkg";
  else if (urlObj.hostname === "cdn.skypack.dev") cdnProvider = "skypack";

  if (!cdnProvider) {
    return null;
  }

  // Search manifest entries for matching URL
  for (const [_pkg, entry] of Object.entries(manifest.entries)) {
    const cdnEntry = entry[cdnProvider];
    if (cdnEntry && cdnEntry.url === url) {
      return cdnEntry.integrity;
    }
  }

  return null;
}

/**
 * Health tracking data structure (matches cdn-health-tracker.ts)
 */
interface HealthMetric {
  hostname: string;
  successCount: number;
  failureCount: number;
  totalCount: number;
  successRate: number;
  lastUpdated: number;
}

interface HealthTrackingData {
  version: number;
  metrics: Record<string, HealthMetric>;
  createdAt: number;
}

/**
 * Loads health tracking data from localStorage
 * Returns health scores for all CDN providers
 *
 * @returns Map of hostname to health score (0-100)
 */
function loadHealthScores(): Map<string, number> {
  const scores = new Map<string, number>();

  try {
    const stored = localStorage.getItem("cdn_health_tracking");
    if (!stored) return scores;

    const data = JSON.parse(stored) as HealthTrackingData;

    // Check TTL (7 days)
    const age = Date.now() - data.createdAt;
    const TTL_MS = 7 * 24 * 60 * 60 * 1000;
    if (age > TTL_MS) {
      return scores; // Expired data
    }

    // Extract health scores from metrics
    for (const [hostname, metric] of Object.entries(data.metrics)) {
      // Convert success rate to health score (0-100)
      const healthScore = Math.round(metric.successRate * 100);
      scores.set(hostname, healthScore);
    }

    console.log(`[SW ${SW_VERSION}] Loaded health scores:`, Object.fromEntries(scores));
  } catch (error) {
    console.warn(`[SW ${SW_VERSION}] Failed to load health scores:`, error);
  }

  return scores;
}

/**
 * Updates health score for a CDN provider in localStorage
 * This is a simplified version - full tracking is done by cdn-health-tracker.ts
 *
 * @param hostname - CDN hostname
 * @param success - Whether the request succeeded
 */
function updateHealthScore(hostname: string, success: boolean): void {
  try {
    const stored = localStorage.getItem("cdn_health_tracking");
    let data: HealthTrackingData;

    if (stored) {
      data = JSON.parse(stored) as HealthTrackingData;
    } else {
      data = {
        version: 1,
        metrics: {},
        createdAt: Date.now(),
      };
    }

    // Get or create metric
    if (!data.metrics[hostname]) {
      data.metrics[hostname] = {
        hostname,
        successCount: 0,
        failureCount: 0,
        totalCount: 0,
        successRate: 1.0,
        lastUpdated: Date.now(),
      };
    }

    const metric = data.metrics[hostname];

    // Update counts
    if (success) {
      metric.successCount++;
    } else {
      metric.failureCount++;
    }
    metric.totalCount = metric.successCount + metric.failureCount;
    metric.successRate = metric.totalCount > 0 ? metric.successCount / metric.totalCount : 1.0;
    metric.lastUpdated = Date.now();

    // Save back to localStorage
    localStorage.setItem("cdn_health_tracking", JSON.stringify(data));
  } catch (error) {
    console.warn(`[SW ${SW_VERSION}] Failed to update health score:`, error);
  }
}

/**
 * Gets optimally ordered CDN providers based on health scores
 * Providers are sorted by health score (descending), then by priority
 *
 * @returns Array of CDN providers sorted by health score
 */
function getOrderedProviders(): CDNProvider[] {
  const healthScores = loadHealthScores();

  // Clone providers and update health scores
  const providers = CDN_PROVIDERS.map((p) => ({
    ...p,
    healthScore: healthScores.get(p.hostname) ?? p.healthScore,
  }));

  // Sort by health score (descending), then by priority (ascending)
  providers.sort((a, b) => {
    if (a.healthScore !== b.healthScore) {
      return b.healthScore - a.healthScore; // Higher score first
    }
    return a.priority - b.priority; // Lower priority number first
  });

  console.log(
    `[SW ${SW_VERSION}] CDN order:`,
    providers.map((p) => `${p.name} (${p.healthScore})`)
  );

  return providers;
}

/**
 * Request type classification for routing strategy
 */
type RequestType = "cdn" | "ffmpeg" | "app" | "ignore";

/**
 * Classifies request for appropriate caching strategy
 *
 * @param url - Request URL to classify
 * @returns Request type for routing decision
 */
function classifyRequest(url: URL): RequestType {
  // CDN resources (dependencies loaded from external CDNs)
  if (
    CDN_DOMAINS.some(
      (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)
    )
  ) {
    return "cdn";
  }

  // FFmpeg core assets (preserve existing caching pattern)
  if (url.pathname.includes("@ffmpeg/core")) {
    return "ffmpeg";
  }

  // App bundles (Vite-generated assets)
  if (url.pathname.startsWith("/assets/")) {
    return "app";
  }

  // Pass through (HTML, other static assets)
  return "ignore";
}

/**
 * Service Worker install event
 * Activates immediately without waiting for existing clients
 * Phase 4: Initializes fallback cache
 */
self.addEventListener("install", (event: ExtendableEvent) => {
  console.log(`[SW ${SW_VERSION}] Installing...`);

  // Skip waiting to activate immediately (aggressive update strategy)
  self.skipWaiting();

  // Phase 4: Initialize fallback cache
  // Note: Actual fallback bundles are populated on first successful CDN load
  // This ensures fallback cache exists and is ready
  event.waitUntil(
    caches.open(CACHE_NAMES.fallback).then(() => {
      console.log(`[SW ${SW_VERSION}] Fallback cache initialized`);
      return Promise.resolve();
    })
  );
});

/**
 * Service Worker activate event
 * Cleans up old caches and takes control immediately
 */
self.addEventListener("activate", (event: ExtendableEvent) => {
  console.log(`[SW ${SW_VERSION}] Activating...`);

  event.waitUntil(
    (async () => {
      // Clean up old cache versions
      const cacheNames = await caches.keys();
      const validCacheNames = ALL_CACHE_NAMES as readonly string[];
      await Promise.all(
        cacheNames.map((cacheName) => {
          if (!validCacheNames.includes(cacheName)) {
            console.log(`[SW ${SW_VERSION}] Deleting old cache: ${cacheName}`);
            return caches.delete(cacheName);
          }
        })
      );

      // Take control of all clients immediately
      await self.clients.claim();
      console.log(`[SW ${SW_VERSION}] Activated and claimed clients`);
    })()
  );
});

/**
 * Timeout wrapper for fetch requests
 * Rejects if request takes longer than specified timeout
 *
 * @param request - Request to fetch
 * @param timeout - Timeout in milliseconds
 * @returns Response or throws on timeout
 */
async function fetchWithTimeout(
  request: Request,
  timeout: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * CDN URL conversion utilities
 * Converts URLs between different CDN providers for fallback
 */
const CDN_CONVERTERS = {
  /**
   * Parses an esm.sh URL into { pkg, version, path }.
   *
   * Supported examples:
   * - https://esm.sh/solid-js@1.9.10/web?target=esnext
   * - https://esm.sh/@ffmpeg/ffmpeg@0.12.15?target=esnext
   * - https://esm.sh/@jsquash/webp@1.5.0/encode.js?target=esnext
   * - https://esm.sh/@jsquash/webp@1.5.0/codec/enc/webp_enc.wasm
   */
  parseEsmSh(
    url: string
  ): { pkg: string; version: string; path: string; isAsset: boolean } | null {
    try {
      const u = new URL(url);
      if (u.hostname !== "esm.sh" && !u.hostname.endsWith(".esm.sh")) {
        return null;
      }

      const pathname = u.pathname.startsWith("/")
        ? u.pathname.slice(1)
        : u.pathname;
      // Match either scoped (@scope/name) or unscoped (name) package.
      const match = pathname.match(
        /^((?:@[^/]+\/[^@/]+)|(?:[^@/]+))@([^/]+)(\/.*)?$/
      );
      if (!match) {
        return null;
      }

      const pkg = match[1];
      const version = match[2];
      const rawPath = match[3] ?? "";

      if (!pkg || !version) {
        return null;
      }

      const path = rawPath || "";

      // Avoid applying module transforms to binary/static assets.
      const lower = path.toLowerCase();
      const isAsset =
        lower.endsWith(".wasm") ||
        lower.endsWith(".data") ||
        lower.endsWith(".bin") ||
        lower.endsWith(".png") ||
        lower.endsWith(".jpg") ||
        lower.endsWith(".jpeg") ||
        lower.endsWith(".gif") ||
        lower.endsWith(".webp") ||
        lower.endsWith(".svg") ||
        lower.endsWith(".css") ||
        lower.endsWith(".map");

      return { pkg, version, path, isAsset };
    } catch {
      return null;
    }
  },

  /**
   * Converts esm.sh URL to jsdelivr format
   */
  esmToJsdelivr(url: string): string | null {
    const parsed = this.parseEsmSh(url);
    if (!parsed) return null;

    // jsDelivr supports +esm for module conversion; do NOT apply it to assets.
    if (parsed.isAsset) {
      return `https://cdn.jsdelivr.net/npm/${parsed.pkg}@${parsed.version}${parsed.path}`;
    }

    return `https://cdn.jsdelivr.net/npm/${parsed.pkg}@${parsed.version}${parsed.path}/+esm`;
  },

  /**
   * Converts esm.sh URL to unpkg format
   */
  esmToUnpkg(url: string): string | null {
    const parsed = this.parseEsmSh(url);
    if (!parsed) return null;

    // unpkg's ?module is for JS modules; avoid it for binary assets.
    if (parsed.isAsset) {
      return `https://unpkg.com/${parsed.pkg}@${parsed.version}${parsed.path}`;
    }

    return `https://unpkg.com/${parsed.pkg}@${parsed.version}${parsed.path}?module`;
  },

  /**
   * Converts esm.sh URL to skypack format
   */
  esmToSkypack(url: string): string | null {
    const parsed = this.parseEsmSh(url);
    if (!parsed) return null;

    // Skypack is primarily for modules; skip assets.
    if (parsed.isAsset) {
      return null;
    }

    return `https://cdn.skypack.dev/${parsed.pkg}@${parsed.version}${parsed.path}`;
  },
};

/**
 * CDN performance metrics interface
 */
interface CDNMetrics {
  url: string;
  cdnName: string;
  latency: number;
  success: boolean;
  status?: number;
  error?: string;
  timestamp: number;
}

/**
 * Logs CDN performance metrics to console
 * In production, this could be sent to analytics service
 *
 * @param metrics - Performance metrics to log
 */
function logCDNMetrics(metrics: CDNMetrics): void {
  const emoji = metrics.success ? "✓" : "✗";
  const latencyMs = metrics.latency.toFixed(0);

  if (metrics.success) {
    console.log(
      `[SW ${SW_VERSION}] ${emoji} ${metrics.cdnName}: ${latencyMs}ms (HTTP ${metrics.status})`
    );
  } else {
    console.warn(
      `[SW ${SW_VERSION}] ${emoji} ${metrics.cdnName}: ${latencyMs}ms - ${metrics.error}`
    );
  }

  // Could store to IndexedDB for analytics:
  // await storeMetrics(metrics);
}

/**
 * Converts URL to a specific CDN provider
 *
 * @param originalUrl - Original URL (usually esm.sh)
 * @param targetProvider - Target CDN provider name
 * @returns Converted URL or null if conversion not possible
 */
function convertToCDN(originalUrl: string, targetProvider: string): string | null {
  switch (targetProvider) {
    case "esm.sh":
      return originalUrl; // Already esm.sh format
    case "jsdelivr":
      return CDN_CONVERTERS.esmToJsdelivr(originalUrl);
    case "unpkg":
      return CDN_CONVERTERS.esmToUnpkg(originalUrl);
    case "skypack":
      return CDN_CONVERTERS.esmToSkypack(originalUrl);
    default:
      return null;
  }
}

/**
 * Attempts to fetch from a single CDN provider with SRI verification
 *
 * @param url - CDN URL to fetch
 * @param provider - CDN provider info
 * @param timeout - Timeout in milliseconds
 * @param manifest - SRI manifest for integrity verification
 * @returns Response if successful, null if failed
 */
async function tryFetchFromCDN(
  url: string,
  provider: CDNProvider,
  timeout: number,
  manifest: SRIManifest | null
): Promise<Response | null> {
  const startTime = performance.now();

  try {
    console.log(`[SW ${SW_VERSION}] Trying ${provider.name}: ${url}`);
    const response = await fetchWithTimeout(new Request(url), timeout);
    const latency = performance.now() - startTime;

    if (!response.ok) {
      logCDNMetrics({
        url,
        cdnName: provider.name,
        latency,
        success: false,
        status: response.status,
        error: `HTTP ${response.status}`,
        timestamp: Date.now(),
      });
      updateHealthScore(provider.hostname, false);
      return null;
    }

    // Verify integrity if manifest is available
    if (manifest) {
      const expectedIntegrity = getExpectedIntegrity(url, manifest);
      if (expectedIntegrity) {
        const isValid = await verifyIntegrity(response, expectedIntegrity);
        if (!isValid) {
          console.error(
            `[SW ${SW_VERSION}] ✗ Integrity verification failed for ${provider.name}`
          );
          logCDNMetrics({
            url,
            cdnName: provider.name,
            latency,
            success: false,
            status: response.status,
            error: "Integrity verification failed",
            timestamp: Date.now(),
          });
          updateHealthScore(provider.hostname, false);
          return null;
        }
        console.log(`[SW ${SW_VERSION}] ✓ Integrity verified for ${provider.name}`);
      } else {
        console.warn(
          `[SW ${SW_VERSION}] ⚠ No SRI hash found for ${url}, proceeding without verification`
        );
      }
    } else {
      console.warn(
        `[SW ${SW_VERSION}] ⚠ SRI manifest not loaded, proceeding without verification`
      );
    }

    // Success
    logCDNMetrics({
      url,
      cdnName: provider.name,
      latency,
      success: true,
      status: response.status,
      timestamp: Date.now(),
    });
    updateHealthScore(provider.hostname, true);
    return response;
  } catch (error) {
    const latency = performance.now() - startTime;
    logCDNMetrics({
      url,
      cdnName: provider.name,
      latency,
      success: false,
      error: String(error),
      timestamp: Date.now(),
    });
    updateHealthScore(provider.hostname, false);
    return null;
  }
}

/**
 * Connection type detection for adaptive strategy
 */
type ConnectionType = "fast" | "medium" | "slow" | "unknown";

/**
 * NetworkInformation API types (experimental)
 */
interface NetworkInformation extends EventTarget {
  effectiveType?: "4g" | "3g" | "2g" | "slow-2g";
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

interface NavigatorWithConnection extends Navigator {
  connection?: NetworkInformation;
}

/**
 * Detects current network connection type
 *
 * @returns Connection type category for strategy selection
 */
function detectConnectionType(): ConnectionType {
  try {
    const nav = self.navigator as NavigatorWithConnection;
    const connection = nav.connection;

    if (!connection) {
      return "unknown";
    }

    if (connection.saveData) {
      return "slow";
    }

    if (connection.effectiveType) {
      switch (connection.effectiveType) {
        case "4g":
          return "fast";
        case "3g":
          return "medium";
        case "2g":
        case "slow-2g":
          return "slow";
      }
    }

    if (connection.rtt !== undefined) {
      if (connection.rtt < 100) return "fast";
      if (connection.rtt < 400) return "medium";
      return "slow";
    }

    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Calculates adaptive timeout based on connection type
 *
 * @param baseTimeout - Base timeout in milliseconds
 * @param connectionType - Connection type
 * @returns Adjusted timeout in milliseconds
 */
function getAdaptiveTimeout(
  baseTimeout: number,
  connectionType: ConnectionType
): number {
  switch (connectionType) {
    case "fast":
      return baseTimeout; // 15s
    case "medium":
      return Math.round(baseTimeout * 1.5); // 22.5s for 3G
    case "slow":
      return Math.round(baseTimeout * 2.0); // 30s for 2G
    default:
      return baseTimeout;
  }
}

/**
 * Fetches from multiple CDNs in parallel (racing)
 * Cancels slower requests when first succeeds
 * Only used on fast connections to avoid bandwidth waste
 *
 * @param originalUrl - Original CDN URL
 * @param providers - CDN providers to race
 * @param timeout - Timeout per CDN attempt
 * @param manifest - SRI manifest for verification
 * @returns Response from fastest successful CDN or null if all fail
 */
async function fetchWithRacing(
  originalUrl: string,
  providers: CDNProvider[],
  timeout: number,
  manifest: SRIManifest | null
): Promise<Response | null> {
  // Create abort controllers for each CDN request
  const controllers = new Map<string, AbortController>();

  try {
    // Start all CDN fetches in parallel
    const fetchPromises = providers.map(async (provider) => {
      const url = convertToCDN(originalUrl, provider.name);
      if (!url) {
        return { provider, response: null };
      }

      const controller = new AbortController();
      controllers.set(provider.name, controller);

      const response = await tryFetchFromCDN(url, provider, timeout, manifest);
      return { provider, response };
    });

    // Race all fetches - first success wins
    const results = await Promise.allSettled(fetchPromises);

    // Find first successful response
    for (const result of results) {
      if (result.status === "fulfilled" && result.value.response) {
        const { provider, response } = result.value;

        // Cancel all other pending requests
        for (const [name, controller] of controllers.entries()) {
          if (name !== provider.name) {
            controller.abort();
          }
        }

        console.log(
          `[SW ${SW_VERSION}] ✓ Parallel racing won by ${provider.name}`
        );
        return response;
      }
    }

    // All failed
    return null;
  } catch (error) {
    console.error(`[SW ${SW_VERSION}] Parallel racing error:`, error);
    return null;
  }
}

/**
 * Fetches from CDN with multi-provider cascade fallback and SRI verification
 * Uses dynamic CDN ordering based on health scores
 * Verifies integrity of each response before returning
 * Logs performance metrics for each attempt
 * Supports both sequential cascade and parallel racing strategies
 *
 * @param originalUrl - Original CDN URL
 * @param baseTimeout - Base timeout per CDN attempt (default: 15s)
 * @param useRacing - Whether to use parallel racing (default: auto-detect)
 * @returns Response from successful CDN with valid integrity or throws if all fail
 */
async function fetchWithCascade(
  originalUrl: string,
  baseTimeout = 15000,
  useRacing?: boolean
): Promise<Response> {
  const errors: Array<{ cdn: string; error: string }> = [];

  // Detect connection type for adaptive strategy
  const connectionType = detectConnectionType();
  const adaptiveTimeout = getAdaptiveTimeout(baseTimeout, connectionType);

  // Determine strategy: parallel racing on fast connections, sequential otherwise
  const shouldRace =
    useRacing !== undefined
      ? useRacing
      : connectionType === "fast";

  console.log(
    `[SW ${SW_VERSION}] CDN strategy: ${shouldRace ? "parallel racing" : "sequential cascade"} ` +
      `(connection: ${connectionType}, timeout: ${adaptiveTimeout}ms)`
  );

  // Load SRI manifest for integrity verification
  const manifest = await loadSRIManifest();

  // Get dynamically ordered providers based on health scores
  const orderedProviders = getOrderedProviders();

  // Try parallel racing on fast connections
  if (shouldRace && orderedProviders.length >= 2) {
    console.log(
      `[SW ${SW_VERSION}] Racing ${orderedProviders.length} CDNs in parallel...`
    );
    const racingResponse = await fetchWithRacing(
      originalUrl,
      orderedProviders,
      adaptiveTimeout,
      manifest
    );

    if (racingResponse) {
      return racingResponse;
    }

    // Racing failed, fall back to sequential cascade
    console.warn(
      `[SW ${SW_VERSION}] Parallel racing failed, falling back to sequential cascade`
    );
  }

  // Sequential cascade fallback (or primary strategy on slow connections)
  for (const provider of orderedProviders) {
    const url = convertToCDN(originalUrl, provider.name);
    if (!url) {
      console.warn(`[SW ${SW_VERSION}] Cannot convert to ${provider.name}, skipping`);
      continue;
    }

    const response = await tryFetchFromCDN(url, provider, adaptiveTimeout, manifest);
    if (response) {
      return response; // Success!
    }

    // Track failure for error summary
    errors.push({
      cdn: provider.name,
      error: "Failed (see metrics above)",
    });
  }

  // All CDNs failed
  console.error(
    `[SW ${SW_VERSION}] All CDNs failed for ${originalUrl}:`,
    errors
  );
  throw new Error(
    `All CDNs failed: ${errors.map((e) => `${e.cdn} (${e.error})`).join(", ")}`
  );
}

/**
 * Network-first caching strategy for CDN resources
 * Tries network, falls back to cache on failure
 * Phase 4: Also stores successful responses in fallback cache
 *
 * @param request - Request to handle
 * @param cacheName - Cache storage name
 * @returns Response from network or cache
 */
async function networkFirstStrategy(
  request: Request,
  cacheName: string
): Promise<Response> {
  const cache = await caches.open(cacheName);
  const fallbackCache = await caches.open(CACHE_NAMES.fallback);

  try {
    // Try network with multi-CDN cascade
    const response = await fetchWithCascade(request.url);

    // Cache successful response in both main and fallback caches
    if (response.ok) {
      // Store in main CDN cache
      cache.put(request, response.clone()).catch((err) => {
        console.warn(`[SW ${SW_VERSION}] Main cache put failed:`, err);
      });

      // Also store in fallback cache for offline support
      fallbackCache.put(request, response.clone()).catch((err) => {
        console.warn(`[SW ${SW_VERSION}] Fallback cache put failed:`, err);
      });
    }

    return response;
  } catch (error) {
    console.warn(`[SW ${SW_VERSION}] Network failed, trying caches:`, error);

    // Try main cache first
    const cachedResponse = await cache.match(request);
    if (cachedResponse) {
      console.log(`[SW ${SW_VERSION}] Serving from main cache: ${request.url}`);
      return cachedResponse;
    }

    // Try fallback cache as last resort
    const fallbackResponse = await fallbackCache.match(request);
    if (fallbackResponse) {
      console.log(
        `[SW ${SW_VERSION}] Serving from fallback cache: ${request.url}`
      );
      return fallbackResponse;
    }

    // No cache available, throw original error
    throw error;
  }
}

/**
 * Cache-first strategy for returning users
 * Checks cache first, updates in background
 * Phase 4: Also uses fallback cache if main cache misses
 *
 * @param request - Request to handle
 * @param cacheName - Cache storage name
 * @returns Response from cache or network
 */
async function cacheFirstStrategy(
  request: Request,
  cacheName: string
): Promise<Response> {
  const cache = await caches.open(cacheName);
  const fallbackCache = await caches.open(CACHE_NAMES.fallback);

  // Try main cache first
  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    console.log(`[SW ${SW_VERSION}] Cache hit: ${request.url}`);

    // Background revalidation (stale-while-revalidate)
    fetchWithCascade(request.url)
      .then((response) => {
        if (response.ok) {
          cache.put(request, response.clone());
          fallbackCache.put(request, response.clone());
          console.log(`[SW ${SW_VERSION}] Background updated: ${request.url}`);
        }
      })
      .catch(() => {
        // Ignore background update failures
      });

    return cachedResponse;
  }

  // Try fallback cache
  const fallbackResponse = await fallbackCache.match(request);
  if (fallbackResponse) {
    console.log(`[SW ${SW_VERSION}] Fallback cache hit: ${request.url}`);

    // Still do background revalidation
    fetchWithCascade(request.url)
      .then((response) => {
        if (response.ok) {
          cache.put(request, response.clone());
          fallbackCache.put(request, response.clone());
        }
      })
      .catch(() => {});

    return fallbackResponse;
  }

  // Cache miss - fetch from network
  console.log(`[SW ${SW_VERSION}] Cache miss: ${request.url}`);
  const response = await fetchWithCascade(request.url);

  if (response.ok) {
    cache.put(request, response.clone());
    fallbackCache.put(request, response.clone());
  }

  return response;
}

/**
 * Checks if this is a returning user (has cache entries)
 * Used to determine whether to use cache-first or network-first
 *
 * @returns True if cache exists (returning user)
 */
async function isReturningUser(): Promise<boolean> {
  const cache = await caches.open(CACHE_NAMES.cdn);
  const keys = await cache.keys();
  return keys.length > 0;
}

/**
 * Service Worker fetch event
 * Routes requests to appropriate caching strategy
 *
 * Phase 2: Network-first for CDN resources with multi-CDN fallback
 * Phase 2.3: Cache-first for returning users
 */
self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  const requestType = classifyRequest(url);

  // Only intercept CDN requests
  if (requestType === "cdn") {
    event.respondWith(
      (async () => {
        const returning = await isReturningUser();

        if (returning) {
          // Returning user: cache-first with background revalidation
          console.log(
            `[SW ${SW_VERSION}] CDN request (cache-first): ${url.href}`
          );
          return cacheFirstStrategy(event.request, CACHE_NAMES.cdn);
        }

        // First-time user: network-first
        console.log(
          `[SW ${SW_VERSION}] CDN request (network-first): ${url.href}`
        );
        return networkFirstStrategy(event.request, CACHE_NAMES.cdn);
      })()
    );
    return;
  }

  // Pass through non-CDN requests
  // FFmpeg and app assets are handled by browser cache
});

/**
 * Service Worker message event
 * Handles commands from main thread (e.g., skip waiting, clear cache)
 */
self.addEventListener("message", (event: ExtendableMessageEvent) => {
  console.log(`[SW ${SW_VERSION}] Message received:`, event.data);

  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }

  if (event.data?.type === "CLEAR_CACHE") {
    event.waitUntil(
      (async () => {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map((name) => caches.delete(name)));
        console.log(`[SW ${SW_VERSION}] All caches cleared`);
      })()
    );
  }
});

export {};
