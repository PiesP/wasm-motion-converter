// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Service Worker — DropConvert
 *
 * Fingerprinted assets are cache-first; the application document is
 * network-first with a separately protected offline recovery copy.
 */

/// <reference lib="webworker" />

const CACHE_PREFIX = 'dropconvert';
// Keep the cache name stable: an updated worker must not discard assets used by open tabs.
const CACHE_VERSION = 'v20261008-documents';
const STATIC_CACHE = `${CACHE_PREFIX}-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `${CACHE_PREFIX}-dynamic-${CACHE_VERSION}`;
const DYNAMIC_CACHE_MAX_ENTRIES = 64;
const NAVIGATION_CACHE_KEY = new URL('/', self.location.origin).href;
const PRECACHE_URLS = ['/', '/icon.svg', '/robots.txt', '/sitemap.xml'];
const ASSET_ADMISSION_VERSION = 'body-checked-v1';
const ASSET_ADMISSION_HEADER = 'x-dropconvert-asset-admission';
const ASSET_SOURCE_HEADER = 'x-dropconvert-asset-source';

function isStaticAsset(url) {
  return url.pathname.startsWith('/assets/');
}

function isVideoFile(url) {
  const path = url.pathname.toLowerCase();
  return path.endsWith('.webm') || path.endsWith('.mp4');
}

function getStaticAssetCacheKey(url) {
  return new URL(url.pathname, self.location.origin).href;
}

function assetKind(url) {
  // Vite emits a content hash before the extension. Other /assets/ URLs are
  // never treated as immutable application assets.
  if (!/[.-][a-zA-Z0-9_-]{8}\.(?:js|css|wasm)$/.test(url.pathname)) return null;
  return url.pathname.slice(url.pathname.lastIndexOf('.') + 1);
}

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
    try {
      const cache = await caches.open(cacheName);
      const cached = await cache.match(NAVIGATION_CACHE_KEY);
      if (isAppDocumentResponse(cached)) return cached;
      if (cached) await cache.delete(NAVIGATION_CACHE_KEY);
    } catch {
      // Offline recovery is best effort when CacheStorage is unavailable.
    }
  }
  return undefined;
}

async function putInCache(key, response) {
  try {
    const cache = await caches.open(DYNAMIC_CACHE);
    await cache.put(key, response);
    if (key === NAVIGATION_CACHE_KEY) return;
    const keys = await cache.keys();
    const assets = keys.filter(
      (entry) => (typeof entry === 'string' ? entry : entry.url) !== NAVIGATION_CACHE_KEY
    );
    await Promise.all(
      assets
        .slice(0, Math.max(0, assets.length - DYNAMIC_CACHE_MAX_ENTRIES))
        .map((entry) => cache.delete(entry))
    );
  } catch {
    // Quota, private browsing, or disabled storage must not block a response.
  }
}

function assetHeadersValid(response, key, kind, admitted = false) {
  if (
    response?.status !== 200 ||
    !['basic', 'default'].includes(response.type) ||
    response.redirected
  )
    return false;
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (
    (kind === 'js' &&
      ![
        'text/javascript',
        'application/javascript',
        'text/ecmascript',
        'application/ecmascript',
      ].includes(mime)) ||
    (kind === 'css' && mime !== 'text/css') ||
    (kind === 'wasm' && mime !== 'application/wasm')
  )
    return false;
  if (admitted) {
    return (
      response.headers.get(ASSET_ADMISSION_HEADER) === ASSET_ADMISSION_VERSION &&
      response.headers.get(ASSET_SOURCE_HEADER) === key &&
      response.url === ''
    );
  }
  try {
    const finalUrl = new URL(response.url);
    return finalUrl.origin === self.location.origin && getStaticAssetCacheKey(finalUrl) === key;
  } catch {
    return false;
  }
}

async function assetBodyValid(response, kind) {
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  const sample = new Uint8Array(512);
  let count = 0;
  try {
    while (count < sample.length) {
      const { done, value } = await reader.read();
      if (done) break;
      const copied = Math.min(value.length, sample.length - count);
      sample.set(value.subarray(0, copied), count);
      count += copied;
    }
  } catch {
    return false;
  } finally {
    void reader.cancel().catch(() => {});
  }
  if (kind === 'wasm')
    return (
      count >= 4 && sample[0] === 0 && sample[1] === 97 && sample[2] === 115 && sample[3] === 109
    );
  if (count === 0) return false;
  const prefix = new TextDecoder().decode(sample.subarray(0, count)).trimStart();
  return !prefix.startsWith('<') && !prefix.includes('\0');
}

async function validAsset(response, key, kind) {
  return assetHeadersValid(response, key, kind) && (await assetBodyValid(response, kind));
}

function admittedResponse(response, key) {
  const headers = new Headers(response.headers);
  // Fetch exposes a decoded body; its original transfer headers cannot be
  // replayed on a synthetic Response without corrupting the decoded bytes.
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.delete('transfer-encoding');
  headers.set(ASSET_ADMISSION_HEADER, ASSET_ADMISSION_VERSION);
  headers.set(ASSET_SOURCE_HEADER, key);
  return new Response(response.clone().body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function matchAsset(cacheName, key, kind) {
  if (!cacheName) return undefined;
  try {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(key);
    if (!cached) return undefined;
    if (assetHeadersValid(cached, key, kind, true)) return cached;
    if (await validAsset(cached, key, kind)) {
      // A cache created by an older worker needs one body check. Admission is
      // persisted so later worker wakes can serve it without reading the body.
      try {
        await cache.put(key, admittedResponse(cached, key));
      } catch {
        /* Best effort. */
      }
      return cached;
    }
    await cache.delete(key);
  } catch {
    // Fall through to the network if storage or validation fails.
  }
  return undefined;
}

async function notifyAssetUnavailable(event, url, status, reason) {
  try {
    const client = event.clientId && (await self.clients.get(event.clientId));
    client?.postMessage({
      type: 'dropconvert:asset-unavailable',
      path: url.pathname,
      status,
      reason,
    });
  } catch {
    // The client may have closed before the failure was observed.
  }
}

async function getAsset(event, request, url, key, kind) {
  const cached = await matchAsset(DYNAMIC_CACHE, key, kind);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (!(await validAsset(response, key, kind))) {
      await notifyAssetUnavailable(event, url, response.status, 'invalid-response');
      return Response.error();
    }
    try {
      await putInCache(key, admittedResponse(response, key));
    } catch {
      // Cache admission failure must not turn a valid network response into an error.
    }
    return response;
  } catch (error) {
    await notifyAssetUnavailable(event, url, 0, 'network-error');
    throw error;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const names = await caches.keys();
        for (const name of names) {
          if (
            !name.startsWith(`${CACHE_PREFIX}-static-`) &&
            !name.startsWith(`${CACHE_PREFIX}-dynamic-`)
          )
            continue;
          if (name !== STATIC_CACHE && name !== DYNAMIC_CACHE) await caches.delete(name);
        }
      } catch {
        // Activation must survive storage failures.
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;
  if (isVideoFile(url)) {
    event.respondWith(fetch(request));
    return;
  }

  if (url.origin === self.location.origin && isStaticAsset(url)) {
    const kind = assetKind(url);
    if (!kind) return;
    const expectedDestination = {
      js: ['script', 'worker', 'sharedworker', ''],
      css: ['style', ''],
      wasm: [''],
    }[kind];
    if (!expectedDestination.includes(request.destination)) return;
    const key = getStaticAssetCacheKey(url);
    // Register the complete fetch/cache work while the event is live.
    const work = getAsset(event, request, url, key, kind);
    event.respondWith(work);
    event.waitUntil(work.catch(() => {}));
    return;
  }

  const documentCacheKey =
    request.mode === 'navigate' && request.destination === 'document' && isAppDocumentUrl(url)
      ? NAVIGATION_CACHE_KEY
      : null;
  const work = fetch(request)
    .then(async (response) => {
      if (documentCacheKey && isAppDocumentResponse(response)) {
        await putInCache(documentCacheKey, response.clone());
      }
      return response;
    })
    .catch(async (error) => {
      const cached = documentCacheKey ? await getRecoveryDocument() : undefined;
      if (cached) return cached;
      throw error;
    });
  event.respondWith(work);
  event.waitUntil(work.catch(() => {}));
});
