// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createHash, webcrypto } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import { build } from 'vite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { verifyServiceWorkerOutput } from '../../../scripts/build/verify-service-worker-output';
import { replacedApp } from '../../../tooling/vite/plugins/emit-service-worker';

let emittedWorker: string;
let workerBuildRoot: string;
const generation = 'a'.repeat(40);
const oldCaller = 'https://drop.test/assets/index.D1rWSzxT.js';
const archivedWorker = 'https://drop.test/assets/worker-BG8LzI1q.js';
const replacedGifPath = '/assets/gif-scalar-quantizer-C4eFz0Ox.wasm';
const replacedPipelinePath = '/assets/conversion-pipeline.D3cmESmf.js';
const replacedPipeline = 'export const valid = true;';
const replacedWorkerPath = '/assets/worker-B5-WTQ3J.js';
const replacedDocument = '<!doctype html><title>Prior GIF deployment fixture</title>';
const replacedGif = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const fixtureDigest = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

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
const dynamicCacheName = 'dropconvert-dynamic-v20261008-documents';
const replacementCacheName = 'dropconvert-replace-02f1cc21';
const retirementKey = origin + '/.dropconvert-retirement';
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
  controlled: boolean;
  postMessage: (data: unknown) => void;
}

type ServiceWorkerEventLike = FetchEventLike | WaitUntilEventLike;

type CacheStores = Map<string, Map<string, unknown>>;

function loadServiceWorker(
  existingStores?: CacheStores,
  replacementFixture = false
): {
  cacheEntries: Map<string, unknown>;
  staticCacheEntries: Map<string, unknown>;
  dispatchFetch: (url: string, destination?: string, clientId?: string) => Promise<unknown>;
  dispatchMessage: (client: ClientLike, claimedGeneration?: string) => Promise<void>;
  addClient: (
    id: string,
    type?: ClientLike['type'],
    url?: string,
    controlled?: boolean
  ) => ClientLike;
  removeClient: (id: string) => void;
  failDelete: (url: string, throws?: boolean) => void;
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
  setReplacementWriteFailure: (failure: boolean) => void;
} {
  const staticCacheName = 'dropconvert-static-v20261008-documents';
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
  let replacementWriteFailure = false;
  const registration = { active: { state: existingStores ? 'activated' : 'activating' } };
  let rejectedDelete: { url: string; throws: boolean } | undefined;
  let delayedRead: { url: string; started: () => void; done: Promise<void> } | undefined;
  let writes = 0;
  let enumerations = 0;
  let syncWaitCount = 0;
  const messages: unknown[] = [];
  const clients = new Map<string, ClientLike>();
  const addClient = (
    id: string,
    type: ClientLike['type'] = 'window',
    url = `${origin}/`,
    controlled = true
  ) => {
    const client = {
      id,
      type,
      url,
      controlled,
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
      delete: vi.fn(async (key: string | { url: string }) => {
        const url = toCacheKey(key);
        if (url !== rejectedDelete?.url) return entries.delete(url);
        if (rejectedDelete.throws) throw new Error('Cache deletion failed');
        return false;
      }),
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
        if (cacheName === replacementCacheName && replacementWriteFailure) {
          return Promise.reject(new Error('replacement metadata write unavailable'));
        }
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
        if (response !== undefined) {
          return Promise.resolve(response instanceof Response ? response.clone() : response);
        }
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
      claim: vi.fn(() => {
        for (const client of clients.values()) client.controlled = true;
      }),
      get: vi.fn(async (id: string) => clients.get(id)),
      matchAll: vi.fn(async (options: { type: string; includeUncontrolled?: boolean }) =>
        [...clients.values()].filter(
          (client) =>
            client.type === options.type && (client.controlled || options.includeUncontrolled)
        )
      ),
    },
    location: { origin: 'https://drop.test' },
    registration,
    skipWaiting: vi.fn(),
  };

  const output = replacementFixture
    ? emittedWorker.replace(/^const __DROP_CONVERT_SHELL__=(.+);$/m, (_line, json: string) => {
        const manifest = JSON.parse(json);
        manifest.replacement.document = {
          size: Buffer.byteLength(replacedDocument),
          sha256: fixtureDigest(replacedDocument),
        };
        for (const [expected, body] of [
          [replacedGifPath, replacedGif],
          [replacedPipelinePath, replacedPipeline],
        ] as const) {
          const pin = manifest.replacement.only.find(
            ({ path }: { path: string }) => path === expected
          );
          if (!pin) throw new Error('Fixture asset must be absent from production bundle');
          pin.size = Buffer.byteLength(body);
          pin.sha256 = fixtureDigest(body);
        }
        return `const __DROP_CONVERT_SHELL__=${JSON.stringify(manifest)};`;
      })
    : emittedWorker;
  runInNewContext(`'use strict';\n${output}`, {
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
    failDelete: (url, throws = false) => {
      rejectedDelete = { url, throws };
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
      registration.active.state = 'activated';
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
    setReplacementWriteFailure: (failure) => {
      replacementWriteFailure = failure;
    },
  };
}

describe('service worker dynamic cache boundaries', () => {
  beforeEach(() => vi.clearAllMocks());

  it('commits only the exact emitted shell and serves it offline, including eager assets', async () => {
    const worker = loadServiceWorker();
    worker.cacheStores.delete(dynamicCacheName);
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
    expect(worker.cacheStores.has(dynamicCacheName)).toBe(false);
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

  it.each([
    [
      'evicts the poisoned dynamic root',
      new Response('poison', { headers: { 'content-type': 'text/plain' } }),
      false,
      false,
    ],
    [
      'tolerates a failed deletion',
      new Response('poison', { headers: { 'content-type': 'text/plain' } }),
      true,
      true,
    ],
    [
      'keeps an admissible predecessor document',
      documentResponse('predecessor shell'),
      false,
      true,
    ],
  ] as const)(
    'serves the verified static shell and %s',
    async (_case, dynamic, fail, keepsDynamic) => {
      const worker = loadServiceWorker();
      await worker.dispatchInstall();
      await worker.dispatchActivate();
      const key = `${origin}/`;
      const shell = worker.staticCacheEntries.get(key);
      expect(shell).toBeDefined();
      worker.cacheEntries.set(key, dynamic);
      if (fail) worker.failDelete(key, true);
      worker.setNetworkFailure(new Error('offline'));

      await expect(worker.dispatchFetch(`${origin}/?offline`, 'document')).resolves.toBe(shell);
      expect(worker.cacheStores.get(dynamicCacheName)?.get(key)).toBe(
        keepsDynamic ? dynamic : undefined
      );
    }
  );

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

  it('isolates replacement grace from the closed VP8 retirement and pins cached predecessor bytes', async () => {
    const worker = loadServiceWorker(undefined, true);
    const url = origin + replacedGifPath;
    const prior = assetResponse(url, { body: replacedGif });
    worker.staticCacheEntries.set(`${origin}/`, documentResponse(replacedDocument));
    worker.cacheEntries.set(url, prior);
    worker.cacheEntries.set(oldCaller, assetResponse(oldCaller));
    worker.cacheStores.set(
      'dropconvert-retire-7d9e0f1b',
      new Map([
        [
          origin + '/.dropconvert-retirement',
          new Response('{"phase":"closed","old":[],"current":[]}'),
        ],
      ])
    );
    const firstOld = worker.addClient('test-client');
    const secondOld = worker.addClient('second-old');
    const newPageBeforeActivation = worker.addClient('new-before-activation');
    const claimed = worker.addClient('initially-uncontrolled', 'window', `${origin}/`, false);
    await worker.dispatchInstall();
    await worker.dispatchActivate();
    expect(worker.cacheEntries.get(url)).toBe(prior);
    expect(worker.cacheEntries.has(oldCaller)).toBe(false);
    const networkCount = worker.fetchMock.mock.calls.length;
    const denied = async (id: string, asset = url) => {
      expect(((await worker.dispatchFetch(asset, '', id)) as Response).type).toBe('error');
    };
    await denied(firstOld.id);
    await worker.dispatchMessage(firstOld, replacedApp.source);
    await worker.dispatchMessage(secondOld, replacedApp.source);
    await worker.dispatchMessage(claimed, replacedApp.source);
    await worker.dispatchMessage(newPageBeforeActivation);
    const newClient = worker.addClient('new-after-activation');
    await worker.dispatchMessage(newClient, replacedApp.source);
    for (const id of [newClient.id, claimed.id, newPageBeforeActivation.id, '']) await denied(id);

    await expect(worker.dispatchFetch(url, '', firstOld.id)).resolves.toBe(prior);
    await expect(worker.dispatchFetch(url, '', secondOld.id)).resolves.toBe(prior);
    const dedicated = worker.addClient('old-worker', 'worker', origin + replacedWorkerPath);
    const otherWorker = worker.addClient('different-worker', 'worker', archivedWorker);
    const uncontrolledWorker = worker.addClient(
      'outside-worker',
      'worker',
      origin + replacedWorkerPath,
      false
    );
    await expect(worker.dispatchFetch(url, '', dedicated.id)).resolves.toBe(prior);
    await denied(otherWorker.id);
    await denied(uncontrolledWorker.id);
    await denied(firstOld.id, origin + '/assets/conversion-pipeline.D3cmESmf.js');
    worker.cacheEntries.set(
      url,
      assetResponse(url, { body: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 1]) })
    );
    await denied(firstOld.id);
    worker.cacheEntries.set(url, prior);
    expect(worker.fetchMock).toHaveBeenCalledTimes(networkCount);

    const shared = origin + '/assets/preload-helper.7y9sWmk5.js';
    worker.cacheEntries.set(shared, assetResponse(shared));
    for (let entry = worker.cacheEntries.size; entry < 64; entry++) {
      const ordinary = assetUrl(`existing-${entry}`);
      worker.cacheEntries.set(ordinary, assetResponse(ordinary));
    }
    await worker.dispatchFetch(assetUrl('incoming'), '', newClient.id);
    expect(worker.cacheEntries.size).toBe(64);
    expect(worker.cacheEntries.get(url)).toBe(prior);
    expect(worker.cacheEntries.has(shared)).toBe(true);

    const restarted = loadServiceWorker(worker.cacheStores, true);
    restarted.addClient(secondOld.id);
    restarted.removeClient(firstOld.id);
    await expect(restarted.dispatchFetch(url, '', secondOld.id)).resolves.toBe(prior);
    restarted.removeClient(secondOld.id);
    restarted.addClient(newClient.id);
    restarted.failDelete(url);
    await restarted.dispatchMessage(newClient);
    expect(restarted.cacheEntries.has(url)).toBe(true);
    expect(((await restarted.dispatchFetch(url, '', newClient.id)) as Response).type).toBe('error');
    const retry = loadServiceWorker(worker.cacheStores, true);
    await retry.dispatchMessage(retry.addClient(newClient.id));
    expect(retry.cacheEntries.has(url)).toBe(false);
    expect(retry.cacheEntries.has(shared)).toBe(true);
    expect(restarted.fetchMock).not.toHaveBeenCalled();
    expect(retry.fetchMock).not.toHaveBeenCalled();
  });

  it('preserves warmed assets when controllerchange reaches the worker before activation', async () => {
    const worker = loadServiceWorker(undefined, true);
    const overlap = origin + replacedGifPath;
    const onlyReplacement = origin + '/assets/conversion-pipeline.D3cmESmf.js';
    const prior = assetResponse(overlap, { body: replacedGif });
    const pipeline = assetResponse(onlyReplacement);
    worker.staticCacheEntries.set(`${origin}/`, documentResponse(replacedDocument));
    worker.cacheEntries.set(overlap, prior);
    worker.cacheEntries.set(onlyReplacement, pipeline);
    worker.cacheStores.set(
      'dropconvert-retire-7d9e0f1b',
      new Map([
        [
          origin + '/.dropconvert-retirement',
          new Response('{"phase":"closed","old":[],"current":[]}'),
        ],
      ])
    );
    const tab = worker.addClient('test-client');
    await worker.dispatchInstall();

    const earlyNetwork = worker.fetchMock.mock.calls.length;
    await worker.dispatchMessage(tab, replacedApp.source);
    const earlyCurrent = worker.addClient(
      'incoming-before-activate',
      'window',
      `${origin}/`,
      false
    );
    await worker.dispatchMessage(earlyCurrent);
    expect(worker.messages.at(-1)).toMatchObject({ phase: 'retired-pending-sweep' });
    expect(((await worker.dispatchFetch(overlap, '', tab.id)) as Response).type).toBe('error');
    expect(worker.cacheEntries.get(overlap)).toBe(prior);
    expect(worker.cacheEntries.get(onlyReplacement)).toBe(pipeline);
    expect(worker.fetchMock).toHaveBeenCalledTimes(earlyNetwork);

    await worker.dispatchActivate();
    await worker.dispatchMessage(tab, replacedApp.source);
    await expect(worker.dispatchFetch(overlap, '', tab.id)).resolves.toBe(prior);
  });

  it.each(['02f first', '7d first', '02f skipped'] as const)(
    'retains identically pinned shared assets until both predecessor cohorts release them (%s)',
    async (order) => {
      const worker = loadServiceWorker(undefined, true);
      const overlap = origin + replacedGifPath;
      const onlyReplacement = origin + '/assets/conversion-pipeline.D3cmESmf.js';
      const shared = assetResponse(overlap, { body: replacedGif });
      worker.staticCacheEntries.set(
        `${origin}/`,
        documentResponse(order === '02f skipped' ? 'different immediate shell' : replacedDocument)
      );
      worker.cacheEntries.set(overlap, shared);
      worker.cacheEntries.set(onlyReplacement, assetResponse(onlyReplacement));
      worker.cacheEntries.set(oldCaller, assetResponse(oldCaller));
      const legacy = worker.addClient('legacy');
      const replacement = worker.addClient('test-client');
      const uncontrolled = worker.addClient('uncontrolled', 'window', `${origin}/`, false);
      worker.cacheStores.set(
        'dropconvert-retire-7d9e0f1b',
        new Map([
          [
            origin + '/.dropconvert-retirement',
            new Response(
              JSON.stringify({ phase: 'grace', old: [legacy.id], current: [replacement.id] })
            ),
          ],
        ])
      );
      await worker.dispatchInstall();
      await worker.dispatchActivate();

      const legacyWorker = worker.addClient('legacy-worker', 'worker', archivedWorker);
      const incoming = worker.addClient('incoming');
      const networkBefore = worker.fetchMock.mock.calls.length;
      const denied = async (id: string, url = overlap) => {
        expect(((await worker.dispatchFetch(url, '', id)) as Response).type).toBe('error');
      };
      await denied(replacement.id);
      await denied(incoming.id);
      await denied(uncontrolled.id);
      await worker.dispatchMessage(replacement, replacedApp.source);
      await expect(worker.dispatchFetch(overlap, '', legacy.id)).resolves.toBe(shared);
      await expect(worker.dispatchFetch(overlap, '', legacyWorker.id)).resolves.toBe(shared);
      await denied(legacy.id, onlyReplacement);
      worker.cacheEntries.set(
        overlap,
        assetResponse(overlap, { body: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 1]) })
      );
      await denied(legacy.id);
      await denied(legacyWorker.id);
      worker.cacheEntries.set(overlap, shared);
      worker.removeClient(uncontrolled.id);
      if (order === '02f skipped') {
        await denied(replacement.id);
        expect(worker.cacheEntries.has(onlyReplacement)).toBe(false);
        worker.removeClient(replacement.id);
      } else {
        await expect(worker.dispatchFetch(overlap, '', replacement.id)).resolves.toBe(shared);
        if (order === '7d first') {
          worker.removeClient(legacy.id);
          await worker.dispatchMessage(incoming);
          expect(worker.cacheEntries.has(oldCaller)).toBe(false);
          await expect(worker.dispatchFetch(overlap, '', replacement.id)).resolves.toBe(shared);
          await denied(legacyWorker.id);
        }
        worker.removeClient(replacement.id);
        await worker.dispatchMessage(incoming);
        if (order === '7d first') expect(worker.cacheEntries.has(onlyReplacement)).toBe(false);
      }
      if (order !== '7d first') {
        await expect(worker.dispatchFetch(overlap, '', legacy.id)).resolves.toBe(shared);
        worker.removeClient(legacy.id);
        await worker.dispatchMessage(incoming);
      }
      expect(worker.cacheEntries.has(overlap)).toBe(false);
      expect(worker.cacheEntries.has(onlyReplacement)).toBe(false);
      expect(worker.cacheEntries.has(oldCaller)).toBe(false);
      await denied(incoming.id);
      expect(worker.fetchMock).toHaveBeenCalledTimes(networkBefore);
    }
  );

  it('accepts a late 02f cue from a hidden window recorded in the earlier census', async () => {
    const worker = loadServiceWorker(undefined, true);
    const pipeline = origin + replacedPipelinePath;
    const overlap = origin + replacedGifPath;
    const priorPipeline = assetResponse(pipeline, { body: replacedPipeline });
    const priorGif = assetResponse(overlap, { body: replacedGif });
    const archived = assetResponse(oldCaller);
    worker.staticCacheEntries.set(`${origin}/`, documentResponse(replacedDocument));
    worker.cacheEntries.set(pipeline, priorPipeline);
    worker.cacheEntries.set(overlap, priorGif);
    worker.cacheEntries.set(oldCaller, archived);
    const hidden = worker.addClient('hidden-02f');
    const legacy = worker.addClient('7d');
    worker.cacheStores.set(
      'dropconvert-retire-7d9e0f1b',
      new Map([
        [
          retirementKey,
          new Response(
            JSON.stringify({
              phase: 'grace',
              old: [hidden.id, legacy.id],
              current: [],
            })
          ),
        ],
      ])
    );
    await worker.dispatchInstall();
    await worker.dispatchActivate();

    expect(((await worker.dispatchFetch(pipeline, 'script', hidden.id)) as Response).type).toBe(
      'error'
    );
    await worker.dispatchMessage(hidden, replacedApp.source);
    await expect(worker.dispatchFetch(pipeline, 'script', hidden.id)).resolves.toBe(priorPipeline);
    expect(((await worker.dispatchFetch(oldCaller, 'script', hidden.id)) as Response).type).toBe(
      'error'
    );
    await expect(worker.dispatchFetch(overlap, '', legacy.id)).resolves.toBe(priorGif);
    await expect(worker.dispatchFetch(oldCaller, 'script', legacy.id)).resolves.toBe(archived);
    expect(((await worker.dispatchFetch(pipeline, 'script', legacy.id)) as Response).type).toBe(
      'error'
    );
  });

  it('retries a failed activation write from a current-page cue and closes grace', async () => {
    const worker = loadServiceWorker(undefined, true);
    const url = origin + replacedGifPath;
    worker.staticCacheEntries.set(`${origin}/`, documentResponse(replacedDocument));
    worker.cacheEntries.set(url, assetResponse(url, { body: replacedGif }));
    worker.cacheStores.set(
      'dropconvert-retire-7d9e0f1b',
      new Map([[retirementKey, new Response('{"phase":"closed","old":[],"current":[]}')]])
    );
    const old = worker.addClient('test-client');
    worker.setReplacementWriteFailure(true);
    await worker.dispatchInstall();
    await worker.dispatchActivate();

    const current = worker.addClient('current');
    await worker.dispatchMessage(old, replacedApp.source);
    expect(((await worker.dispatchFetch(url, '', old.id)) as Response).type).toBe('error');
    await worker.dispatchMessage(current);
    expect(worker.cacheEntries.has(url)).toBe(true);
    expect(worker.messages.at(-1)).toMatchObject({ phase: 'retired-pending-sweep' });

    worker.setReplacementWriteFailure(false);
    await worker.dispatchMessage(current);
    expect(worker.cacheEntries.has(url)).toBe(false);
    expect(worker.messages.at(-1)).toMatchObject({ phase: 'retired' });
    const status = worker.cacheStores.get(replacementCacheName)?.get(retirementKey) as Response;
    expect(await status.clone().json()).toEqual({ candidates: [], confirmed: [] });
    await worker.dispatchMessage(old, replacedApp.source);
    expect(((await worker.dispatchFetch(url, '', old.id)) as Response).type).toBe('error');
  });

  it.each(['missing', 'corrupt'])(
    'recovers a %s replacement record after restart while keeping authorized 7d overlap',
    async (record) => {
      const former = loadServiceWorker(undefined, true);
      const overlap = origin + replacedGifPath;
      const pipeline = origin + replacedPipelinePath;
      former.staticCacheEntries.set(`${origin}/`, documentResponse(replacedDocument));
      const priorGif = assetResponse(overlap, { body: replacedGif });
      former.cacheEntries.set(overlap, priorGif);
      former.cacheEntries.set(pipeline, assetResponse(pipeline, { body: replacedPipeline }));
      former.cacheStores.set(
        'dropconvert-retire-7d9e0f1b',
        new Map([[retirementKey, new Response('{"phase":"grace","old":["7d"],"current":[]}')]])
      );
      former.addClient('7d');
      await former.dispatchInstall();
      await former.dispatchActivate();

      const metadata = former.cacheStores.get(replacementCacheName)!;
      if (record === 'missing') metadata.delete(retirementKey);
      else metadata.set(retirementKey, new Response('corrupt'));
      const worker = loadServiceWorker(former.cacheStores, true);
      const legacy = worker.addClient('7d');
      const old = worker.addClient('test-client');
      const current = worker.addClient('current');
      await worker.dispatchMessage(old, replacedApp.source);
      expect(((await worker.dispatchFetch(pipeline, 'script', old.id)) as Response).type).toBe(
        'error'
      );
      await worker.dispatchMessage(current);
      expect(worker.cacheEntries.has(pipeline)).toBe(false);
      await expect(worker.dispatchFetch(overlap, '', legacy.id)).resolves.toBe(priorGif);
      worker.removeClient(legacy.id);
      await worker.dispatchMessage(current);
      expect(worker.cacheEntries.has(overlap)).toBe(false);
      expect(worker.fetchMock).not.toHaveBeenCalled();
    }
  );

  it('does not grant overlapping bytes to a legacy cohort bootstrapped without its prior shell', async () => {
    const worker = loadServiceWorker(undefined, true);
    const url = origin + replacedGifPath;
    const prior = assetResponse(url, { body: replacedGif });
    worker.staticCacheEntries.set(`${origin}/`, documentResponse(replacedDocument));
    worker.cacheEntries.set(url, prior);
    const probationary = worker.addClient('test-client');
    await worker.dispatchInstall();
    await worker.dispatchActivate();
    expect(((await worker.dispatchFetch(url, '', probationary.id)) as Response).type).toBe('error');
    await worker.dispatchMessage(probationary, replacedApp.source);
    await expect(worker.dispatchFetch(url, '', probationary.id)).resolves.toBe(prior);
  });

  it('closes replacement grace when the immediately previous shell was skipped', async () => {
    const worker = loadServiceWorker(undefined, true);
    const url = origin + replacedGifPath;
    worker.staticCacheEntries.set(
      `${origin}/`,
      documentResponse('<!doctype html><title>different</title>')
    );
    worker.cacheEntries.set(url, assetResponse(url, { body: replacedGif }));
    const client = worker.addClient('test-client');
    await worker.dispatchInstall();
    await worker.dispatchActivate();
    await worker.dispatchMessage(client, replacedApp.source);
    const networkCount = worker.fetchMock.mock.calls.length;
    expect(((await worker.dispatchFetch(url, '', client.id)) as Response).type).toBe('error');
    expect(worker.cacheEntries.has(url)).toBe(false);
    expect(worker.fetchMock).toHaveBeenCalledTimes(networkCount);
    worker.setNetworkResponse(documentResponse(replacedDocument));
    const result = await worker.dispatchFetch(`${origin}/`, 'document');
    expect(result).toMatchObject({
      body: readFileSync(join(workerBuildRoot, 'index.html'), 'utf8'),
    });
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
