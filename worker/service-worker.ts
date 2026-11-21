// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

const workerScope = self as unknown as ServiceWorkerGlobalScope;

type AssetKind = 'js' | 'css' | 'wasm';

const CACHE_PREFIX = 'dropconvert';
// Keep the cache name stable: an updated worker must not discard assets used by open tabs.
const CACHE_VERSION = 'v20261008-documents';
const STATIC_CACHE = `${CACHE_PREFIX}-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `${CACHE_PREFIX}-dynamic-${CACHE_VERSION}`;
const DYNAMIC_CACHE_MAX_ENTRIES = 64;
const NAVIGATION_CACHE_KEY = new URL('/', workerScope.location.origin).href;
const PRECACHE_URLS = ['/icon.svg', '/robots.txt', '/sitemap.xml'];
const STAGED_DOCUMENT = new URL(
  `/.dropconvert-staged-document/${__APP_SOURCE_SHA__}`,
  workerScope.location.origin
).href;
const RETIREMENT_CACHE = 'dropconvert-retire-7d9e0f1b';
const RETIREMENT_KEY = new URL('/.dropconvert-retirement', workerScope.location.origin).href;
const MAX_CLIENTS = 128;
const ARCHIVED_WORKER = '/assets/worker-BG8LzI1q.js';
const ARCHIVED_DOCUMENT = {
  size: 2038,
  sha256: '585b4beb0171e03c1bbff5b4da8f1600f2b94979969101c8af59927a84362c9f',
};
type BodyPin = { size: number; sha256: string };
type AssetPin = BodyPin & { path: string };
type RetirementState = { phase: 'grace' | 'closed'; old: string[]; current: string[] };
declare const __APP_SOURCE_SHA__: string | null;
declare const __DROP_CONVERT_SHELL__: {
  document: AssetPin;
  eager: AssetPin[];
  predecessorOnly: string[];
  predecessorShared: string[];
};
const shellManifest = __DROP_CONVERT_SHELL__;
const eagerPaths = new Set(shellManifest.eager.map(({ path }) => path));
const predecessorPaths = new Set(shellManifest.predecessorOnly);
const sharedPaths = new Set(shellManifest.predecessorShared);
const lookupRetired = (() => {
  const rows = [
    [
      '/assets/wasm-webp.Wg4Zhl1L.js',
      51996,
      '591bd59ee5da2104693bf7e5bec2b8c1dc85527d3ca21d7b05231c2b1c25499b',
    ],
    [
      '/assets/webp-wasm-BqUWQtOZ.js',
      52286,
      '15cd582651f78831babe9b54012388f22614c48b39c899fa2772e62b037dae47',
    ],
    [
      '/assets/webp-wasm-DhoM6Y9t.wasm',
      482273,
      '4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22',
    ],
    [
      '/assets/__vite-browser-external-Cz17a1zo.js',
      112,
      '41bec85a9923dc9b6d96dde6cbdb5897cc9130d649f3310d6b92fa5dd8f30280',
    ],
  ] as const;
  return (pathname: string) => {
    const row = rows.find(([path]) => path === pathname);
    return row && { size: row[1], sha256: row[2] };
  };
})();
let pendingWork: Promise<void> = Promise.resolve();

const ASSET_ADMISSION_VERSION = 'body-checked-v1';
const ASSET_ADMISSION_HEADER = 'x-dropconvert-asset-admission';
const ASSET_SOURCE_HEADER = 'x-dropconvert-asset-source';

function isStaticAsset(url: URL) {
  return url.pathname.startsWith('/assets/');
}

function isVideoFile(url: URL) {
  const path = url.pathname.toLowerCase();
  return path.endsWith('.webm') || path.endsWith('.mp4');
}

function getStaticAssetCacheKey(url: URL) {
  return new URL(url.pathname, workerScope.location.origin).href;
}

function assetKind(url: URL): 'js' | 'css' | 'wasm' | null {
  // Vite emits a content hash before the extension. Other /assets/ URLs are
  // never treated as immutable application assets.
  if (!/[.-][a-zA-Z0-9_-]{8}\.(?:js|css|wasm)$/.test(url.pathname)) return null;
  const extension = url.pathname.slice(url.pathname.lastIndexOf('.') + 1);
  return extension === 'js' || extension === 'css' || extension === 'wasm' ? extension : null;
}

function isAppDocumentUrl(url: URL) {
  return (
    url.origin === workerScope.location.origin &&
    (url.pathname === '/' || url.pathname === '/index.html')
  );
}

function isAppDocumentResponse(response: Response | undefined) {
  if (response?.status !== 200 || response.type === 'opaque' || response.type === 'opaqueredirect')
    return false;
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'text/html') return false;
  try {
    return isAppDocumentUrl(new URL(response.url));
  } catch {
    return false;
  }
}

function isAppCache(name: string) {
  return name.startsWith(`${CACHE_PREFIX}-static-`) || name.startsWith(`${CACHE_PREFIX}-dynamic-`);
}

function isAppWindow(client: Client) {
  return client.type === 'window' && isAppDocumentUrl(new URL(client.url));
}

async function windows() {
  return (await workerScope.clients.matchAll({ includeUncontrolled: true, type: 'window' })).filter(
    (client) => client.url === '' || client.url === 'about:blank' || isAppWindow(client)
  );
}

function archivedPath(url: URL): string {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return url.pathname;
  }
}

function isRetiredCodec(path: string) {
  return (
    /^\/assets\/(?:wasm-webp[.-][\w-]+\.js|webp-wasm[.-][\w-]+\.(?:js|wasm))$/.test(path) ||
    !!lookupRetired(path)
  );
}

function isPredecessorAsset(path: string) {
  return predecessorPaths.has(path) || isRetiredCodec(path);
}

function isProtectedPredecessor(url: URL) {
  const path = archivedPath(url);
  return isPredecessorAsset(path) || eagerPaths.has(path) || sharedPaths.has(path);
}

async function bodyMatches(response: Response, pin: BodyPin): Promise<boolean> {
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  const body = new Uint8Array(pin.size);
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > pin.size) return false;
      body.set(value, offset);
      offset += value.length;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  if (offset !== pin.size) return false;
  const digest = await crypto.subtle.digest('SHA-256', body);
  return (
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('') ===
    pin.sha256
  );
}

async function isCurrentDocument(response: Response) {
  return isAppDocumentResponse(response) && (await bodyMatches(response, shellManifest.document));
}

async function isArchivedDocument(response: Response) {
  return isAppDocumentResponse(response) && (await bodyMatches(response, ARCHIVED_DOCUMENT));
}

async function currentShell() {
  try {
    const cache = await caches.open(STATIC_CACHE);
    const cached = await cache.match(NAVIGATION_CACHE_KEY);
    return cached && (await isCurrentDocument(cached)) ? cached : undefined;
  } catch {
    return undefined;
  }
}

async function installShell() {
  const cache = await caches.open(STATIC_CACHE);
  await Promise.all([
    cache.addAll(PRECACHE_URLS),
    (async () => {
      const response = await fetch(NAVIGATION_CACHE_KEY, { cache: 'reload', redirect: 'error' });
      if (!(await isCurrentDocument(response))) throw new Error('Unverified application document');
      await cache.put(STAGED_DOCUMENT, response);
    })(),
    ...shellManifest.eager.map(async (pin) => {
      const url = new URL(pin.path, workerScope.location.origin);
      const kind = assetKind(url);
      const response = await fetch(url.href, { cache: 'reload', redirect: 'error' });
      if (
        !kind ||
        !assetHeadersValid(response, url.href, kind) ||
        !(await bodyMatches(response, pin))
      ) {
        throw new Error(`Unverified application shell asset: ${pin.path}`);
      }
      await cache.put(url.href, response);
    }),
  ]);
  await workerScope.skipWaiting();
}

async function hasState() {
  return !!(await (await caches.open(RETIREMENT_CACHE)).match(RETIREMENT_KEY));
}

async function readState(): Promise<RetirementState | undefined> {
  try {
    const response = await (await caches.open(RETIREMENT_CACHE)).match(RETIREMENT_KEY);
    if (!response) return undefined;
    const state: Partial<RetirementState> = await response.json();
    const ids = (list: unknown): list is string[] =>
      Array.isArray(list) &&
      list.length <= MAX_CLIENTS &&
      list.every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 128);
    if (
      (state.phase === 'grace' || state.phase === 'closed') &&
      ids(state.old) &&
      ids(state.current)
    ) {
      return { phase: state.phase, old: state.old, current: state.current };
    }
  } catch {
    // Unavailable or invalid metadata cannot admit archived assets.
  }
  return undefined;
}

async function persist(state: RetirementState) {
  if (state.old.length > MAX_CLIENTS || state.current.length > MAX_CLIENTS) {
    throw new Error('Too many app clients to reconcile retirement');
  }
  const cache = await caches.open(RETIREMENT_CACHE);
  await cache.put(RETIREMENT_KEY, new Response(JSON.stringify(state)));
}

async function oldRequester(event: FetchEvent, state: RetirementState) {
  if (!event.clientId || state.current.includes(event.clientId)) return false;
  const client = await workerScope.clients.get(event.clientId);
  if (!client) return false;
  if (state.old.includes(client.id) && isAppWindow(client)) return true;
  const url = new URL(client.url);
  if (
    client.type !== 'worker' ||
    url.origin !== workerScope.location.origin ||
    url.pathname !== ARCHIVED_WORKER
  ) {
    return false;
  }
  return (await windows()).some((window) => state.old.includes(window.id) && isAppWindow(window));
}

async function predecessorResponse(event: FetchEvent, url: URL, path: string) {
  try {
    const state = await readState();
    const canonical = new URL(path, workerScope.location.origin);
    const kind = assetKind(canonical);
    const pin = lookupRetired(path);
    if (
      state?.phase === 'grace' &&
      kind &&
      (pin || !isRetiredCodec(path)) &&
      (await oldRequester(event, state))
    ) {
      const key = canonical.href;
      for (const name of [DYNAMIC_CACHE, STATIC_CACHE]) {
        const cache = await caches.open(name);
        const response = await cache.match(key);
        if (
          response &&
          (assetHeadersValid(response, key, kind, true) ||
            (await validAsset(response, key, kind))) &&
          (!pin || (await bodyMatches(response, pin)))
        ) {
          return response;
        }
      }
    }
  } catch {
    // Failed eligibility or cache reads never send a predecessor request to the network.
  }
  await notifyAssetUnavailable(event, url, 404, 'invalid-response');
  return Response.error();
}

async function sweep() {
  for (const name of (await caches.keys()).filter(isAppCache)) {
    const cache = await caches.open(name);
    for (const key of await cache.keys()) {
      if (await retiredCacheEntry(cache, key)) await cache.delete(key);
    }
    for (const key of await cache.keys()) {
      if (await retiredCacheEntry(cache, key)) return false;
    }
  }
  return true;
}

async function retiredCacheEntry(cache: Cache, key: Request) {
  const url = new URL(key.url);
  if (url.origin !== workerScope.location.origin) return false;
  if (isPredecessorAsset(archivedPath(url))) return true;
  if (!isAppDocumentUrl(url)) return false;
  const response = await cache.match(key);
  return !!response && (await isArchivedDocument(response));
}

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const result = pendingWork.then(work);
  pendingWork = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function putInCache(key: string, response: Response) {
  return serialized(async () => {
    try {
      const cache = await caches.open(DYNAMIC_CACHE);
      const keys = (await cache.keys()).filter((entry) => !isAppDocumentUrl(new URL(entry.url)));
      const sameKey = keys.some((entry) => entry.url === key);
      const trim = Math.max(0, keys.length + Number(!sameKey) - DYNAMIC_CACHE_MAX_ENTRIES);
      if (trim) {
        const state = await readState();
        const keepOld = !state || state.phase === 'grace';
        const eligible = keys.filter((entry) => {
          const url = new URL(entry.url);
          return entry.url !== key && !(keepOld && isProtectedPredecessor(url));
        });
        if (eligible.length < trim) return;
        for (const entry of eligible.slice(0, trim)) {
          if (!(await cache.delete(entry))) return;
        }
      }
      await cache.put(key, response);
    } catch {
      // Quota, private browsing, or disabled storage must not block a response.
    }
  });
}

function assetHeadersValid(
  response: Response | undefined,
  key: string,
  kind: AssetKind,
  admitted = false
) {
  if (
    response?.status !== 200 ||
    !['basic', 'default'].includes(response.type) ||
    response.redirected
  )
    return false;
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (
    (kind === 'js' &&
      ![
        'text/javascript',
        'application/javascript',
        'text/ecmascript',
        'application/ecmascript',
      ].includes(mime ?? '')) ||
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
    return (
      finalUrl.origin === workerScope.location.origin && getStaticAssetCacheKey(finalUrl) === key
    );
  } catch {
    return false;
  }
}

async function assetBodyValid(response: Response, kind: AssetKind) {
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

async function validAsset(response: Response, key: string, kind: AssetKind) {
  return assetHeadersValid(response, key, kind) && (await assetBodyValid(response, kind));
}

function admittedResponse(response: Response, key: string) {
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

async function matchAsset(cacheName: string, key: string, kind: AssetKind) {
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

async function notifyAssetUnavailable(
  event: FetchEvent,
  url: URL,
  status: number,
  reason: 'invalid-response' | 'network-error'
) {
  try {
    const client = event.clientId ? await workerScope.clients.get(event.clientId) : undefined;
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

async function getAsset(
  event: FetchEvent,
  request: Request,
  url: URL,
  key: string,
  kind: AssetKind
) {
  // Installed eager assets already passed a full byte check. Keep that copy in the static shell.
  const cached = eagerPaths.has(url.pathname)
    ? ((await matchAsset(STATIC_CACHE, key, kind)) ?? (await matchAsset(DYNAMIC_CACHE, key, kind)))
    : await matchAsset(DYNAMIC_CACHE, key, kind);
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

workerScope.addEventListener('install', (event) => {
  event.waitUntil(installShell());
});

workerScope.addEventListener('activate', (event) => {
  event.waitUntil(
    serialized(async () => {
      const cache = await caches.open(STATIC_CACHE);
      const shell = await cache.match(STAGED_DOCUMENT);
      if (!shell || !(await isCurrentDocument(shell)))
        throw new Error('Missing verified app shell');
      await cache.put(NAVIGATION_CACHE_KEY, shell);
      await cache.delete(STAGED_DOCUMENT);

      const existing = await readState();
      if (!existing && !(await hasState())) {
        const clients = await windows();
        if (clients.length <= MAX_CLIENTS) {
          await persist({ phase: 'grace', old: clients.map(({ id }) => id), current: [] });
        }
      }
      const names = await caches.keys();
      for (const name of names.filter(isAppCache)) {
        if (name !== STATIC_CACHE && name !== DYNAMIC_CACHE) await caches.delete(name);
      }
      await workerScope.clients.claim();
      if (existing?.phase === 'closed') await sweep();
    })
  );
});

workerScope.addEventListener('message', (event) => {
  const data: unknown = event.data;
  const source = event.source;
  if (
    !event.isTrusted ||
    !__APP_SOURCE_SHA__ ||
    !data ||
    typeof data !== 'object' ||
    !('type' in data) ||
    data.type !== 'dropconvert:retirement-check' ||
    !('generation' in data) ||
    data.generation !== __APP_SOURCE_SHA__ ||
    !source ||
    !('id' in source)
  ) {
    return;
  }
  event.waitUntil(
    serialized(async () => {
      const client = await workerScope.clients.get(source.id);
      if (!client || !isAppWindow(client)) return;
      let phase: 'grace' | 'retired-pending-sweep' | 'retired' = 'retired-pending-sweep';
      try {
        const state = await readState();
        if (state?.phase === 'closed') {
          phase = (await sweep()) ? 'retired' : 'retired-pending-sweep';
        } else {
          const live = new Set((await windows()).map(({ id }) => id));
          live.add(client.id);
          if (!state) {
            // Recovery from a missing or corrupt record can only close, never reopen grace.
            if (live.size === 1) {
              await persist({ phase: 'closed', old: [], current: [] });
              phase = (await sweep()) ? 'retired' : 'retired-pending-sweep';
            }
            client.postMessage({
              type: 'dropconvert:retirement-state',
              generation: __APP_SOURCE_SHA__,
              phase,
            });
            return;
          }
          const current = [...new Set([...state.current, client.id])].filter((id) => live.has(id));
          const old = state.old.filter((id) => live.has(id) && !current.includes(id));
          if ([...live].some((id) => !current.includes(id))) {
            await persist({ phase: 'grace', old, current });
            phase = 'grace';
          } else {
            await persist({ phase: 'closed', old: [], current: [] });
            phase = (await sweep()) ? 'retired' : 'retired-pending-sweep';
          }
        }
      } catch {
        // A failed census, transition or physical sweep is retried by a real page cue.
      }
      client.postMessage({
        type: 'dropconvert:retirement-state',
        generation: __APP_SOURCE_SHA__,
        phase,
      });
    })
  );
});

workerScope.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;
  if (url.origin === workerScope.location.origin) {
    const path = archivedPath(url);
    if (isPredecessorAsset(path)) {
      const work = serialized(() => predecessorResponse(event, url, path));
      event.respondWith(work);
      event.waitUntil(work.catch(() => {}));
      return;
    }
  }
  if (isVideoFile(url)) {
    event.respondWith(fetch(request));
    return;
  }

  if (url.origin === workerScope.location.origin && isStaticAsset(url)) {
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
  const work = documentCacheKey
    ? fetch(request)
        .then(async (response) => {
          if (!isAppDocumentResponse(response)) return response;
          if (await isArchivedDocument(response)) return (await currentShell()) ?? Response.error();
          return response;
        })
        .catch(async (error) => {
          const cached = await currentShell();
          if (cached) return cached;
          throw error;
        })
    : fetch(request);
  event.respondWith(work);
  event.waitUntil(work.catch(() => {}));
});
