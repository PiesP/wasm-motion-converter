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
 * CDN domains to intercept and cache
 */
const CDN_DOMAINS = [
  "esm.sh",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "cdn.skypack.dev",
] as const;

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
 * Fetches from CDN with multi-provider cascade fallback and SRI verification
 * Tries esm.sh → jsdelivr → unpkg → skypack in order
 * Verifies integrity of each response before returning
 * Logs performance metrics for each attempt
 *
 * @param originalUrl - Original CDN URL
 * @param timeout - Timeout per CDN attempt (default: 15s)
 * @returns Response from successful CDN with valid integrity or throws if all fail
 */
async function fetchWithCascade(
  originalUrl: string,
  timeout = 15000
): Promise<Response> {
  const errors: Array<{ cdn: string; error: string }> = [];

  // Load SRI manifest for integrity verification
  const manifest = await loadSRIManifest();

  // Try original URL (esm.sh)
  const startTime = performance.now();
  try {
    console.log(`[SW ${SW_VERSION}] Trying esm.sh: ${originalUrl}`);
    const response = await fetchWithTimeout(new Request(originalUrl), timeout);
    const latency = performance.now() - startTime;

    if (response.ok) {
      // Verify integrity if manifest is available
      if (manifest) {
        const expectedIntegrity = getExpectedIntegrity(originalUrl, manifest);
        if (expectedIntegrity) {
          const isValid = await verifyIntegrity(response, expectedIntegrity);
          if (!isValid) {
            console.error(
              `[SW ${SW_VERSION}] ✗ Integrity verification failed for esm.sh, trying next CDN`
            );
            logCDNMetrics({
              url: originalUrl,
              cdnName: "esm.sh",
              latency,
              success: false,
              status: response.status,
              error: "Integrity verification failed",
              timestamp: Date.now(),
            });
            errors.push({ cdn: "esm.sh", error: "Integrity verification failed" });
            // Continue to next CDN instead of returning
          } else {
            console.log(`[SW ${SW_VERSION}] ✓ Integrity verified for esm.sh`);
            logCDNMetrics({
              url: originalUrl,
              cdnName: "esm.sh",
              latency,
              success: true,
              status: response.status,
              timestamp: Date.now(),
            });
            return response;
          }
        } else {
          // No SRI hash found, proceed without verification (warn but don't fail)
          console.warn(
            `[SW ${SW_VERSION}] ⚠ No SRI hash found for ${originalUrl}, proceeding without verification`
          );
          logCDNMetrics({
            url: originalUrl,
            cdnName: "esm.sh",
            latency,
            success: true,
            status: response.status,
            timestamp: Date.now(),
          });
          return response;
        }
      } else {
        // Manifest not available, proceed without verification
        console.warn(
          `[SW ${SW_VERSION}] ⚠ SRI manifest not loaded, proceeding without verification`
        );
        logCDNMetrics({
          url: originalUrl,
          cdnName: "esm.sh",
          latency,
          success: true,
          status: response.status,
          timestamp: Date.now(),
        });
        return response;
      }
    }

    logCDNMetrics({
      url: originalUrl,
      cdnName: "esm.sh",
      latency,
      success: false,
      status: response.status,
      error: `HTTP ${response.status}`,
      timestamp: Date.now(),
    });
    errors.push({ cdn: "esm.sh", error: `HTTP ${response.status}` });
  } catch (error) {
    const latency = performance.now() - startTime;
    logCDNMetrics({
      url: originalUrl,
      cdnName: "esm.sh",
      latency,
      success: false,
      error: String(error),
      timestamp: Date.now(),
    });
    errors.push({ cdn: "esm.sh", error: String(error) });
  }

  // Try jsdelivr
  const jsdelivrUrl = CDN_CONVERTERS.esmToJsdelivr(originalUrl);
  if (jsdelivrUrl) {
    const jsdelivrStart = performance.now();
    try {
      console.log(`[SW ${SW_VERSION}] Trying jsdelivr: ${jsdelivrUrl}`);
      const response = await fetchWithTimeout(
        new Request(jsdelivrUrl),
        timeout
      );
      const latency = performance.now() - jsdelivrStart;

      if (response.ok) {
        // Verify integrity if manifest is available
        if (manifest) {
          const expectedIntegrity = getExpectedIntegrity(jsdelivrUrl, manifest);
          if (expectedIntegrity) {
            const isValid = await verifyIntegrity(response, expectedIntegrity);
            if (!isValid) {
              console.error(
                `[SW ${SW_VERSION}] ✗ Integrity verification failed for jsdelivr, trying next CDN`
              );
              logCDNMetrics({
                url: jsdelivrUrl,
                cdnName: "jsdelivr",
                latency,
                success: false,
                status: response.status,
                error: "Integrity verification failed",
                timestamp: Date.now(),
              });
              errors.push({ cdn: "jsdelivr", error: "Integrity verification failed" });
              // Continue to next CDN
            } else {
              console.log(`[SW ${SW_VERSION}] ✓ Integrity verified for jsdelivr`);
              logCDNMetrics({
                url: jsdelivrUrl,
                cdnName: "jsdelivr",
                latency,
                success: true,
                status: response.status,
                timestamp: Date.now(),
              });
              return response;
            }
          } else {
            console.warn(
              `[SW ${SW_VERSION}] ⚠ No SRI hash found for ${jsdelivrUrl}, proceeding without verification`
            );
            logCDNMetrics({
              url: jsdelivrUrl,
              cdnName: "jsdelivr",
              latency,
              success: true,
              status: response.status,
              timestamp: Date.now(),
            });
            return response;
          }
        } else {
          logCDNMetrics({
            url: jsdelivrUrl,
            cdnName: "jsdelivr",
            latency,
            success: true,
            status: response.status,
            timestamp: Date.now(),
          });
          return response;
        }
      }

      logCDNMetrics({
        url: jsdelivrUrl,
        cdnName: "jsdelivr",
        latency,
        success: false,
        status: response.status,
        error: `HTTP ${response.status}`,
        timestamp: Date.now(),
      });
      errors.push({ cdn: "jsdelivr", error: `HTTP ${response.status}` });
    } catch (error) {
      const latency = performance.now() - jsdelivrStart;
      logCDNMetrics({
        url: jsdelivrUrl,
        cdnName: "jsdelivr",
        latency,
        success: false,
        error: String(error),
        timestamp: Date.now(),
      });
      errors.push({ cdn: "jsdelivr", error: String(error) });
    }
  }

  // Try unpkg
  const unpkgUrl = CDN_CONVERTERS.esmToUnpkg(originalUrl);
  if (unpkgUrl) {
    const unpkgStart = performance.now();
    try {
      console.log(`[SW ${SW_VERSION}] Trying unpkg: ${unpkgUrl}`);
      const response = await fetchWithTimeout(new Request(unpkgUrl), timeout);
      const latency = performance.now() - unpkgStart;

      if (response.ok) {
        // Verify integrity if manifest is available
        if (manifest) {
          const expectedIntegrity = getExpectedIntegrity(unpkgUrl, manifest);
          if (expectedIntegrity) {
            const isValid = await verifyIntegrity(response, expectedIntegrity);
            if (!isValid) {
              console.error(
                `[SW ${SW_VERSION}] ✗ Integrity verification failed for unpkg, trying next CDN`
              );
              logCDNMetrics({
                url: unpkgUrl,
                cdnName: "unpkg",
                latency,
                success: false,
                status: response.status,
                error: "Integrity verification failed",
                timestamp: Date.now(),
              });
              errors.push({ cdn: "unpkg", error: "Integrity verification failed" });
              // Continue to next CDN
            } else {
              console.log(`[SW ${SW_VERSION}] ✓ Integrity verified for unpkg`);
              logCDNMetrics({
                url: unpkgUrl,
                cdnName: "unpkg",
                latency,
                success: true,
                status: response.status,
                timestamp: Date.now(),
              });
              return response;
            }
          } else {
            console.warn(
              `[SW ${SW_VERSION}] ⚠ No SRI hash found for ${unpkgUrl}, proceeding without verification`
            );
            logCDNMetrics({
              url: unpkgUrl,
              cdnName: "unpkg",
              latency,
              success: true,
              status: response.status,
              timestamp: Date.now(),
            });
            return response;
          }
        } else {
          logCDNMetrics({
            url: unpkgUrl,
            cdnName: "unpkg",
            latency,
            success: true,
            status: response.status,
            timestamp: Date.now(),
          });
          return response;
        }
      }

      logCDNMetrics({
        url: unpkgUrl,
        cdnName: "unpkg",
        latency,
        success: false,
        status: response.status,
        error: `HTTP ${response.status}`,
        timestamp: Date.now(),
      });
      errors.push({ cdn: "unpkg", error: `HTTP ${response.status}` });
    } catch (error) {
      const latency = performance.now() - unpkgStart;
      logCDNMetrics({
        url: unpkgUrl,
        cdnName: "unpkg",
        latency,
        success: false,
        error: String(error),
        timestamp: Date.now(),
      });
      errors.push({ cdn: "unpkg", error: String(error) });
    }
  }

  // Try skypack
  const skypackUrl = CDN_CONVERTERS.esmToSkypack(originalUrl);
  if (skypackUrl) {
    const skypackStart = performance.now();
    try {
      console.log(`[SW ${SW_VERSION}] Trying skypack: ${skypackUrl}`);
      const response = await fetchWithTimeout(new Request(skypackUrl), timeout);
      const latency = performance.now() - skypackStart;

      if (response.ok) {
        // Verify integrity if manifest is available
        if (manifest) {
          const expectedIntegrity = getExpectedIntegrity(skypackUrl, manifest);
          if (expectedIntegrity) {
            const isValid = await verifyIntegrity(response, expectedIntegrity);
            if (!isValid) {
              console.error(
                `[SW ${SW_VERSION}] ✗ Integrity verification failed for skypack, trying next CDN`
              );
              logCDNMetrics({
                url: skypackUrl,
                cdnName: "skypack",
                latency,
                success: false,
                status: response.status,
                error: "Integrity verification failed",
                timestamp: Date.now(),
              });
              errors.push({ cdn: "skypack", error: "Integrity verification failed" });
              // Continue to next CDN
            } else {
              console.log(`[SW ${SW_VERSION}] ✓ Integrity verified for skypack`);
              logCDNMetrics({
                url: skypackUrl,
                cdnName: "skypack",
                latency,
                success: true,
                status: response.status,
                timestamp: Date.now(),
              });
              return response;
            }
          } else {
            console.warn(
              `[SW ${SW_VERSION}] ⚠ No SRI hash found for ${skypackUrl}, proceeding without verification`
            );
            logCDNMetrics({
              url: skypackUrl,
              cdnName: "skypack",
              latency,
              success: true,
              status: response.status,
              timestamp: Date.now(),
            });
            return response;
          }
        } else {
          logCDNMetrics({
            url: skypackUrl,
            cdnName: "skypack",
            latency,
            success: true,
            status: response.status,
            timestamp: Date.now(),
          });
          return response;
        }
      }

      logCDNMetrics({
        url: skypackUrl,
        cdnName: "skypack",
        latency,
        success: false,
        status: response.status,
        error: `HTTP ${response.status}`,
        timestamp: Date.now(),
      });
      errors.push({ cdn: "skypack", error: `HTTP ${response.status}` });
    } catch (error) {
      const latency = performance.now() - skypackStart;
      logCDNMetrics({
        url: skypackUrl,
        cdnName: "skypack",
        latency,
        success: false,
        error: String(error),
        timestamp: Date.now(),
      });
      errors.push({ cdn: "skypack", error: String(error) });
    }
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
