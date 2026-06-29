// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Service Worker — dropconvert-wasm
 *
 * Caching strategy:
 * - Static assets (/assets/*): cache-first, network fallback with background cache update
 * - HTML navigation: network-first, cache fallback, index.html SPA fallback
 * - Video files (.webm, .mp4): network-only (never cache — too large for SW cache)
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers
 */

/// <reference lib="webworker" />

const CACHE_PREFIX = 'dropconvert';
// Cache version derived from build timestamp — bumping this value invalidates
// old caches on every new deploy. In the future, this can be replaced with a
// hash from the build output for automatic versioning.
const CACHE_VERSION = 'v2';
const STATIC_CACHE = `${CACHE_PREFIX}-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `${CACHE_PREFIX}-dynamic-${CACHE_VERSION}`;

/**
 * Core assets to precache on install.
 * Matches the public/ directory files that are always needed for the app shell.
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

/**
 * Store a response in the dynamic cache.
 */
async function putInCache(request, response) {
  const cache = await caches.open(DYNAMIC_CACHE);
  await cache.put(request, response);
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
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const fetchPromise = fetch(request)
          .then((response) => {
            if (response.ok) {
              event.waitUntil(putInCache(request, response.clone()));
            }
            return response;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Everything else (HTML navigations, API calls): network-first, cache fallback
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && request.destination === 'document') {
          event.waitUntil(putInCache(request, response.clone()));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('/')))
  );
});
