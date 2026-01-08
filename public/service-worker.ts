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
const SW_VERSION = 'v1.0.0';

/**
 * Cache name prefix for versioning
 */
const CACHE_VERSION = 'v1';

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
  'esm.sh',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdn.skypack.dev',
] as const;

/**
 * Request type classification for routing strategy
 */
type RequestType = 'cdn' | 'ffmpeg' | 'app' | 'ignore';

/**
 * Classifies request for appropriate caching strategy
 *
 * @param url - Request URL to classify
 * @returns Request type for routing decision
 */
function classifyRequest(url: URL): RequestType {
  // CDN resources (dependencies loaded from external CDNs)
  if (CDN_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
    return 'cdn';
  }

  // FFmpeg core assets (preserve existing caching pattern)
  if (url.pathname.includes('@ffmpeg/core')) {
    return 'ffmpeg';
  }

  // App bundles (Vite-generated assets)
  if (url.pathname.startsWith('/assets/')) {
    return 'app';
  }

  // Pass through (HTML, other static assets)
  return 'ignore';
}

/**
 * Service Worker install event
 * Activates immediately without waiting for existing clients
 */
self.addEventListener('install', (event: ExtendableEvent) => {
  console.log(`[SW ${SW_VERSION}] Installing...`);

  // Skip waiting to activate immediately (aggressive update strategy)
  self.skipWaiting();

  // Phase 1: No pre-caching yet
  // Phase 4 will add fallback bundle pre-caching here
  event.waitUntil(Promise.resolve());
});

/**
 * Service Worker activate event
 * Cleans up old caches and takes control immediately
 */
self.addEventListener('activate', (event: ExtendableEvent) => {
  console.log(`[SW ${SW_VERSION}] Activating...`);

  event.waitUntil(
    (async () => {
      // Clean up old cache versions
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames.map(cacheName => {
          if (!ALL_CACHE_NAMES.includes(cacheName)) {
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
 * Service Worker fetch event
 * Routes requests to appropriate caching strategy
 *
 * Phase 1: Pass-through only (no caching)
 * Phase 2: Will add network-first for CDN resources
 * Phase 2.3: Will add cache-first for returning users
 */
self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  const requestType = classifyRequest(url);

  // Phase 1: Log classification but pass through all requests
  // Caching logic will be added in Phase 2
  if (requestType === 'cdn') {
    console.log(`[SW ${SW_VERSION}] CDN request (pass-through): ${url.href}`);
  }

  // Phase 1: No interception, all requests pass through
  // This ensures SW registration doesn't break existing functionality
});

/**
 * Service Worker message event
 * Handles commands from main thread (e.g., skip waiting, clear cache)
 */
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  console.log(`[SW ${SW_VERSION}] Message received:`, event.data);

  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data?.type === 'CLEAR_CACHE') {
    event.waitUntil(
      (async () => {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(name => caches.delete(name)));
        console.log(`[SW ${SW_VERSION}] All caches cleared`);
      })()
    );
  }
});

export {};
