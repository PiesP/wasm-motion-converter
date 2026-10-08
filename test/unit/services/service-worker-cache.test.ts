// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const origin = 'https://drop.test';

function documentResponse(body = 'app', overrides: { url?: string; status?: number; type?: string; contentType?: string | null } = {}) {
  const response = {
    body,
    url: overrides.url ?? `${origin}/`,
    status: overrides.status ?? 200,
    type: overrides.type ?? 'basic',
    ok: (overrides.status ?? 200) >= 200 && (overrides.status ?? 200) < 300,
    headers: new Headers(overrides.contentType === null ? {} : { 'content-type': overrides.contentType ?? 'text/html; charset=utf-8' }),
    clone: () => response,
  };
  return response;
}

interface FetchEventLike {
  request: { destination: string; method: string; mode: string; url: string };
  respondWith: (response: Promise<unknown>) => void;
  waitUntil: (work: Promise<unknown>) => void;
}

interface WaitUntilEventLike {
  waitUntil: (work: Promise<unknown>) => void;
}

type ServiceWorkerEventLike = FetchEventLike | WaitUntilEventLike;

function loadServiceWorker(): {
  cacheEntries: Map<string, unknown>;
  staticCacheEntries: Map<string, unknown>;
  dispatchFetch: (url: string, destination?: string) => Promise<unknown>;
  dispatchInstall: () => Promise<void>;
  dispatchActivate: () => Promise<void>;
  cacheStores: Map<string, Map<string, unknown>>;
  setNetworkFailure: (error: unknown) => void;
  setNetworkResponse: (response: unknown) => void;
} {
  const staticCacheName = 'dropconvert-static-v20261008-documents';
  const dynamicCacheName = 'dropconvert-dynamic-v20261008-documents';
  const listeners = new Map<string, (event: ServiceWorkerEventLike) => void>();
  const cacheStores = new Map<string, Map<string, unknown>>();
  const staticCacheEntries = new Map<string, unknown>();
  const cacheEntries = new Map<string, unknown>();
  cacheStores.set(staticCacheName, staticCacheEntries);
  cacheStores.set(dynamicCacheName, cacheEntries);

  const toCacheKey = (key: string | { url: string }): string => new URL(typeof key === 'string' ? key : key.url, origin).href;
  const defaultResponse = documentResponse();
  let networkResponse: unknown = defaultResponse;
  let networkFailure: unknown;
  const fetchMock = vi.fn((_url: string) =>
    networkFailure === undefined ? Promise.resolve(networkResponse) : Promise.reject(networkFailure)
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
      delete: vi.fn((key: string) => Promise.resolve(entries.delete(toCacheKey(key)))),
      keys: vi.fn(() => Promise.resolve([...entries.keys()])),
      put: vi.fn((key: string, response: unknown) => {
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
      if (!cacheStores.has(cacheName)) cacheStores.set(cacheName, new Map());
      return Promise.resolve(createCache(cacheName));
    }),
  };
  const self = {
    addEventListener: (type: string, listener: (event: ServiceWorkerEventLike) => void) => {
      listeners.set(type, listener);
    },
    clients: { claim: vi.fn() },
    location: { origin: 'https://drop.test' },
    skipWaiting: vi.fn(),
  };

  runInNewContext(readFileSync('public/service-worker.js', 'utf8'), {
    Promise,
    URL,
    caches,
    fetch: fetchMock,
    self,
  });

  return {
    cacheEntries,
    staticCacheEntries,
    cacheStores,
    dispatchFetch: async (url: string, destination = '') => {
      const waits: Promise<unknown>[] = [];
      let responsePromise: Promise<unknown> | undefined;
      listeners.get('fetch')?.({
        request: { destination, method: 'GET', mode: destination === 'document' ? 'navigate' : 'cors', url },
        respondWith: (promise) => {
          responsePromise = promise;
        },
        waitUntil: (promise) => waits.push(promise),
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
  };
}

describe('service worker dynamic cache boundaries', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores supported application document queries under one canonical key', async () => {
    const worker = loadServiceWorker();

    await worker.dispatchFetch('https://drop.test/?nonce=one', 'document');
    await worker.dispatchFetch('https://drop.test/?nonce=two', 'document');

    expect([...worker.cacheEntries.keys()]).toEqual(['https://drop.test/']);
  });

  it('prefers the latest dynamic document over the static precache offline', async () => {
    const worker = loadServiceWorker();
    const versionA = documentResponse('A');
    const versionB = documentResponse('B');

    worker.setNetworkResponse(versionA);
    await worker.dispatchInstall();
    expect(worker.staticCacheEntries.get('https://drop.test/')).toBe(versionA);

    worker.setNetworkResponse(versionB);
    await worker.dispatchFetch('https://drop.test/?version=B', 'document');
    expect(worker.cacheEntries.get('https://drop.test/')).toBe(versionB);

    worker.setNetworkFailure(new Error('offline'));
    await expect(worker.dispatchFetch('https://drop.test/?version=B', 'document')).resolves.toBe(
      versionB
    );
  });

  it.each(['/robots.txt', '/sitemap.xml', '/manifest.json', '/error.html', '/other'])('does not replace the recovery document with %s', async (path) => {
    const worker = loadServiceWorker();
    const app = documentResponse();
    worker.setNetworkResponse(app);
    await worker.dispatchFetch(`${origin}/`, 'document');
    const resource = documentResponse('resource', { url: `${origin}${path}` });
    worker.setNetworkResponse(resource);
    await expect(worker.dispatchFetch(`${origin}${path}`, 'document')).resolves.toBe(resource);
    expect(worker.cacheEntries.get(`${origin}/`)).toBe(app);
    worker.setNetworkFailure(new Error('offline'));
    await expect(worker.dispatchFetch(`${origin}/?offline`, 'document')).resolves.toBe(app);
    await expect(worker.dispatchFetch(`${origin}${path}?uncached`, 'document')).rejects.toThrow('offline');
  });

  it.each([
    { status: 204 }, { status: 206 }, { status: 404 },
    { contentType: 'text/plain' }, { contentType: 'application/xml' }, { contentType: null },
    { type: 'opaque' }, { type: 'opaqueredirect' },
    { url: `${origin}/robots.txt` }, { url: `${origin}/error.html` },
    { url: 'https://elsewhere.test/' }, { url: '' },
  ])('returns but does not admit an invalid root response %j', async (overrides) => {
    const worker = loadServiceWorker();
    const app = documentResponse();
    worker.setNetworkResponse(app);
    await worker.dispatchFetch(`${origin}/`, 'document');
    const invalid = documentResponse('invalid', overrides);
    worker.setNetworkResponse(invalid);
    await expect(worker.dispatchFetch(`${origin}/?changed`, 'document')).resolves.toBe(invalid);
    expect(worker.cacheEntries.get(`${origin}/`)).toBe(app);
  });

  it('accepts a redirect within the supported document set', async () => {
    const worker = loadServiceWorker();
    const app = documentResponse('redirected app', { url: `${origin}/index.html?new` });
    worker.setNetworkResponse(app);
    await worker.dispatchFetch(`${origin}/?redirect`, 'document');
    expect(worker.cacheEntries.get(`${origin}/`)).toBe(app);
    await worker.dispatchFetch(`${origin}/index.html?new`, 'document');
    expect(worker.cacheEntries.size).toBe(1);
  });

  it('rejects a polluted dynamic entry and uses the valid static document', async () => {
    const worker = loadServiceWorker();
    const app = documentResponse('static app');
    worker.setNetworkResponse(app);
    await worker.dispatchInstall();
    worker.cacheEntries.set(`${origin}/`, documentResponse('robots', { url: `${origin}/robots.txt`, contentType: 'text/plain' }));
    worker.setNetworkFailure(new Error('offline'));
    await expect(worker.dispatchFetch(`${origin}/`, 'document')).resolves.toBe(app);
    expect(worker.cacheEntries.has(`${origin}/`)).toBe(false);
  });

  it('fails offline when neither recovery entry is valid', async () => {
    const worker = loadServiceWorker();
    worker.cacheEntries.set(`${origin}/`, documentResponse('bad dynamic', { contentType: 'text/plain' }));
    worker.staticCacheEntries.set(`${origin}/`, documentResponse('bad static', { url: 'https://elsewhere.test/' }));
    worker.setNetworkFailure(new Error('offline'));
    await expect(worker.dispatchFetch(`${origin}/`, 'document')).rejects.toThrow('offline');
    expect(worker.cacheEntries.size).toBe(0);
    expect(worker.staticCacheEntries.size).toBe(0);
  });

  it('removes the prior polluted cache version and preserves unrelated origin caches', async () => {
    const worker = loadServiceWorker();
    const bad = new Map([['https://drop.test/', documentResponse('robots', { contentType: 'text/plain' })]]);
    worker.cacheStores.set('dropconvert-dynamic-v20260714', bad);
    worker.cacheStores.set('other-application-cache', new Map([['unrelated', 'data']]));
    await worker.dispatchInstall();
    await worker.dispatchActivate();
    expect(worker.cacheStores.has('dropconvert-dynamic-v20260714')).toBe(false);
    expect(worker.cacheStores.get('other-application-cache')?.get('unrelated')).toBe('data');
    worker.setNetworkFailure(new Error('offline'));
    await expect(worker.dispatchFetch(`${origin}/`, 'document')).resolves.toBe(worker.staticCacheEntries.get(`${origin}/`));
  });

  it('does not cache video files or substitute the app for API/cross-origin misses', async () => {
    const worker = loadServiceWorker();
    await worker.dispatchInstall();
    await worker.dispatchFetch(`${origin}/video.mp4`, 'document');
    await worker.dispatchFetch(`${origin}/video.webm`, 'document');
    expect(worker.cacheEntries.size).toBe(0);
    worker.setNetworkFailure(new Error('offline'));
    for (const url of [`${origin}/api/data`, 'https://elsewhere.test/']) {
      await expect(worker.dispatchFetch(url)).rejects.toThrow('offline');
    }
    await expect(worker.dispatchFetch(`${origin}/video.mp4`, 'document')).rejects.toThrow('offline');
  });

  it('keeps the latest navigation document while evicting runtime assets', async () => {
    const worker = loadServiceWorker();
    const versionA = documentResponse('A');
    const versionB = documentResponse('B');

    worker.setNetworkResponse(versionA);
    await worker.dispatchInstall();
    worker.setNetworkResponse(versionB);
    await worker.dispatchFetch('https://drop.test/?version=B', 'document');

    for (let index = 0; index < 64; index += 1) {
      await worker.dispatchFetch(`https://drop.test/assets/${index}.js`);
    }

    expect(worker.cacheEntries.size).toBe(65);
    expect(worker.cacheEntries.get('https://drop.test/')).toBe(versionB);
  });

  it('removes query strings from same-origin static asset cache keys', async () => {
    const worker = loadServiceWorker();

    await worker.dispatchFetch('https://drop.test/assets/app.js?nonce=one');
    await worker.dispatchFetch('https://drop.test/assets/app.js?nonce=two');

    expect([...worker.cacheEntries.keys()]).toEqual(['https://drop.test/assets/app.js']);
  });

  it('evicts oldest dynamic entries above the fixed cache ceiling', async () => {
    const worker = loadServiceWorker();

    for (let index = 0; index < 70; index++) {
      await worker.dispatchFetch(`https://drop.test/assets/${index}.js`);
    }

    expect(worker.cacheEntries.size).toBe(64);
    expect(worker.cacheEntries.has('https://drop.test/assets/0.js')).toBe(false);
    expect(worker.cacheEntries.has('https://drop.test/assets/69.js')).toBe(true);
  });
});
