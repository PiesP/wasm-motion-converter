// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FetchEventLike {
  request: { destination: string; method: string; url: string };
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
  setNetworkFailure: (error: unknown) => void;
  setNetworkResponse: (response: unknown) => void;
} {
  const origin = 'https://drop.test';
  const staticCacheName = 'dropconvert-static-v20260714';
  const dynamicCacheName = 'dropconvert-dynamic-v20260714';
  const listeners = new Map<string, (event: ServiceWorkerEventLike) => void>();
  const cacheStores = new Map<string, Map<string, unknown>>();
  const staticCacheEntries = new Map<string, unknown>();
  const cacheEntries = new Map<string, unknown>();
  cacheStores.set(staticCacheName, staticCacheEntries);
  cacheStores.set(dynamicCacheName, cacheEntries);

  const toCacheKey = (key: string): string => new URL(String(key), origin).href;
  const defaultResponse = { clone: () => defaultResponse, ok: true };
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
    open: vi.fn((cacheName: string) => Promise.resolve(createCache(cacheName))),
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
    dispatchFetch: async (url: string, destination = '') => {
      const waits: Promise<unknown>[] = [];
      let responsePromise: Promise<unknown> | undefined;
      listeners.get('fetch')?.({
        request: { destination, method: 'GET', url },
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

  it('stores every same-origin document query under one canonical key', async () => {
    const worker = loadServiceWorker();

    await worker.dispatchFetch('https://drop.test/?nonce=one', 'document');
    await worker.dispatchFetch('https://drop.test/?nonce=two', 'document');

    expect([...worker.cacheEntries.keys()]).toEqual(['https://drop.test/']);
  });

  it('prefers the latest dynamic document over the static precache offline', async () => {
    const worker = loadServiceWorker();
    const versionA = { body: 'A', clone: () => versionA, ok: true };
    const versionB = { body: 'B', clone: () => versionB, ok: true };

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

  it('keeps the latest navigation document while evicting runtime assets', async () => {
    const worker = loadServiceWorker();
    const versionA = { body: 'A', clone: () => versionA, ok: true };
    const versionB = { body: 'B', clone: () => versionB, ok: true };

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
