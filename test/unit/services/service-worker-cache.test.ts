// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { webcrypto } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import { build } from 'vite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { verifyServiceWorkerOutput } from '../../../scripts/build/verify-service-worker-output';

let emittedWorker: string;
let workerBuildRoot: string;
const generation = 'a'.repeat(40);
const oldCaller = 'https://drop.test/assets/index.D1rWSzxT.js';
const archivedWorker = 'https://drop.test/assets/worker-BG8LzI1q.js';

beforeAll(async () => {
  workerBuildRoot = mkdtempSync(join(tmpdir(), 'wmc-service-worker-'));
  await build({
    configFile: resolve('vite.config.ts'),
    publicDir: false,
    define: { __APP_SOURCE_SHA__: JSON.stringify(generation) },
    build: { outDir: workerBuildRoot },
    logLevel: 'error',
  });
  verifyServiceWorkerOutput(process.cwd(), workerBuildRoot);
  emittedWorker = readFileSync(join(workerBuildRoot, 'service-worker.js'), 'utf8');
}, 60_000);

afterAll(() => {
  if (workerBuildRoot) rmSync(workerBuildRoot, { recursive: true, force: true });
});

const origin = 'https://drop.test';
const assetUrl = (name: string, extension = 'js') =>
  `${origin}/assets/${name}.abcdefgh.${extension}`;

function assetResponse(
  url: string,
  options: {
    body?: string | Uint8Array;
    status?: number;
    type?: string;
    mime?: string | null;
    finalUrl?: string;
    redirected?: boolean;
    contentEncoding?: string;
  } = {}
) {
  const extension = new URL(url).pathname.split('.').at(-1);
  const body =
    options.body ??
    (extension === 'wasm'
      ? new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
      : extension === 'css'
        ? 'body { color: red }'
        : 'export const valid = true;');
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const response = {
    url: options.finalUrl ?? url,
    status: options.status ?? 200,
    type: options.type ?? 'basic',
    redirected: options.redirected ?? false,
    headers: new Headers(
      options.mime === null
        ? {}
        : {
            'content-type':
              options.mime ??
              { js: 'text/javascript', css: 'text/css', wasm: 'application/wasm' }[
                extension ?? ''
              ] ??
              'text/plain',
          }
    ),
    clone: vi.fn(() => ({
      ...response,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    })),
  };
  if (options.contentEncoding) response.headers.set('content-encoding', options.contentEncoding);
  return response;
}

function defaultAssetResponse(url: string) {
  const path = new URL(url).pathname;
  const emitted = join(workerBuildRoot, path);
  if (existsSync(emitted)) return assetResponse(url, { body: readFileSync(emitted) });
  return assetResponse(url);
}

function documentResponse(
  body = readFileSync(join(workerBuildRoot, 'index.html'), 'utf8'),
  overrides: { url?: string; status?: number; type?: string; contentType?: string | null } = {}
) {
  const response = {
    body,
    url: overrides.url ?? `${origin}/`,
    status: overrides.status ?? 200,
    type: overrides.type ?? 'basic',
    ok: (overrides.status ?? 200) >= 200 && (overrides.status ?? 200) < 300,
    headers: new Headers(
      overrides.contentType === null
        ? {}
        : { 'content-type': overrides.contentType ?? 'text/html; charset=utf-8' }
    ),
    clone: () => ({
      ...response,
      body: new Response(body).body,
    }),
  };
  return response;
}

interface FetchEventLike {
  request: { destination: string; method: string; mode: string; url: string };
  clientId: string;
  respondWith: (response: Promise<unknown>) => void;
  waitUntil: (work: Promise<unknown>) => void;
}

interface WaitUntilEventLike {
  waitUntil: (work: Promise<unknown>) => void;
}

interface ClientLike {
  id: string;
  type: 'window' | 'worker';
  url: string;
  postMessage: (data: unknown) => void;
}

type ServiceWorkerEventLike = FetchEventLike | WaitUntilEventLike;

type CacheStores = Map<string, Map<string, unknown>>;

function loadServiceWorker(existingStores?: CacheStores): {
  cacheEntries: Map<string, unknown>;
  staticCacheEntries: Map<string, unknown>;
  dispatchFetch: (url: string, destination?: string, clientId?: string) => Promise<unknown>;
  dispatchMessage: (client: ClientLike, claimedGeneration?: string) => Promise<void>;
  addClient: (id: string, type?: ClientLike['type'], url?: string) => ClientLike;
  removeClient: (id: string) => void;
  failDelete: (url: string) => void;
  delayRead: (url: string) => { started: Promise<void>; resume: () => void };
  dispatchInstall: () => Promise<void>;
  dispatchActivate: () => Promise<void>;
  cacheStores: Map<string, Map<string, unknown>>;
  fetchMock: ReturnType<typeof vi.fn>;
  cacheWrites: () => number;
  cacheEnumerations: () => number;
  messages: unknown[];
  syncWaits: () => number;
  setNetworkFailure: (error: unknown) => void;
  setNetworkResponse: (response?: unknown) => void;
  setStorageFailure: (failure: boolean) => void;
} {
  const staticCacheName = 'dropconvert-static-v20261008-documents';
  const dynamicCacheName = 'dropconvert-dynamic-v20261008-documents';
  const listeners = new Map<string, (event: ServiceWorkerEventLike) => void>();
  const cacheStores = existingStores ?? new Map<string, Map<string, unknown>>();
  const staticCacheEntries = cacheStores.get(staticCacheName) ?? new Map<string, unknown>();
  const cacheEntries = cacheStores.get(dynamicCacheName) ?? new Map<string, unknown>();
  cacheStores.set(staticCacheName, staticCacheEntries);
  cacheStores.set(dynamicCacheName, cacheEntries);

  const toCacheKey = (key: string | { url: string }): string =>
    new URL(typeof key === 'string' ? key : key.url, origin).href;
  const defaultResponse = documentResponse();
  let networkResponse: unknown;
  let networkFailure: unknown;
  let storageFailure = false;
  let rejectedDelete: string | undefined;
  let delayedRead: { url: string; started: () => void; done: Promise<void> } | undefined;
  let writes = 0;
  let enumerations = 0;
  let syncWaitCount = 0;
  const messages: unknown[] = [];
  const clients = new Map<string, ClientLike>();
  const addClient = (id: string, type: ClientLike['type'] = 'window', url = `${origin}/`) => {
    const client = {
      id,
      type,
      url,
      postMessage: (data: unknown) => {
        messages.push(data);
      },
    };
    clients.set(id, client);
    return client;
  };
  addClient('test-client');
  const fetchMock = vi.fn((request: string | { url: string }) =>
    networkFailure === undefined
      ? Promise.resolve(
          networkResponse ??
            (new URL(typeof request === 'string' ? request : request.url).pathname.startsWith(
              '/assets/'
            )
              ? defaultAssetResponse(typeof request === 'string' ? request : request.url)
              : defaultResponse)
        )
      : Promise.reject(networkFailure)
  );

  const createCache = (cacheName: string) => {
    const entries = cacheStores.get(cacheName);
    if (!entries) throw new Error(`Unknown cache: ${cacheName}`);
    return {
      addAll: vi.fn(async (keys: string[]) => {
        for (const key of keys) {
          const response = await fetchMock(toCacheKey(key));
          entries.set(toCacheKey(key), response);
        }
      }),
      delete: vi.fn((key: string | { url: string }) =>
        Promise.resolve(toCacheKey(key) !== rejectedDelete && entries.delete(toCacheKey(key)))
      ),
      match: vi.fn(async (key: string | { url: string }) => {
        const url = toCacheKey(key);
        if (url === delayedRead?.url) {
          const delay = delayedRead;
          delayedRead = undefined;
          delay.started();
          await delay.done;
        }
        const response = entries.get(url);
        return url.endsWith('/.dropconvert-retirement') && response instanceof Response
          ? response.clone()
          : response;
      }),
      keys: vi.fn(() => {
        enumerations += 1;
        return Promise.resolve([...entries.keys()].map((url) => ({ url })));
      }),
      put: vi.fn((key: string, response: unknown) => {
        writes += 1;
        entries.set(toCacheKey(key), response);
        return Promise.resolve();
      }),
    };
  };

  const caches = {
    match: vi.fn((key: string, options?: { cacheName?: string }) => {
      const cacheNames = options?.cacheName ? [options.cacheName] : [...cacheStores.keys()];
      const cacheKey = toCacheKey(key);
      for (const cacheName of cacheNames) {
        const entries = cacheStores.get(cacheName);
        const response = entries?.get(cacheKey);
        if (response !== undefined) return Promise.resolve(response);
      }
      return Promise.resolve(undefined);
    }),
    keys: vi.fn(() => Promise.resolve([...cacheStores.keys()])),
    delete: vi.fn((cacheName: string) => Promise.resolve(cacheStores.delete(cacheName))),
    open: vi.fn((cacheName: string) => {
      if (storageFailure) return Promise.reject(new Error('storage unavailable'));
      if (!cacheStores.has(cacheName)) cacheStores.set(cacheName, new Map());
      return Promise.resolve(createCache(cacheName));
    }),
  };
  const self = {
    addEventListener: (type: string, listener: (event: ServiceWorkerEventLike) => void) => {
      listeners.set(type, listener);
    },
    clients: {
      claim: vi.fn(),
      get: vi.fn(async (id: string) => clients.get(id)),
      matchAll: vi.fn(async () => [...clients.values()].filter(({ type }) => type === 'window')),
    },
    location: { origin: 'https://drop.test' },
    skipWaiting: vi.fn(),
  };

  runInNewContext(`'use strict';\n${emittedWorker}`, {
    Promise,
    Headers,
    Response,
    TextDecoder,
    Uint8Array,
    URL,
    caches,
    crypto: webcrypto,
    fetch: fetchMock,
    self,
  });

  return {
    cacheEntries,
    staticCacheEntries,
    cacheStores,
    fetchMock,
    cacheWrites: () => writes,
    cacheEnumerations: () => enumerations,
    messages,
    syncWaits: () => syncWaitCount,
    addClient,
    removeClient: (id) => {
      clients.delete(id);
    },
    failDelete: (url) => {
      rejectedDelete = url;
    },
    delayRead: (url) => {
      const started = Promise.withResolvers<void>();
      const done = Promise.withResolvers<void>();
      delayedRead = { url, started: started.resolve, done: done.promise };
      return { started: started.promise, resume: done.resolve };
    },
    dispatchMessage: async (source, claimedGeneration = generation) => {
      const waits: Promise<unknown>[] = [];
      listeners.get('message')?.({
        ...{
          isTrusted: true,
          source,
          data: { type: 'dropconvert:retirement-check', generation: claimedGeneration },
        },
        waitUntil: (work) => waits.push(work),
      });
      await Promise.all(waits);
    },
    dispatchFetch: async (url: string, destination = '', clientId = 'test-client') => {
      const waits: Promise<unknown>[] = [];
      let responsePromise: Promise<unknown> | undefined;
      listeners.get('fetch')?.({
        request: {
          destination,
          method: 'GET',
          mode: destination === 'document' ? 'navigate' : 'cors',
          url,
        },
        clientId,
        respondWith: (promise) => {
          responsePromise = promise;
        },
        waitUntil: (promise) => {
          syncWaitCount += 1;
          waits.push(promise);
        },
      });
      const response = await responsePromise;
      await Promise.all(waits);
      return response;
    },
    dispatchInstall: async () => {
      const waits: Promise<unknown>[] = [];
      listeners.get('install')?.({ waitUntil: (promise) => waits.push(promise) });
      await Promise.all(waits);
    },
    dispatchActivate: async () => {
      const waits: Promise<unknown>[] = [];
      listeners.get('activate')?.({ waitUntil: (promise) => waits.push(promise) });
      await Promise.all(waits);
    },
    setNetworkFailure: (error) => {
      networkFailure = error;
    },
    setNetworkResponse: (response) => {
      networkFailure = undefined;
      networkResponse = response;
    },
    setStorageFailure: (failure) => {
      storageFailure = failure;
    },
  };
}

describe('service worker dynamic cache boundaries', () => {
  beforeEach(() => vi.clearAllMocks());

  it('commits only the exact emitted shell and serves it offline, including eager assets', async () => {
    const worker = loadServiceWorker();
    await worker.dispatchInstall();
    expect(worker.staticCacheEntries.has(`${origin}/`)).toBe(false);
    await worker.dispatchActivate();
    const shell = worker.staticCacheEntries.get(`${origin}/`);
    const update = documentResponse('future app');
    worker.setNetworkResponse(update);
    await expect(worker.dispatchFetch(`${origin}/?new`, 'document')).resolves.toBe(update);
    expect(worker.cacheEntries.has(`${origin}/`)).toBe(false);
    worker.setNetworkFailure(new Error('offline'));
    await expect(worker.dispatchFetch(`${origin}/?offline`, 'document')).resolves.toBe(shell);
    const eager = [...worker.staticCacheEntries.keys()].filter((url) =>
      new URL(url).pathname.startsWith('/assets/')
    );
    expect(eager).toHaveLength(3);
    await expect(
      worker.dispatchFetch(
        eager.find((url) => url.endsWith('.js'))!,
        'script'
      )
    ).resolves.toBeDefined();
    expect(eager.some((url) => /worker|wasm|conversion-pipeline/.test(url))).toBe(false);
  });

  it('rejects a staged mismatching document without replacing the previous offline document', async () => {
    const worker = loadServiceWorker();
    const previous = documentResponse('old');
    worker.staticCacheEntries.set(`${origin}/`, previous);
    worker.setNetworkResponse(documentResponse('outside this build'));
    await expect(worker.dispatchInstall()).rejects.toThrow('Unverified application');
    expect(worker.staticCacheEntries.get(`${origin}/`)).toBe(previous);
  });

  it.each(['/robots.txt', '/sitemap.xml', '/manifest.json', '/error.html', '/other'])(
    'does not replace the recovery document with %s',
    async (path) => {
      const worker = loadServiceWorker();
      await worker.dispatchInstall();
      await worker.dispatchActivate();
      const app = worker.staticCacheEntries.get(`${origin}/`);
      const resource = documentResponse('resource', { url: `${origin}${path}` });
      worker.setNetworkResponse(resource);
      await expect(worker.dispatchFetch(`${origin}${path}`, 'document')).resolves.toBe(resource);
      expect(worker.staticCacheEntries.get(`${origin}/`)).toBe(app);
      worker.setNetworkFailure(new Error('offline'));
      await expect(worker.dispatchFetch(`${origin}/?offline`, 'document')).resolves.toBe(app);
      await expect(worker.dispatchFetch(`${origin}${path}?uncached`, 'document')).rejects.toThrow(
        'offline'
      );
    }
  );

  it.each([
    { status: 204 },
    { status: 206 },
    { status: 404 },
    { contentType: 'text/plain' },
    { contentType: 'application/xml' },
    { contentType: null },
    { type: 'opaque' },
    { type: 'opaqueredirect' },
    { url: `${origin}/robots.txt` },
    { url: `${origin}/error.html` },
    { url: 'https://elsewhere.test/' },
    { url: '' },
  ])('returns but does not admit an invalid root response %j', async (overrides) => {
    const worker = loadServiceWorker();
    await worker.dispatchInstall();
    await worker.dispatchActivate();
    const invalid = documentResponse('invalid', overrides);
    worker.setNetworkResponse(invalid);
    await expect(worker.dispatchFetch(`${origin}/?changed`, 'document')).resolves.toBe(invalid);
    expect(worker.cacheEntries.has(`${origin}/`)).toBe(false);
  });

  it('passes an online document redirect through without replacing the verified shell', async () => {
    const worker = loadServiceWorker();
    await worker.dispatchInstall();
    await worker.dispatchActivate();
    const shell = worker.staticCacheEntries.get(`${origin}/`);
    const redirected = documentResponse('redirected app', { url: `${origin}/index.html?new` });
    worker.setNetworkResponse(redirected);
    await expect(worker.dispatchFetch(`${origin}/?redirect`, 'document')).resolves.toBe(redirected);
    expect(worker.cacheEntries.has(`${origin}/`)).toBe(false);
    expect(worker.staticCacheEntries.get(`${origin}/`)).toBe(shell);
  });

  it('fails offline when neither recovery entry is valid', async () => {
    const worker = loadServiceWorker();
    worker.cacheEntries.set(
      `${origin}/`,
      documentResponse('bad dynamic', { contentType: 'text/plain' })
    );
    worker.staticCacheEntries.set(
      `${origin}/`,
      documentResponse('bad static', { url: 'https://elsewhere.test/' })
    );
    worker.setNetworkFailure(new Error('offline'));
    await expect(worker.dispatchFetch(`${origin}/`, 'document')).rejects.toThrow('offline');
  });

  it('retains the current cache through activation and removes only stale app-owned caches', async () => {
    const worker = loadServiceWorker();
    const oldAsset = assetResponse(assetUrl('old'));
    worker.cacheEntries.set(assetUrl('old'), oldAsset);
    worker.cacheStores.set('dropconvert-dynamic-v20260714', new Map());
    worker.cacheStores.set('other-application-cache', new Map([['unrelated', 'data']]));
    await worker.dispatchInstall();
    await worker.dispatchActivate();
    expect(worker.cacheStores.has('dropconvert-dynamic-v20260714')).toBe(false);
    expect(worker.cacheStores.get('other-application-cache')?.get('unrelated')).toBe('data');
    expect(worker.cacheEntries.get(assetUrl('old'))).toBe(oldAsset);
    worker.setNetworkFailure(new Error('offline'));
    await expect(worker.dispatchFetch(assetUrl('old'), 'script')).resolves.toBe(oldAsset);
    await expect(worker.dispatchFetch(`${origin}/`, 'document')).resolves.toBe(
      worker.staticCacheEntries.get(`${origin}/`)
    );
  });

  it('does not cache video files or substitute the app for API/cross-origin misses', async () => {
    const worker = loadServiceWorker();
    await worker.dispatchInstall();
    worker.cacheStores.set(
      'other-application-cache',
      new Map([[`${origin}/api/data`, documentResponse('unrelated')]])
    );
    await worker.dispatchFetch(`${origin}/video.mp4`, 'document');
    await worker.dispatchFetch(`${origin}/video.webm`, 'document');
    expect(worker.cacheEntries.size).toBe(0);
    worker.setNetworkFailure(new Error('offline'));
    for (const url of [`${origin}/api/data`, 'https://elsewhere.test/']) {
      await expect(worker.dispatchFetch(url)).rejects.toThrow('offline');
    }
    await expect(worker.dispatchFetch(`${origin}/video.mp4`, 'document')).rejects.toThrow(
      'offline'
    );
  });

  it('protects resident predecessor aliases under dynamic cache pressure until retirement', async () => {
    const worker = loadServiceWorker();
    await worker.dispatchInstall();
    await worker.dispatchActivate();
    const oldAlias = `${oldCaller}?frozen`;
    worker.cacheEntries.set(oldAlias, assetResponse(oldCaller));
    for (let index = 0; index < 68; index++) {
      await worker.dispatchFetch(assetUrl(String(index)));
    }
    expect(worker.cacheEntries.size).toBe(64);
    expect(worker.cacheEntries.has(oldAlias)).toBe(true);
    expect(worker.staticCacheEntries.has(`${origin}/`)).toBe(true);
  });

  it('limits warm callers and closes admission across worker reinitialization', async () => {
    const worker = loadServiceWorker();
    const before = assetResponse(oldCaller);
    worker.cacheEntries.set(oldCaller, before);
    worker.staticCacheEntries.set(`${oldCaller}?preserve`, before);
    await worker.dispatchInstall();
    await worker.dispatchActivate();
    const current = worker.addClient('current');
    const oldDedicated = worker.addClient('old-worker', 'worker', archivedWorker);
    const otherWorker = worker.addClient(
      'unresolved-worker',
      'worker',
      `${origin}/assets/webp-wasm-BqUWQtOZ.js`
    );
    const networkCount = worker.fetchMock.mock.calls.length;
    await expect(worker.dispatchFetch(oldCaller, 'script')).resolves.toBe(before);
    await expect(worker.dispatchFetch(oldCaller, 'script', oldDedicated.id)).resolves.toBe(before);
    expect(
      ((await worker.dispatchFetch(oldCaller, 'script', otherWorker.id)) as Response).type
    ).toBe('error');
    expect(((await worker.dispatchFetch(oldCaller, 'script', '')) as Response).type).toBe('error');
    expect(((await worker.dispatchFetch(oldCaller, 'script', current.id)) as Response).type).toBe(
      'error'
    );
    await worker.dispatchMessage(current, 'b'.repeat(40));
    expect(worker.messages.some((message) => (message as { phase?: string }).phase)).toBe(false);
    await worker.dispatchMessage(current);
    expect(worker.messages.at(-1)).toMatchObject({ phase: 'grace', generation });
    worker.removeClient('test-client');
    worker.failDelete(oldCaller);
    await worker.dispatchMessage(current);
    expect(worker.messages.at(-1)).toMatchObject({ phase: 'retired-pending-sweep', generation });
    expect(worker.cacheEntries.has(oldCaller)).toBe(true);
    expect(
      ((await worker.dispatchFetch(`${oldCaller}?after`, 'script', current.id)) as Response).type
    ).toBe('error');
    expect(worker.fetchMock.mock.calls).toHaveLength(networkCount);

    const restarted = loadServiceWorker(worker.cacheStores);
    restarted.removeClient('test-client');
    await restarted.dispatchMessage(restarted.addClient(current.id));
    expect(restarted.messages.at(-1)).toMatchObject({ phase: 'retired', generation });
    expect(restarted.cacheEntries.has(oldCaller)).toBe(false);
    expect(restarted.staticCacheEntries.has(`${oldCaller}?preserve`)).toBe(false);
    expect(((await restarted.dispatchFetch(oldCaller, 'style', current.id)) as Response).type).toBe(
      'error'
    );
    expect(restarted.fetchMock).not.toHaveBeenCalled();
  });

  it('settles an admitted compatibility read before the subsequent retirement sweep', async () => {
    const worker = loadServiceWorker();
    const body = assetResponse(oldCaller);
    worker.cacheEntries.set(oldCaller, body);
    await worker.dispatchInstall();
    await worker.dispatchActivate();
    const current = worker.addClient('current');
    const delay = worker.delayRead(oldCaller);
    const compatibility = worker.dispatchFetch(oldCaller);
    await delay.started;
    worker.removeClient('test-client');
    const retirement = worker.dispatchMessage(current);
    expect(worker.cacheEntries.has(oldCaller)).toBe(true);
    expect(worker.messages).toEqual([]);
    delay.resume();
    await expect(compatibility).resolves.toBe(body);
    await retirement;
    expect(worker.messages.at(-1)).toMatchObject({ phase: 'retired', generation });
    expect(worker.cacheEntries.has(oldCaller)).toBe(false);
  });

  it('rejects an invalid exact legacy body and older aliases without network/cache admission', async () => {
    const worker = loadServiceWorker();
    await worker.dispatchInstall();
    await worker.dispatchActivate();
    const legacy = `${origin}/assets/webp-wasm-DhoM6Y9t.wasm`;
    worker.cacheEntries.set(legacy, assetResponse(legacy));
    const network = worker.fetchMock.mock.calls.length;
    const writes = worker.cacheWrites();
    expect(await worker.dispatchFetch(legacy)).toHaveProperty('type', 'error');
    expect(
      await worker.dispatchFetch(`${origin}/assets/%77ebp-wasm-DhoM6Y9t.wasm?alias`)
    ).toHaveProperty('type', 'error');
    expect(
      await worker.dispatchFetch(`${origin}/assets/webp-wasm-abcdefgh.wasm?older`)
    ).toHaveProperty('type', 'error');
    expect(worker.fetchMock.mock.calls).toHaveLength(network);
    expect(worker.cacheWrites()).toBe(writes);
    const current = worker.addClient('current');
    worker.removeClient('test-client');
    await worker.dispatchMessage(current);
    expect(worker.cacheEntries.has(legacy)).toBe(false);
  });

  it('removes query strings from same-origin static asset cache keys', async () => {
    const worker = loadServiceWorker();

    await worker.dispatchFetch(`${assetUrl('app')}?nonce=one`);
    await worker.dispatchFetch(`${assetUrl('app')}?nonce=two`);

    expect([...worker.cacheEntries.keys()]).toEqual([assetUrl('app')]);
  });

  it('evicts oldest dynamic entries above the fixed cache ceiling', async () => {
    const worker = loadServiceWorker();

    for (let index = 0; index < 70; index++) {
      await worker.dispatchFetch(assetUrl(String(index)));
    }

    expect(worker.cacheEntries.size).toBe(64);
    expect(worker.cacheEntries.has(assetUrl('0'))).toBe(false);
    expect(worker.cacheEntries.has(assetUrl('69'))).toBe(true);
  });

  it('returns a verified cached asset without a fetch, clone, write, or FIFO walk', async () => {
    const worker = loadServiceWorker();
    const url = assetUrl('warm');
    await worker.dispatchFetch(url, 'script');
    const cached = worker.cacheEntries.get(url);
    const cloned = cached as Response;
    const cloneSpy = vi.spyOn(cloned, 'clone');
    const before = {
      fetch: worker.fetchMock.mock.calls.length,
      writes: worker.cacheWrites(),
      walks: worker.cacheEnumerations(),
    };
    worker.setNetworkFailure(new Error('offline'));
    await expect(worker.dispatchFetch(url, 'script')).resolves.toBe(cached);
    expect(worker.fetchMock).toHaveBeenCalledTimes(before.fetch);
    expect(cloneSpy).not.toHaveBeenCalled();
    expect(worker.cacheWrites()).toBe(before.writes);
    expect(worker.cacheEnumerations()).toBe(before.walks);
    expect(worker.syncWaits()).toBe(2);
  });

  it.each([
    ['worker-CbXtAM7H.js', 'worker'],
    ['index.B3dFgWpN.css', 'style'],
    ['owned-vp8-Dt0iE3Ie.wasm', ''],
  ])('admits emitted fingerprinted asset %s', async (name, destination) => {
    const worker = loadServiceWorker();
    const url = `${origin}/assets/${name}`;
    await worker.dispatchFetch(url, destination);
    expect(worker.cacheEntries.has(url)).toBe(true);
  });

  it('leaves unversioned and destination-mismatched resources to the browser', async () => {
    const worker = loadServiceWorker();
    await worker.dispatchFetch(`${origin}/assets/app.js`, 'script');
    await worker.dispatchFetch(assetUrl('script'), 'style');
    expect(worker.fetchMock).not.toHaveBeenCalled();
    expect(worker.cacheEntries.size).toBe(0);
  });

  it('does not replay compressed transfer headers onto the decoded cached body', async () => {
    const worker = loadServiceWorker();
    const url = assetUrl('compressed');
    worker.setNetworkResponse(assetResponse(url, { contentEncoding: 'gzip' }));
    await worker.dispatchFetch(url, 'script');
    expect((worker.cacheEntries.get(url) as Response).headers.has('content-encoding')).toBe(false);
  });

  it('validates a pre-existing cache entry once, then serves it directly', async () => {
    const worker = loadServiceWorker();
    const url = assetUrl('retained');
    const old = assetResponse(url);
    worker.cacheEntries.set(url, old);
    worker.setNetworkFailure(new Error('offline'));
    await expect(worker.dispatchFetch(url, 'script')).resolves.toBe(old);
    expect(old.clone).toHaveBeenCalledTimes(2);
    const migrated = worker.cacheEntries.get(url);
    expect((migrated as Response).headers.get('x-dropconvert-asset-admission')).toBe(
      'body-checked-v1'
    );
    const cloneSpy = vi.spyOn(migrated as Response, 'clone');
    await expect(worker.dispatchFetch(url, 'script')).resolves.toBe(migrated);
    expect(old.clone).toHaveBeenCalledTimes(2);
    expect(cloneSpy).not.toHaveBeenCalled();
    expect(worker.fetchMock).not.toHaveBeenCalled();
  });

  it.each(['js', 'css', 'wasm'] as const)(
    'rejects HTML mislabeled as %s from network and a polluted cache entry',
    async (extension) => {
      const worker = loadServiceWorker();
      const url = assetUrl(`polluted-${extension}`, extension);
      const bad = assetResponse(url, { body: '<!doctype html><html>fallback</html>' });
      worker.cacheEntries.set(url, bad);
      worker.setNetworkResponse(bad);
      const response = await worker.dispatchFetch(url);
      expect((response as Response).type).toBe('error');
      expect(worker.cacheEntries.has(url)).toBe(false);
      expect(worker.messages).toEqual([
        {
          type: 'dropconvert:asset-unavailable',
          path: new URL(url).pathname,
          status: 200,
          reason: 'invalid-response',
        },
      ]);
    }
  );

  it.each([
    { status: 206 },
    { status: 404 },
    { type: 'opaque' },
    { type: 'opaqueredirect' },
    { mime: 'text/html' },
    { finalUrl: `${origin}/index.html` },
    { finalUrl: 'https://elsewhere.test/assets/app.abcdefgh.js' },
    { redirected: true },
  ])('does not admit an invalid asset response %j', async (options) => {
    const worker = loadServiceWorker();
    const url = assetUrl('invalid');
    worker.setNetworkResponse(assetResponse(url, options));
    expect(((await worker.dispatchFetch(url)) as Response).type).toBe('error');
    expect(worker.cacheEntries.size).toBe(0);
  });

  it('reports a missing asset with its HTTP status for a controlled reload prompt', async () => {
    const worker = loadServiceWorker();
    const url = assetUrl('missing');
    worker.setNetworkResponse(
      assetResponse(url, { status: 404, mime: 'text/html', body: '<html>missing</html>' })
    );
    expect(((await worker.dispatchFetch(url, 'script')) as Response).type).toBe('error');
    expect(worker.messages).toEqual([
      {
        type: 'dropconvert:asset-unavailable',
        path: '/assets/missing.abcdefgh.js',
        status: 404,
        reason: 'invalid-response',
      },
    ]);
  });

  it('keeps a valid old asset after failed network for a removed lazy chunk', async () => {
    const worker = loadServiceWorker();
    const oldUrl = assetUrl('old-open-tab');
    worker.cacheEntries.set(oldUrl, assetResponse(oldUrl));
    worker.setNetworkFailure(new Error('removed from deployment'));
    await expect(worker.dispatchFetch(oldUrl, 'script')).resolves.toBe(
      worker.cacheEntries.get(oldUrl)
    );
    await expect(worker.dispatchFetch(assetUrl('never-fetched'), 'script')).rejects.toThrow(
      'removed from deployment'
    );
    expect(worker.messages).toEqual([
      {
        type: 'dropconvert:asset-unavailable',
        path: '/assets/never-fetched.abcdefgh.js',
        status: 0,
        reason: 'network-error',
      },
    ]);
    expect(worker.cacheEntries.has(oldUrl)).toBe(true);
  });

  it('serves valid network assets when CacheStorage is unavailable', async () => {
    const worker = loadServiceWorker();
    worker.setStorageFailure(true);
    const response = await worker.dispatchFetch(assetUrl('storage-failed'), 'script');
    expect(response).toBeDefined();
    expect(worker.cacheWrites()).toBe(0);
  });
});
