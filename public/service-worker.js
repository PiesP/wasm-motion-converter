// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Service Worker — DropConvert
 *
 * Caching strategy:
 * - Static assets (/assets/*): cache-first, network fallback with background cache update
 * - Application navigation: network-first, verified application document fallback
 * - Video files (.webm, .mp4): network-only (never cache — too large for SW cache)
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers
 */

/// <reference lib="webworker" />

const CACHE_PREFIX = 'dropconvert';
// Bump on cache-policy changes so activation removes old application caches.
const CACHE_VERSION = 'v20261008-documents';
const STATIC_CACHE = `${CACHE_PREFIX}-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `${CACHE_PREFIX}-dynamic-${CACHE_VERSION}`;
const DYNAMIC_CACHE_MAX_ENTRIES = 64;
const NAVIGATION_CACHE_KEY = new URL('/', self.location.origin).href;

/**
 * Core assets to precache on install.
 * Only non-hashed entry points — hashed /assets/* files are handled
 * by the runtime cache-first strategy in the fetch handler.
 */
const PRECACHE_URLS = ['/', '/icon.svg', '/robots.txt', '/sitemap.xml'];

// ── Helpers ───────────────────────────────────────────────

/**
 * Returns true if the URL points to a hashed static asset (/assets/*).
 */
function isStaticAsset(url) {
  return url.pathname.startsWith('/assets/');
}

/**
 * Returns true if the URL is a video test file (.webm, .mp4).
 * Video files are never cached by the service worker.
 */
function isVideoFile(url) {
  const ext = url.pathname.toLowerCase();
  return ext.endsWith('.webm') || ext.endsWith('.mp4');
}

function getStaticAssetCacheKey(url) {
  return new URL(url.pathname, self.location.origin).href;
}

// The application has one document and no client-side route tree. Query
// parameters do not change the recovery document; other paths must retain
// their own content instead of becoming the canonical offline shell.
function isAppDocumentUrl(url) {
  return (
    url.origin === self.location.origin && (url.pathname === '/' || url.pathname === '/index.html')
  );
}

function isAppDocumentResponse(response) {
  if (response?.status !== 200 || response.type === 'opaque' || response.type === 'opaqueredirect')
    return false;
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'text/html') return false;
  try {
    return isAppDocumentUrl(new URL(response.url));
  } catch {
    return false;
  }
}

async function getRecoveryDocument() {
  for (const cacheName of [DYNAMIC_CACHE, STATIC_CACHE]) {
    const cached = await caches.match(NAVIGATION_CACHE_KEY, { cacheName });
    if (isAppDocumentResponse(cached)) return cached;
    if (cached) {
      const cache = await caches.open(cacheName);
      await cache.delete(NAVIGATION_CACHE_KEY);
    }
  }
  return undefined;
}

/**
 * Store a response in the dynamic cache.
 */
async function putInCache(request, response) {
  const cache = await caches.open(DYNAMIC_CACHE);
  await cache.put(request, response);
  const keys = await cache.keys();
  // The navigation document is a recovery anchor and must not be evicted by
  // the asset FIFO. It is budgeted separately from runtime asset entries.
  const evictableKeys = keys.filter((key) => {
    const cacheKey = typeof key === 'string' ? key : key.url;
    return cacheKey !== NAVIGATION_CACHE_KEY;
  });
  const overflow = evictableKeys.length - DYNAMIC_CACHE_MAX_ENTRIES;
  if (overflow > 0) {
    await Promise.all(evictableKeys.slice(0, overflow).map((key) => cache.delete(key)));
  }
}

// ── Install ───────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate ──────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key.startsWith(CACHE_PREFIX) && key !== STATIC_CACHE && key !== DYNAMIC_CACHE
            )
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Video files: network-only, never cache
  if (isVideoFile(url)) {
    event.respondWith(fetch(request));
    return;
  }

  // Static assets: cache-first, network fallback, background update
  if (url.origin === self.location.origin && isStaticAsset(url)) {
    const cacheKey = getStaticAssetCacheKey(url);
    event.respondWith(
      caches.match(cacheKey).then((cached) => {
        const fetchPromise = fetch(request)
          .then((response) => {
            if (response.ok) {
              event.waitUntil(putInCache(cacheKey, response.clone()));
            }
            return response;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  const documentCacheKey =
    request.mode === 'navigate' && request.destination === 'document' && isAppDocumentUrl(url)
      ? NAVIGATION_CACHE_KEY
      : null;

  // Everything else (HTML navigations, API calls): network-first, cache fallback
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (documentCacheKey && isAppDocumentResponse(response)) {
          event.waitUntil(putInCache(documentCacheKey, response.clone()));
        }
        return response;
      })
      .catch(async (error) => {
        const cached = documentCacheKey ? await getRecoveryDocument() : await caches.match(request);
        if (cached) return cached;
        throw error;
      })
  );
});
