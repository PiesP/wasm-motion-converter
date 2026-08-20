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

function loadServiceWorker(): {
  cacheEntries: Map<string, unknown>;
  dispatchFetch: (url: string, destination?: string) => Promise<void>;
} {
  const listeners = new Map<string, (event: FetchEventLike) => void>();
  const cacheEntries = new Map<string, unknown>();
  const cache = {
    delete: vi.fn((key: string) => Promise.resolve(cacheEntries.delete(String(key)))),
    keys: vi.fn(() => Promise.resolve([...cacheEntries.keys()])),
    put: vi.fn((key: string, response: unknown) => {
      cacheEntries.set(String(key), response);
      return Promise.resolve();
    }),
  };
  const caches = {
    match: vi.fn((key: string) => Promise.resolve(cacheEntries.get(String(key)))),
    open: vi.fn(() => Promise.resolve(cache)),
  };
  const response = { clone: () => response, ok: true };
  const self = {
    addEventListener: (type: string, listener: (event: FetchEventLike) => void) => {
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
    fetch: vi.fn(() => Promise.resolve(response)),
    self,
  });

  return {
    cacheEntries,
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
      await responsePromise;
      await Promise.all(waits);
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
