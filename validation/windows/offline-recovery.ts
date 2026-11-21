// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { join } from 'node:path';

import type {
  APIResponse,
  Browser,
  BrowserContext,
  Page,
  Request as BrowserRequest,
  Response as BrowserResponse,
} from '@playwright/test';

import {
  isExecutableMediaType,
  isRetiredWebpExecutable,
  isUnexpectedWasm,
  LEGACY_WEBP_DEPLOYMENT,
  LEGACY_WEBP_WASM_ASSET,
  OWNED_VP8_ASSET,
  RETIRED_WEBP_CALLERS,
  RETIRED_WEBP_DELIVERY_FILES,
  RETIRED_WEBP_EXECUTABLES,
  RETIRED_WEBP_SHIM,
} from '../../scripts/test/retired-webp-assets.ts';
import { hasLegacyWebpInRetiredBuild } from '../../scripts/test/retired-webp-worker.ts';
import { measureColdTransfer, readBuild } from './app-update.ts';
import { instrumentOwnedInstance, parseAnimatedWebp } from './helpers/owned-vp8-product.ts';

type Build = Awaited<ReturnType<typeof readBuild>>;
type AssetFailure = { path: string; mode: '404' | 'wrong-mime' | 'network' };
type ArchivedAsset = { path: string; size: number; sha256: string };
export type RetirementOriginRequest = {
  sequence: number;
  path: string;
  target: string;
  method: string;
  distribution: string;
  requestCacheControl: string;
  disposition: 'pending' | 'finished' | 'closed';
  status: number | null;
  contentType: string | null;
  cacheControl: string | null;
};
export type RetirementOriginSnapshot = {
  distribution: string;
  paths: string[];
  overflow: boolean;
  requests: RetirementOriginRequest[];
};
export type RetirementOriginScope = boolean | 'callers';
type ArchivedOriginControl = {
  setArchivedOrigin: (archive: string | null, assets: readonly ArchivedAsset[]) => Promise<void>;
  archivedOriginSnapshot: (scope: RetirementOriginScope) => RetirementOriginSnapshot;
};
type StartedServer = {
  server: Server;
  url: string;
  setDistribution: (relativePath: string) => Promise<void>;
  setAssetFailure: (failure: AssetFailure | null) => void;
  assetFailureRequests: { path: string; mode: string }[];
  observedAssetRequests: string[];
  observedAssetOverflow: boolean;
  missingAssetResponses: { path: string; status: number }[];
};
type RecoveryConfig = {
  schemaVersion: number;
  mode: string;
  baseline: string;
  baselineSourceSha: string;
  baselineTreeSha: string;
  buildA: string;
  sourceA: string;
  treeA: string;
  sourceB: string;
  treeB: string;
  busyFixture: string;
  busyFixtureSha256: string;
  assertionProbe?: boolean;
};
type PageEvents = {
  pageErrors: string[];
  consoleErrors: { text: string; path: string | null }[];
  consoleWarnings: string[];
  requestedAssets: string[];
  failedRequests: { path: string; error: string | undefined }[];
  failedResponses: { path: string; status: number }[];
  overflow: boolean;
};
type WorkerAssetMessage = { path: string; status: number; reason: string };
type RetirementEvent = { kind: 'visibility' | 'worker'; value: string; atMs: number };
type ActiveConversionObservation = {
  timeOrigin: number;
  progress: number;
  stopVisible: boolean;
  resultVisible: boolean;
  errorVisible: boolean;
};
type LogExportInteraction = {
  buttonClicks: number;
  downloadAnchors: { blobHref: boolean; logFilename: boolean; connectedAtClick: boolean }[];
};
type RecoveryCheck = { id: string; status: string; events?: PageEvents };
type ColdTransfer = Awaited<ReturnType<typeof measureColdTransfer>>;
type RecoveryDiagnostics = {
  profile: string;
  status: string;
  checks: RecoveryCheck[];
  builds: Record<string, object>;
  coldTransfer: {
    encoding: string;
    budgetBytesExclusive: number;
    baseline: ColdTransfer | null;
    B: ColdTransfer | null;
  };
  activeCheck: string | null;
  failure: string | null;
  assertionProbe: boolean;
  busyFixture?: { sha256: string; bytes: number };
  server?: {
    observedAssetRequests: string[];
    observedAssetOverflow: boolean;
    injectedAssetRequests: StartedServer['assetFailureRequests'];
    missingAssetResponses: StartedServer['missingAssetResponses'];
  };
  cleanupFailure?: string;
};
declare global {
  var __wmcUpgradeInitialController: ServiceWorker | null;
  var __wmcUpgradeControllerObservation: ActiveConversionObservation | null;
  var __wmcObserveActiveConversion: () => ActiveConversionObservation;
  var __wmcUpgradeAssetMessages: WorkerAssetMessage[];
  var __wmcRetirementEvents: RetirementEvent[];
  var __wmcGraceRestartController: ServiceWorker | null;
  var __wmcGraceRestartControllerChanges: number;
  var __wmcRecoveryWorkerMessages: WorkerAssetMessage[];
  var __wmcLogExportInteraction: LogExportInteraction;
  var __wmcRestoreNumberFormat: () => void;
  var __wmcBusyRecovery: {
    record: {
      sawCancellingState: boolean;
      sawDisabledCancel: boolean;
      sawProtectedReload: boolean;
    };
    observer: MutationObserver;
  };
}

function sha256(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex');
}

type InventoryFile = Build['state']['files'][number];
const STALE_ALIAS_QUERY = '?offline-acceptance=retired-alias';
export function softwareWebpInventory(files: readonly InventoryFile[]) {
  const owned = files.filter(({ path }) => OWNED_VP8_ASSET.test(path));
  const legacyWasm = files.filter(({ path }) => LEGACY_WEBP_WASM_ASSET.test(path));
  assert(owned.length <= 1 && legacyWasm.length <= 1, 'Ambiguous software WebP WASM inventory');
  const asset = owned[0] ?? legacyWasm[0];
  assert(asset, 'No inventoried software WebP encoder WASM');
  assert.equal(
    files.filter(({ sha256 }) => sha256 === asset.sha256).length,
    1,
    'Software WebP module bytes appear more than once in the executable inventory'
  );
  const legacyExecutables = files.filter(({ path, sha256 }) =>
    isRetiredWebpExecutable(path, sha256)
  );
  const unexpectedWasm = files.filter(({ path }) => isUnexpectedWasm(path));
  const family = owned.length ? 'owned-vp8' : 'wasm-webp';
  return {
    family,
    asset,
    wasmPaths: files.filter(({ path }) => path.endsWith('.wasm')).map(({ path }) => `/${path}`),
    legacyExecutables,
    unexpectedWasm,
    ownedOnly: family === 'owned-vp8' && !legacyExecutables.length && !unexpectedWasm.length,
  };
}

export { hasLegacyWebpLoader } from '../../scripts/test/retired-webp-worker.ts';

export async function forceMainSoftwareWebp(page: Page) {
  await page.addInitScript(() => {
    if (typeof OffscreenCanvas !== 'undefined')
      Object.defineProperty(OffscreenCanvas.prototype, 'convertToBlob', {
        configurable: true,
        value: undefined,
      });
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: undefined });
  });
  await page.addInitScript(instrumentOwnedInstance);
}

export function observeSoftwareWebp(page: Page, origin: string) {
  const requests: string[] = [];
  const foreignRequests: string[] = [];
  const responses: BrowserResponse[] = [];
  const observeRequest = (request: BrowserRequest) => {
    const url = new URL(request.url());
    if (!url.pathname.endsWith('.wasm') && !isRetiredWebpExecutable(url.pathname)) return;
    if (url.origin === origin) requests.push(url.pathname);
    else foreignRequests.push(url.href);
  };
  const observeResponse = (response: BrowserResponse) => {
    const url = new URL(response.url());
    if (
      url.origin === origin &&
      (url.pathname.endsWith('.wasm') || isRetiredWebpExecutable(url.pathname))
    ) {
      responses.push(response);
    }
  };
  page.on('request', observeRequest);
  page.on('response', observeResponse);
  return {
    requests,
    foreignRequests,
    responses,
    stop() {
      page.off('request', observeRequest);
      page.off('response', observeResponse);
    },
  };
}

export async function verifySoftwareWebp(
  page: Page,
  bytes: Buffer,
  inventory: ReturnType<typeof softwareWebpInventory>,
  traffic: ReturnType<typeof observeSoftwareWebp>,
  { offline = false, exactLegacyLoader = false } = {}
) {
  const { asset, family } = inventory;
  const path = `/${asset.path}`;
  assert.deepEqual(
    traffic.foreignRequests,
    [],
    'Forced conversion requested a foreign encoder asset'
  );
  assert(
    traffic.requests.every(
      (request) => !request.endsWith('.wasm') || inventory.wasmPaths.includes(request)
    ),
    'Forced conversion requested WASM absent from the verified inventory'
  );
  assert(traffic.requests.includes(path), `${family} was not requested by the forced conversion`);
  const responses = traffic.responses.filter((entry) => new URL(entry.url()).pathname === path);
  assert(responses.length > 0, `Forced conversion got no response for ${path}`);
  for (const response of responses) {
    assert.equal(response.status(), 200);
    assert.equal(response.request().redirectedFrom(), null);
    assert.match(response.headers()['content-type'] ?? '', /^application\/wasm(?:\s*;|$)/i);
    const wasm = await response.body();
    assert.equal(wasm.subarray(0, 8).toString('hex'), '0061736d01000000');
    assert.equal(wasm.length, asset.size, 'Requested encoder WASM size differs from inventory');
    assert.equal(
      sha256(wasm),
      asset.sha256,
      'Requested encoder WASM digest differs from inventory'
    );
    if (offline)
      assert(response.fromServiceWorker(), 'Offline encoder WASM bypassed the service worker');
  }
  const legacyLoader = exactLegacyLoader ? await verifyLegacyLoader(traffic) : undefined;
  const abi = await page.evaluate(() => {
    const probe = Reflect.get(globalThis, '__wmcVp8AbiProbe');
    if (!probe) throw new Error('The main-document ABI observer did not run');
    const { successfulBeginCalls, stepCalls } = probe;
    return { successfulBeginCalls, stepCalls } as {
      successfulBeginCalls: number;
      stepCalls: number;
    };
  });
  if (family === 'owned-vp8') {
    assert(
      abi.successfulBeginCalls > 0 && abi.stepCalls > 0,
      'Owned VP8 did not execute begin/step'
    );
    assert(
      traffic.requests.every((request) => !isRetiredWebpExecutable(request)),
      'Owned conversion requested a legacy WebP executable'
    );
  } else {
    assert.equal(abi.successfulBeginCalls, 0);
    assert.equal(abi.stepCalls, 0);
  }
  const parsed = parseAnimatedWebp(bytes);
  assert(parsed.frames.length > 1, 'Forced software output is not a multi-frame animation');
  const decoded = await page.evaluate(
    async ({ data, frameCount }) => {
      const decoder = new ImageDecoder({
        data: new Uint8Array(data),
        type: 'image/webp',
        preferAnimation: true,
      });
      try {
        await decoder.tracks.ready;
        if (decoder.tracks.selectedTrack?.frameCount !== frameCount)
          throw new Error('Decoder did not expose every parsed frame');
        for (let frameIndex = 0; frameIndex < frameCount; ++frameIndex) {
          const { complete, image } = await decoder.decode({
            frameIndex,
            completeFramesOnly: true,
          });
          image.close();
          if (!complete) throw new Error(`Software WebP frame ${frameIndex} was incomplete`);
        }
        return frameCount;
      } finally {
        decoder.close();
      }
    },
    { data: [...bytes], frameCount: parsed.frames.length }
  );
  return {
    family,
    asset,
    abi,
    requested: [...new Set(traffic.requests)],
    fromServiceWorker: responses.every((response) => response.fromServiceWorker()),
    ...(legacyLoader ? { legacyLoader } : {}),
    decodedFrames: decoded,
    outputBytes: bytes.length,
    outputSha256: sha256(bytes),
  };
}

async function verifyLegacyLoader(traffic: ReturnType<typeof observeSoftwareWebp>) {
  const asset = LEGACY_WEBP_DEPLOYMENT.files[0];
  const path = `/${asset.path}`;
  const responses = traffic.responses.filter(
    (response) => new URL(response.url()).pathname === path
  );
  assert(
    responses.length > 0 && traffic.requests.includes(path),
    'No archived main WebP loader response'
  );
  for (const response of responses) {
    assert.equal(response.status(), 200);
    assert.equal(response.request().redirectedFrom(), null);
    assert.match(response.headers()['content-type'] ?? '', /(?:javascript|ecmascript)/i);
    const bytes = await response.body();
    assert.equal(bytes.length, asset.size);
    assert.equal(sha256(bytes), asset.sha256, 'Archived main WebP loader bytes changed');
  }
  return asset;
}

export function assertWorkerUpdateOutcome(
  priorWorkerSha256: string,
  currentWorkerSha256: string,
  {
    resultControllerChanged,
    activeControllerChanged,
  }: {
    resultControllerChanged: boolean;
    activeControllerChanged: boolean;
  }
) {
  const expectedChange = priorWorkerSha256 !== currentWorkerSha256;
  assert.equal(
    resultControllerChanged,
    expectedChange,
    'Retained result tab controller did not match the verified worker bytes'
  );
  assert.equal(
    activeControllerChanged,
    expectedChange,
    'Active conversion tab controller did not match the verified worker bytes'
  );
  return expectedChange ? 'changed-worker-claimed' : 'byte-identical-kept-controller';
}

async function readResultDownload(page: Page, selector = '[data-testid="download-result-button"]') {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator(selector).click(),
  ]);
  const stream = await download.createReadStream();
  assert(stream, 'Retained result download has no readable stream');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function startForcedWebp(page: Page, fixture: string) {
  await page.locator('[data-testid="option-format-webp"]').click();
  await page.locator('[data-testid="file-input"]').setInputFiles(fixture);
  await page.locator('[data-testid="convert-button"]').click();
  const proceed = page.locator('[data-testid="modal-confirm-button"]');
  if (await proceed.isVisible()) await proceed.click();
}

async function convertAndVerifySoftwareWebp(
  page: Page,
  origin: string,
  fixture: string,
  inventory: ReturnType<typeof softwareWebpInventory>,
  offline = false,
  exactLegacyLoader = false
) {
  const traffic = observeSoftwareWebp(page, origin);
  try {
    await startForcedWebp(page, fixture);
    await page
      .locator('[data-testid="result-section"]')
      .waitFor({ state: 'visible', timeout: 120_000 });
    return await verifySoftwareWebp(page, await readResultDownload(page), inventory, traffic, {
      offline,
      exactLegacyLoader,
    });
  } finally {
    traffic.stop();
  }
}

export function selectCachedRetiredExecutableKeys(
  entries: { cache: string; request: string }[],
  knownPaths: string[] = []
) {
  return entries
    .filter(({ cache }) => cache.startsWith('dropconvert-'))
    .map(({ cache, request }) => {
      const url = new URL(request);
      return { cache, path: url.pathname, search: url.search };
    })
    .filter(({ path }) => isRetiredWebpExecutable(path) || knownPaths.includes(path))
    .sort(
      (a, b) =>
        a.cache.localeCompare(b.cache) ||
        a.path.localeCompare(b.path) ||
        a.search.localeCompare(b.search)
    );
}

async function cachedLegacyExecutableKeys(page: Page, knownPaths: string[] = []) {
  const paths = await page.evaluate(async () => {
    const entries = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith('dropconvert-')) continue;
      for (const request of await (await caches.open(name)).keys())
        entries.push({ cache: name, request: request.url });
    }
    return entries;
  });
  return selectCachedRetiredExecutableKeys(paths, knownPaths);
}

async function cachedLegacyExecutablePaths(page: Page, knownPaths: string[] = []) {
  return [
    ...new Set((await cachedLegacyExecutableKeys(page, knownPaths)).map(({ path }) => path)),
  ].sort();
}

export function selectPredecessorAssetSet(
  prior: readonly ArchivedAsset[],
  current: readonly ArchivedAsset[]
) {
  const hashedPath = /^assets\/[^/]+[.-][\w-]{8}\.(?:js|css|wasm)$/;
  const currentHashed = current.filter(({ path }) => hashedPath.test(path));
  const newAssets = new Map(currentHashed.map((asset) => [asset.path, asset]));
  const oldOnly: ArchivedAsset[] = [];
  const shared: ArchivedAsset[] = [];
  const seen = new Set<string>();
  assert.equal(newAssets.size, currentHashed.length, 'Duplicate current hashed path');
  for (const asset of prior.filter(({ path }) => hashedPath.test(path))) {
    assert(!seen.has(asset.path), `Duplicate predecessor hashed path: ${asset.path}`);
    seen.add(asset.path);
    const next = newAssets.get(asset.path);
    if (!next) oldOnly.push(asset);
    else {
      assert.equal(next.sha256, asset.sha256, `Shared hashed path changed digest: ${asset.path}`);
      assert.equal(next.size, asset.size, `Shared hashed path changed extent: ${asset.path}`);
      shared.push(asset);
    }
  }
  return { oldOnly, shared };
}

type PredecessorAssets = ReturnType<typeof selectPredecessorAssetSet>;

async function snapshotPredecessorCaches(page: Page, assets: PredecessorAssets) {
  return page.evaluate(async ({ oldOnly, shared }) => {
    const oldPaths = new Set(oldOnly.map((asset) => '/' + asset.path));
    const sharedPaths = new Map(shared.map((asset) => ['/' + asset.path, asset]));
    const oldKeys = [];
    const sharedKeys = [];
    const navigation = [];
    const cacheNames = (await caches.keys())
      .filter((name) => /^dropconvert-(?:static|dynamic)-/.test(name))
      .sort();
    for (const name of cacheNames) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const url = new URL(request.url);
        if (url.origin !== location.origin) continue;
        const { pathname: path, search } = url;
        const key = { cache: name, path, search };
        const expected = sharedPaths.get(path);
        const isNavigation = path === '/' || path === '/index.html';
        if (oldPaths.has(path)) oldKeys.push(key);
        else if (expected || isNavigation) {
          const response = await cache.match(request);
          if (!response?.ok) continue;
          const bytes = await response.arrayBuffer();
          const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
          const sha256 = [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
          const row = { ...key, size: bytes.byteLength, sha256 };
          if (isNavigation) navigation.push(row);
          else if (expected && row.sha256 === expected.sha256 && row.size === expected.size)
            sharedKeys.push(row);
        }
      }
    }
    return { cacheNames, oldKeys, sharedKeys, navigation };
  }, assets);
}

type PredecessorCacheSnapshot = Awaited<ReturnType<typeof snapshotPredecessorCaches>>;

function assertPredecessorCacheSettlement(
  settled: PredecessorCacheSnapshot,
  beforeClose: PredecessorCacheSnapshot,
  priorIndexSha256: string,
  currentIndexSha256: string
) {
  assert.deepEqual(settled.oldKeys, [], 'An archived-only key survived retirement');
  assert(
    beforeClose.sharedKeys.length > 0,
    'No actual shared asset was available as a preservation control'
  );
  for (const key of beforeClose.sharedKeys)
    assert(
      settled.sharedKeys.some(
        (row) =>
          row.cache === key.cache &&
          row.path === key.path &&
          row.search === key.search &&
          row.size === key.size &&
          row.sha256 === key.sha256
      ),
      `A shared cache key changed or disappeared: ${key.cache} ${key.path}${key.search}`
    );
  assert(
    !settled.navigation.some(({ sha256 }) => sha256 === priorIndexSha256),
    'A stable URL still holds the archived document'
  );
  assert(
    settled.navigation.some(({ sha256 }) => sha256 === currentIndexSha256),
    'No exact current offline shell survived'
  );
}

async function observeCurrentClientRetirement(page: Page, sourceSha: string) {
  await page.addInitScript((generation) => {
    globalThis.__wmcRetirementEvents = [];
    const record = (kind: RetirementEvent['kind'], value: string) => {
      if (globalThis.__wmcRetirementEvents.length < 128)
        globalThis.__wmcRetirementEvents.push({ kind, value, atMs: performance.now() });
    };
    document.addEventListener('visibilitychange', (event) => {
      if (event.isTrusted) record('visibility', document.visibilityState);
    });
    navigator.serviceWorker?.addEventListener('message', (event) => {
      if (!event.isTrusted || event.source !== navigator.serviceWorker.controller) return;
      const data = event.data;
      if (
        data?.type === 'dropconvert:retirement-state' &&
        data.generation === generation &&
        (data.phase === 'grace' ||
          data.phase === 'retired-pending-sweep' ||
          data.phase === 'retired')
      )
        record('worker', data.phase);
    });
  }, sourceSha);
}

async function seedArchivedCacheAliases(
  page: Page,
  bundleRoot: string,
  archive: string,
  assets: readonly ArchivedAsset[] = RETIRED_WEBP_EXECUTABLES
) {
  // Add known physical query keys to the old profile before changing origin.
  // Retain the real requests and canonical entries warmed by both old tabs.
  const entries = await Promise.all(
    assets.map(async (asset) => {
      const bytes = await readFile(join(bundleRoot, archive, asset.path));
      assert.equal(bytes.length, asset.size);
      assert.equal(sha256(bytes), asset.sha256);
      return {
        url: assetPath(asset) + STALE_ALIAS_QUERY,
        contentType: asset.path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        bytes: bytes.toString('base64'),
      };
    })
  );
  await page.evaluate(async (assets) => {
    const [cacheName, ...other] = (await caches.keys()).filter((name) =>
      name.startsWith('dropconvert-dynamic-')
    );
    if (!cacheName || other.length) throw new Error('Expected the one warmed old dynamic cache');
    const cache = await caches.open(cacheName);
    await Promise.all(
      assets.map(({ url, contentType, bytes }) =>
        cache.put(
          url,
          new Response(
            Uint8Array.from(atob(bytes), (value) => value.charCodeAt(0)),
            { headers: { 'Content-Type': contentType } }
          )
        )
      )
    );
  }, entries);
  const paths = assets.map(assetPath);
  const keys = (await cachedLegacyExecutableKeys(page, paths)).filter(
    ({ path, search }) => paths.includes(path) && search === STALE_ALIAS_QUERY
  );
  assert.deepEqual(keys.map(({ path }) => path).sort(), paths.sort());
  return keys;
}

export type RemovalVerification = {
  coreSha: string;
  wasmSha256: string;
};

async function verifyAppDocument(
  response: BrowserResponse | null,
  build: Build,
  fromServiceWorker = false
) {
  assert(response, 'No application document response');
  assert.equal(response.status(), 200);
  assert.match(response.headers()['content-type'] ?? '', /^text\/html\b/i);
  assert.equal(
    sha256(await response.body()),
    build.indexSha256,
    'Application document differs from its build'
  );
  if (fromServiceWorker)
    assert(response.fromServiceWorker(), 'Offline document bypassed the service worker');
}

function observeArchivedCallerResponses(context: BrowserContext, baseUrl: string) {
  const origin = new URL(baseUrl).origin;
  const responses: BrowserResponse[] = [];
  let overflow = false;
  const record = (response: BrowserResponse) => {
    const url = new URL(response.url());
    if (
      url.origin === origin &&
      RETIRED_WEBP_CALLERS.some((asset) => assetPath(asset) === url.pathname)
    ) {
      if (responses.length < 32) responses.push(response);
      else overflow = true;
    }
  };
  context.on('response', record);
  return {
    async read() {
      assert(!overflow, 'Archived caller response observation overflowed');
      return Promise.all(
        responses.map(async (response) => {
          const request = response.request();
          const path = new URL(response.url()).pathname;
          const expected = RETIRED_WEBP_CALLERS.find((asset) => assetPath(asset) === path);
          assert(expected);
          assert.equal(response.status(), 200);
          assert(isExecutableMediaType(response.headers()['content-type'] ?? ''));
          const bytes = await response.body();
          const digest = sha256(bytes);
          assert.equal(bytes.length, expected.size);
          assert.equal(digest, expected.sha256);
          return {
            path,
            requestUrl: request.url(),
            method: request.method(),
            resourceType: request.resourceType(),
            fromServiceWorker: response.fromServiceWorker(),
            serviceWorkerInitiated: Boolean(request.serviceWorker()),
            status: response.status(),
            size: bytes.length,
            sha256: digest,
          };
        })
      );
    },
    stop() {
      context.off('response', record);
    },
  };
}

async function verifyArchivedWorkerCaller(
  context: BrowserContext,
  baseUrl: string,
  build: Build,
  fixture: string
) {
  const tab = await context.newPage();
  const traffic = observeArchivedCallerResponses(context, baseUrl);
  const workerUrls = new Set<string>();
  const workerPath = assetPath(RETIRED_WEBP_CALLERS[1]);
  tab.on('worker', (worker) => workerUrls.add(worker.url()));
  try {
    await verifyAppDocument(await tab.goto(baseUrl), build);
    await tab.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    await tab.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    await tab.locator('[data-testid="option-format-gif"]').click();
    await tab.locator('[data-testid="file-input"]').setInputFiles(fixture);
    await tab.locator('[data-testid="convert-button"]').click();
    const confirm = tab.locator('[data-testid="modal-confirm-button"]');
    if (await confirm.isVisible()) await confirm.click();
    await tab
      .locator('[data-testid="result-section"]')
      .waitFor({ state: 'visible', timeout: 120_000 });
    const expected = new URL(workerPath, baseUrl).href;
    const responses = await traffic.read();
    const observedExactWorker = workerUrls.has(expected);
    return {
      route: 'old application GIF conversion',
      workerUrls: [...workerUrls],
      observedExactWorker,
      byteEvidence:
        observedExactWorker && responses.some(({ requestUrl }) => requestUrl === expected)
          ? 'observed'
          : 'unverified',
      responses,
    };
  } finally {
    traffic.stop();
    await tab.close();
  }
}

async function verifyArchivedAssetFetches(
  page: Page,
  available: boolean,
  cache: 'default' | 'no-store' = 'no-store',
  fromServiceWorker = false,
  assets: readonly ArchivedAsset[] = LEGACY_WEBP_DEPLOYMENT.files,
  search = ''
) {
  const paths = assets.map((asset) => assetPath(asset) + search);
  const observations = new Map<string, BrowserRequest>();
  const origin = new URL(page.url()).origin;
  const record = (request: BrowserRequest) => {
    const url = new URL(request.url());
    if (
      url.origin === origin &&
      paths.includes(url.pathname + url.search) &&
      request.resourceType() === 'fetch'
    )
      observations.set(url.pathname + url.search, request);
  };
  page.on('request', record);
  try {
    const rows = await page.evaluate(
      async ({ paths, cache }) =>
        Promise.all(
          paths.map(async (path) => {
            let response: Response;
            try {
              response = await fetch(path, { cache, redirect: 'error' });
            } catch (error) {
              if (!(error instanceof TypeError)) throw error;
              return { path, fetchRejected: true as const };
            }
            const bytes = await response.arrayBuffer();
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
            return {
              path,
              status: response.status,
              contentType: response.headers.get('content-type') ?? '',
              cacheControl: response.headers.get('cache-control') ?? '',
              size: bytes.byteLength,
              sha256: [...digest].map((value) => value.toString(16).padStart(2, '0')).join(''),
            };
          })
        ),
      { paths, cache }
    );
    return await Promise.all(
      rows.map(async (row, index) => {
        const asset = assets[index];
        assert(asset && row.path === assetPath(asset) + search);
        const request = observations.get(row.path);
        assert(request, `No browser request observed for ${row.path}`);
        assert.equal(request.redirectedFrom(), null);
        const response = await request.response();
        const serviceWorkerResponse = response?.fromServiceWorker() ?? null;
        const failure = request.failure()?.errorText ?? null;
        if (available) {
          assert('status' in row, `Archived baseline bytes unavailable: ${row.path}`);
          assert.equal(row.status, 200);
          assert.equal(response?.status(), row.status);
          assert.match(
            row.contentType,
            asset.path.endsWith('.wasm') ? /^application\/wasm\b/i : /(?:javascript|ecmascript)/i
          );
          assert.equal(row.size, asset.size);
          assert.equal(row.sha256, asset.sha256);
          if (fromServiceWorker) assert.equal(serviceWorkerResponse, true, row.path);
        } else if ('status' in row) {
          assert.equal(row.status, 404, `Retired executable was served: ${row.path}`);
          assert.equal(response?.status(), row.status);
          assert(
            !isExecutableMediaType(row.contentType) && !/\bimmutable\b/i.test(row.cacheControl)
          );
          assert.notEqual(row.sha256, asset.sha256);
        } else {
          assert.equal(response, null, `Retired executable returned a response: ${row.path}`);
          assert(failure, `No browser request failure observed for ${row.path}`);
        }
        return {
          ...row,
          path: assetPath(asset),
          requestUrl: request.url(),
          method: request.method(),
          resourceType: request.resourceType(),
          requestCacheControl: (await request.allHeaders())['cache-control'] ?? null,
          cache,
          serviceWorkerResponse,
          failure,
        };
      })
    );
  } finally {
    page.off('request', record);
  }
}

function requireQuietOrigin(before: RetirementOriginSnapshot, after: RetirementOriginSnapshot) {
  assert(!before.overflow && !after.overflow, 'Archived origin recorder overflowed');
  assert(
    before.requests.every((row) => row.disposition !== 'pending'),
    'Prior origin requests are unsettled'
  );
  assert.deepEqual(after, before, 'Controlled retired requests reached the private origin');
}

async function retiredBrowserOriginWindow(
  page: Page,
  origin: ArchivedOriginControl,
  scope: RetirementOriginScope,
  cache: 'default' | 'no-store',
  search = ''
) {
  const assets =
    scope === 'callers'
      ? RETIRED_WEBP_CALLERS
      : scope
        ? RETIRED_WEBP_EXECUTABLES
        : LEGACY_WEBP_DEPLOYMENT.files;
  const before = origin.archivedOriginSnapshot(scope);
  const rows = await verifyArchivedAssetFetches(page, false, cache, false, assets, search);
  const after = origin.archivedOriginSnapshot(scope);
  requireQuietOrigin(before, after);
  return { before, after, rows };
}

async function readDirectArchivedOrigin(
  page: Page,
  baseUrl: string,
  origin: ArchivedOriginControl,
  assets: readonly ArchivedAsset[],
  available: boolean,
  scope: RetirementOriginScope,
  search = available ? STALE_ALIAS_QUERY : ''
) {
  const before = origin.archivedOriginSnapshot(scope);
  const rows = [];
  for (const asset of assets) {
    const path = assetPath(asset);
    const requestUrl = new URL(path + search, baseUrl).href;
    const response: APIResponse = await page.context().request.get(requestUrl, {
      maxRedirects: 0,
      failOnStatusCode: false,
      headers: { 'Cache-Control': 'no-cache' },
    });
    const bytes = await response.body();
    const { 'content-type': contentType = '', 'cache-control': cacheControl = '' } =
      response.headers();
    const status = response.status();
    const digest = sha256(bytes);
    if (available) {
      assert.equal(status, 200);
      assert(isExecutableMediaType(contentType));
      assert.match(cacheControl, /\bimmutable\b/i);
      assert.equal(bytes.length, asset.size);
      assert.equal(digest, asset.sha256);
    } else {
      assert.equal(status, 404, `Origin served retired executable ${asset.path}`);
      assert(!isExecutableMediaType(contentType) && !/\bimmutable\b/i.test(cacheControl));
      assert.notEqual(digest, asset.sha256);
    }
    rows.push({
      path,
      requestUrl,
      method: 'GET',
      requestCacheControl: 'no-cache',
      status,
      contentType,
      cacheControl,
      sha256: digest,
    });
  }
  const after = origin.archivedOriginSnapshot(scope);
  assert(!before.overflow && !after.overflow, 'Direct origin recorder overflowed');
  assert.deepEqual(after.requests.slice(0, before.requests.length), before.requests);
  const recorded = after.requests.slice(before.requests.length);
  assert.equal(recorded.length, rows.length, 'Missing or extra independent origin requests');
  for (const [index, row] of rows.entries()) {
    const record = recorded[index];
    assert(record && record.disposition === 'finished', 'Direct origin request did not settle');
    assert.equal(record.path, row.path);
    assert.equal(record.target, row.path + search);
    assert.equal(record.distribution, 'dist');
    for (const key of [
      'method',
      'requestCacheControl',
      'status',
      'contentType',
      'cacheControl',
    ] as const)
      assert.equal(record[key], row[key], `Direct origin ${key} differs from client request`);
  }
  return { before, after, rows };
}

async function verifyCallerReadmissionDenied(
  page: Page,
  baseUrl: string,
  archivedOrigin: ArchivedOriginControl,
  archive: string
) {
  const before = await retirementClientIdentity(page);
  const readDirect = (available: boolean, search: string) =>
    readDirectArchivedOrigin(
      page,
      baseUrl,
      archivedOrigin,
      RETIRED_WEBP_CALLERS,
      available,
      'callers',
      search
    );
  await archivedOrigin.setArchivedOrigin(archive, RETIRED_WEBP_CALLERS);
  let direct;
  let denied;
  try {
    direct = {
      canonical: await readDirect(true, ''),
      aliases: await readDirect(true, STALE_ALIAS_QUERY),
    };
    denied = {
      canonical: await retiredBrowserOriginWindow(page, archivedOrigin, 'callers', 'default'),
      aliases: await retiredBrowserOriginWindow(
        page,
        archivedOrigin,
        'callers',
        'no-store',
        STALE_ALIAS_QUERY
      ),
    };
    requireQuietOrigin(direct.aliases.after, denied.aliases.after);
  } finally {
    await archivedOrigin.setArchivedOrigin(null, []);
  }
  const candidate = {
    canonical: await readDirect(false, ''),
    aliases: await readDirect(false, STALE_ALIAS_QUERY),
  };
  assert.deepEqual(candidate.canonical.before, denied.aliases.after);
  assert.deepEqual(await retirementClientIdentity(page), before);
  return { client: before, direct, denied, candidate };
}

async function retirementClientIdentity(page: Page) {
  return page.evaluate(() => ({
    documentUrl: location.href,
    timeOrigin: performance.timeOrigin,
    workerUrl: navigator.serviceWorker.controller?.scriptURL ?? null,
    workerState: navigator.serviceWorker.controller?.state ?? null,
  }));
}

async function verifyFreshOfflineDuringGrace(retainedTab: Page, baseUrl: string, build: Build) {
  const context = retainedTab.context();
  const fresh = await context.newPage();
  const traffic = observeSoftwareWebp(fresh, baseUrl);
  let workersStarted = 0;
  fresh.on('worker', () => workersStarted++);
  try {
    await context.setOffline(true);
    await verifyAppDocument(await fresh.goto(baseUrl), build, true);
    await fresh.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    await fresh.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    await fresh.locator('[data-testid="offline-banner"]').waitFor({ state: 'visible' });
    assert.deepEqual(traffic.requests, [], 'Fresh offline shell eagerly requested codec assets');
    assert.deepEqual(traffic.foreignRequests, [], 'Fresh offline shell requested a foreign codec');
    assert.equal(workersStarted, 0, 'Fresh offline shell eagerly started a conversion worker');
    const [canonical, retainedOldCanonical] = await Promise.all([
      verifyArchivedAssetFetches(fresh, false, 'default', false, RETIRED_WEBP_EXECUTABLES),
      verifyArchivedAssetFetches(retainedTab, true, 'no-store', true),
    ]);
    const aliases = await verifyArchivedAssetFetches(
      fresh,
      false,
      'no-store',
      false,
      RETIRED_WEBP_EXECUTABLES,
      STALE_ALIAS_QUERY
    );
    const retainedPaths = await cachedLegacyExecutablePaths(fresh);
    assert(LEGACY_WEBP_DEPLOYMENT.files.every((asset) => retainedPaths.includes(assetPath(asset))));
    const callerKeys = (
      await cachedLegacyExecutableKeys(retainedTab, RETIRED_WEBP_CALLERS.map(assetPath))
    ).filter(({ cache, search }) => /^dropconvert-(?:static|dynamic)-/.test(cache) && !search);
    const residentCallers = RETIRED_WEBP_CALLERS.filter((asset) =>
      callerKeys.some(({ path }) => path === assetPath(asset))
    );
    const [callerCanonical, oldWindowCacheReads] = await Promise.all([
      verifyArchivedAssetFetches(fresh, false, 'default', false, RETIRED_WEBP_CALLERS),
      verifyArchivedAssetFetches(retainedTab, true, 'no-store', true, residentCallers),
    ]);
    const callerAliases = await verifyArchivedAssetFetches(
      fresh,
      false,
      'no-store',
      false,
      RETIRED_WEBP_CALLERS,
      STALE_ALIAS_QUERY
    );
    return {
      codec: {
        sourceSha: build.state.sourceSha,
        sha256: build.indexSha256,
        fromServiceWorker: true,
        eagerCodecRequests: 0,
        eagerConversionWorkers: workersStarted,
        denied: { canonical, aliases },
        retainedOldCanonical,
        retainedPaths,
      },
      callers: {
        denied: { canonical: callerCanonical, aliases: callerAliases },
        oldWindowCacheReads,
      },
    };
  } finally {
    traffic.stop();
    try {
      await fresh.close();
    } finally {
      await context.setOffline(false);
    }
  }
}

type GraceWorkerVersion = {
  versionId: string;
  registrationId: string;
  scriptURL: string;
  status: string;
  runningStatus: string;
  controlledClients?: string[];
  targetId?: string;
};

export function selectGraceWorkerVersion(
  versions: Iterable<GraceWorkerVersion>,
  registrationId: string,
  scriptURL: string,
  targets: readonly string[]
) {
  const matches = [...versions].filter(
    (version) =>
      version.status === 'activated' &&
      version.runningStatus === 'running' &&
      version.registrationId === registrationId &&
      version.scriptURL === scriptURL &&
      targets.length === 2 &&
      new Set(targets).size === 2 &&
      targets.every((id) => version.controlledClients?.includes(id))
  );
  return matches.length === 1 ? matches[0] : undefined;
}

async function waitForGraceObservation<T>(read: () => T | undefined, detail: string) {
  const deadline = performance.now() + 15_000;
  do {
    const found = read();
    if (found !== undefined) return found;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  } while (performance.now() < deadline);
  throw new Error(detail);
}

function unsupportedServiceWorkerProtocol(error: unknown) {
  return (
    error instanceof Error &&
    /(?:wasn't found|Method not found|unknown command)/i.test(error.message)
  );
}

async function verifyGraceWorkerRestart(page: Page, activePage: Page, workerSha256: string) {
  const tabs = [page, activePage];
  const scope = new URL('/', page.url()).href;
  const scriptURL = new URL('service-worker.js', scope).href;
  const before = await Promise.all(
    tabs.map(async (tab) => {
      const document = await tab.evaluate(async () => {
        const controller = navigator.serviceWorker.controller;
        const registration = await navigator.serviceWorker.getRegistration();
        if (
          !controller ||
          controller.state !== 'activated' ||
          registration?.active !== controller ||
          registration.installing ||
          registration.waiting
        )
          throw new Error(
            'Grace restart requires the one activated registration on both retained tabs'
          );
        globalThis.__wmcGraceRestartController = controller;
        globalThis.__wmcGraceRestartControllerChanges = 0;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          globalThis.__wmcGraceRestartControllerChanges++;
        });
        return {
          timeOrigin: performance.timeOrigin,
          scope: registration.scope,
          scriptURL: controller.scriptURL,
        };
      });
      assert.equal(document.scope, scope);
      assert.equal(document.scriptURL, scriptURL);
      return { ...document, resultSha256: sha256(await readResultDownload(tab)) };
    })
  );
  const retainedBefore = await cachedLegacyExecutableKeys(page);
  const clientSessions: Awaited<ReturnType<BrowserContext['newCDPSession']>>[] = [];
  let disableServiceWorker: (() => Promise<unknown>) | undefined;
  try {
    try {
      for (const tab of tabs) clientSessions.push(await tab.context().newCDPSession(tab));
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/CDP session is only available in Chromium/i.test(error.message)
      )
        throw error;
      return {
        status: 'unverified',
        reason: 'The installed browser has no page CDP session',
      } as const;
    }
    const [session] = clientSessions;
    assert(session);
    const targets = await Promise.all(
      clientSessions.map(
        async (client) => (await client.send('Target.getTargetInfo')).targetInfo.targetId
      )
    );
    const registrations = new Map<string, string>();
    const versions = new Map<string, GraceWorkerVersion>();
    const lifecycle: { version: GraceWorkerVersion; atMs: number }[] = [];
    session.on('ServiceWorker.workerRegistrationUpdated', ({ registrations: updates }) => {
      for (const item of updates) {
        registrations.delete(item.registrationId);
        if (!item.isDeleted) registrations.set(item.registrationId, item.scopeURL);
      }
    });
    session.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => {
      for (const version of updates) {
        if (version.scriptURL !== scriptURL) continue;
        versions.set(version.versionId, version);
        if (lifecycle.length < 128) lifecycle.push({ version, atMs: performance.now() });
      }
    });
    try {
      await session.send('ServiceWorker.enable');
    } catch (error) {
      if (!unsupportedServiceWorkerProtocol(error)) throw error;
      return {
        status: 'unverified',
        reason: 'ServiceWorker.enable unavailable in installed Chromium',
      } as const;
    }
    disableServiceWorker = () => session.send('ServiceWorker.disable');
    const worker = await waitForGraceObservation(() => {
      const ids = [...registrations].filter(([, candidateScope]) => candidateScope === scope);
      if (ids.length !== 1) return undefined;
      return selectGraceWorkerVersion(versions.values(), ids[0]?.[0] ?? '', scriptURL, targets);
    }, 'Could not observe an activated running worker controlling both retained documents');
    const commandStart = lifecycle.length;
    try {
      await session.send('ServiceWorker.stopWorker', { versionId: worker.versionId });
    } catch (error) {
      if (!unsupportedServiceWorkerProtocol(error)) throw error;
      return {
        status: 'unverified',
        reason: 'ServiceWorker.stopWorker unavailable in installed Chromium',
      } as const;
    }
    const sameVersion = (version: GraceWorkerVersion) =>
      version.versionId === worker.versionId &&
      version.registrationId === worker.registrationId &&
      version.scriptURL === scriptURL &&
      version.status === 'activated';
    const stopped = await waitForGraceObservation(
      () =>
        lifecycle
          .slice(commandStart)
          .find(({ version }) => sameVersion(version) && version.runningStatus === 'stopped'),
      'Scoped stop did not produce a stopped event for the live activated worker'
    );
    assert.equal(
      versions.get(worker.versionId)?.runningStatus,
      'stopped',
      'Worker woke before the ordinary fetch'
    );
    const wakeStart = lifecycle.length;
    const archived = await verifyArchivedAssetFetches(page, true, 'no-store', true);
    const restarted = await waitForGraceObservation(
      () =>
        lifecycle
          .slice(wakeStart)
          .find(
            ({ version }) =>
              sameVersion(version) &&
              version.runningStatus === 'running' &&
              targets.every((id) => version.controlledClients?.includes(id))
          ),
      'Ordinary offline fetch did not wake the same worker controlling the two retained tabs'
    );
    assert.deepEqual(
      [...registrations].filter(([, candidateScope]) => candidateScope === scope),
      [[worker.registrationId, scope]],
      'Scoped stop changed the registration'
    );
    const after = await Promise.all(
      tabs.map(async (tab) => {
        const document = await tab.evaluate(() => {
          const controller = navigator.serviceWorker.controller;
          return {
            timeOrigin: performance.timeOrigin,
            sameController: controller === globalThis.__wmcGraceRestartController,
            controllerChanges: globalThis.__wmcGraceRestartControllerChanges,
            scriptURL: controller?.scriptURL,
          };
        });
        return { ...document, resultSha256: sha256(await readResultDownload(tab)) };
      })
    );
    for (const [index, document] of after.entries()) {
      assert.equal(document.timeOrigin, before[index]?.timeOrigin);
      assert.equal(document.resultSha256, before[index]?.resultSha256);
      assert.equal(document.scriptURL, scriptURL);
      assert(document.sameController);
      assert.equal(document.controllerChanges, 0);
    }
    const retainedAfter = await cachedLegacyExecutableKeys(page);
    assert.deepEqual(
      retainedAfter,
      retainedBefore,
      'Grace restart rewrote physically retained asset keys'
    );
    return {
      status: 'passed',
      workerSha256,
      scope,
      registrationId: worker.registrationId,
      versionId: worker.versionId,
      scriptURL,
      targets,
      stopped,
      restarted,
      runningBeforeStop: worker,
      wake: 'ordinary retained-document offline fetch',
      archived,
      before,
      after,
      retainedAfter,
    } as const;
  } finally {
    try {
      await disableServiceWorker?.();
    } finally {
      await Promise.all(clientSessions.map((client) => client.detach()));
    }
  }
}

async function stageColdLegacyTab(page: Page, baseUrl: string, priorBuild: Build) {
  await forceMainSoftwareWebp(page);
  const traffic = observeSoftwareWebp(page, baseUrl);
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    await verifyAppDocument(await page.reload(), priorBuild, true);
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    return traffic;
  } catch (error) {
    traffic.stop();
    throw error;
  }
}

async function exerciseColdLegacyTab(
  page: Page,
  baseUrl: string,
  fixture: string,
  currentBuild: Build,
  currentSoftware: ReturnType<typeof softwareWebpInventory>,
  priorDocument: number
) {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error('Old cold tab registration disappeared');
    await registration.update();
  });
  await page.waitForFunction(
    () =>
      navigator.serviceWorker.controller?.state === 'activated' &&
      navigator.serviceWorker.controller !== globalThis.__wmcUpgradeInitialController,
    undefined,
    { timeout: 15_000 }
  );
  assert.equal(await page.evaluate(() => performance.timeOrigin), priorDocument);
  const mainLoaderUrl = new URL(assetPath(LEGACY_WEBP_DEPLOYMENT.files[0]), baseUrl).href;
  const [failed] = await Promise.all([
    page.waitForEvent('requestfailed', {
      predicate: (request) => request.url() === mainLoaderUrl,
      timeout: 30_000,
    }),
    startForcedWebp(page, fixture),
  ]);
  const failure = failed.failure()?.errorText;
  assert(failure, 'Cold legacy conversion did not fail on its archived loader');
  const error = page.locator('[data-testid="error-display"]');
  await error.waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => performance.timeOrigin), priorDocument);
  assert.equal(await page.locator('[data-testid="result-section"]').isVisible(), false);
  const recovery = page.locator('[data-testid="app-recovery-reload"]');
  await recovery.waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await recovery.isEnabled(), true);
  const [response] = await Promise.all([page.waitForNavigation(), recovery.click()]);
  await verifyAppDocument(response, currentBuild);
  assert.notEqual(await page.evaluate(() => performance.timeOrigin), priorDocument);
  await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
  const ownedWebp = await convertAndVerifySoftwareWebp(page, baseUrl, fixture, currentSoftware);
  assert.deepEqual(await cachedLegacyExecutablePaths(page), []);
  return {
    archivedSource: LEGACY_WEBP_DEPLOYMENT.sourceSha,
    failedLoader: new URL(failed.url()).pathname,
    failure,
    reload: 'in-app-recovery-action',
    ownedWebp,
  };
}

async function exerciseBuildUpgrade(
  browser: Browser,
  baseUrl: string,
  bundleRoot: string,
  smallFixture: string,
  activeFixture: string,
  setDistribution: StartedServer['setDistribution'],
  priorRelativePath = 'validation/windows/prior-dist',
  requireChangedWorker = false,
  removal?: RemovalVerification,
  archivedOrigin?: ArchivedOriginControl
) {
  // readBuild checks each emitted file against deployment-state.json, including
  // service-worker.js, before the browser uses either distribution.
  const [priorBuild, currentBuild] = await Promise.all(
    [priorRelativePath, 'dist'].map((relativePath) =>
      readBuild(bundleRoot, relativePath, async (_root, path) => join(bundleRoot, path), {
        requireCompiledSource: relativePath === 'dist' || requireChangedWorker,
        verifyInventory: true,
        exactInventory: relativePath === 'dist' || requireChangedWorker,
      })
    )
  );
  assert(priorBuild && currentBuild);
  for (const build of [priorBuild, currentBuild]) {
    const workerEntry = build.state.files.find((file) => file.path === 'service-worker.js');
    assert(workerEntry, `${build.relativePath} has no inventoried service worker`);
    assert.equal(
      build.workerSha256,
      workerEntry.sha256,
      `${build.relativePath} service worker differs from its verified inventory`
    );
  }
  const workerByteIdentical = priorBuild.workerSha256 === currentBuild.workerSha256;
  if (requireChangedWorker) {
    assert.notEqual(
      priorBuild.state.sourceSha,
      currentBuild.state.sourceSha,
      'Worker handoff requires distinct source builds'
    );
    assert(!workerByteIdentical, 'Worker handoff requires distinct emitted worker bytes');
  }
  const currentSoftware =
    requireChangedWorker && !removal ? null : softwareWebpInventory(currentBuild.state.files);
  const priorSoftware =
    currentSoftware?.family === 'owned-vp8' ? softwareWebpInventory(priorBuild.state.files) : null;
  const predecessorAssets = removal
    ? selectPredecessorAssetSet(priorBuild.state.files, currentBuild.state.files)
    : null;
  if (priorSoftware) {
    const entry = await readFile(join(bundleRoot, priorRelativePath, priorBuild.main.path));
    assert(
      entry.includes(priorBuild.state.sourceSha),
      'Prior encoder build has no compiled source identity'
    );
  }
  if (removal) {
    assert.equal(priorBuild.state.sourceSha, LEGACY_WEBP_DEPLOYMENT.sourceSha);
    assert.equal(priorBuild.state.treeSha, LEGACY_WEBP_DEPLOYMENT.treeSha);
    assert.equal(
      priorBuild.manifestSha256,
      LEGACY_WEBP_DEPLOYMENT.manifestSha256,
      'Archived baseline deployment metadata differs from verified 7d9e0f1b Pages bytes'
    );
    assert.equal(
      priorBuild.state.headersSha256,
      LEGACY_WEBP_DEPLOYMENT.headersSha256,
      'Archived baseline _headers differs from verified 7d9e0f1b Pages bytes'
    );
    assert.equal(priorBuild.state.files.length, LEGACY_WEBP_DEPLOYMENT.inventoryCount);
    const archivedFiles = priorBuild.state.files.map(({ path, size, sha256 }) => ({
      path,
      size,
      sha256,
    }));
    assert.equal(
      sha256(JSON.stringify(archivedFiles)),
      LEGACY_WEBP_DEPLOYMENT.inventorySha256,
      'Archived baseline inventory differs from verified 7d9e0f1b Pages bytes'
    );
    assert.equal(priorSoftware?.family, 'wasm-webp');
    assert(archivedOrigin, 'The private archived-origin control is required');
    assert.equal(priorBuild.main.path, RETIRED_WEBP_CALLERS[0].path);
    for (const asset of RETIRED_WEBP_DELIVERY_FILES) {
      assert.deepEqual(
        priorBuild.state.files.find(({ path }) => path === asset.path),
        asset
      );
      assert(
        !currentBuild.state.files.some(
          ({ path, sha256 }) => path === asset.path || sha256 === asset.sha256
        ),
        'Current executable inventory contains the archived path or exact payload'
      );
    }
    assert.equal(currentBuild.state.coreSha, removal.coreSha);
    assert(currentSoftware?.ownedOnly, 'Removal candidate inventory is not owned-only');
    assert.equal(currentSoftware.asset.sha256, removal.wasmSha256);
  }
  if (currentSoftware?.ownedOnly) {
    for (const { path } of currentBuild.state.files.filter(({ path }) => /\.[cm]?js$/.test(path))) {
      const bytes = await readFile(join(bundleRoot, 'dist', path));
      assert(
        !hasLegacyWebpInRetiredBuild(path, bytes, { requireRetirementMetadata: Boolean(removal) }),
        `Current executable retains a legacy WebP loader or its reference: ${path}`
      );
    }
  }
  let activePage: Page | undefined;
  let coldContext: BrowserContext | undefined;
  let coldPage: Page | undefined;
  let coldDocument: number | undefined;
  const exactLegacyLoader = Boolean(removal);
  const persistent = removal ? await prepareInstalledProfile(browser, bundleRoot) : null;
  let context: BrowserContext | undefined;
  try {
    const warm = persistent
      ? await persistent.launch()
      : { context: await browser.newContext({ locale: 'en-US', acceptDownloads: true }) };
    context = warm.context;
    const page = context.pages()[0] ?? (await context.newPage());
    if (priorSoftware) await forceMainSoftwareWebp(page);
    if (removal) await observeCurrentClientRetirement(page, currentBuild.state.sourceSha);
    const earlyCallerTraffic = removal ? observeArchivedCallerResponses(context, baseUrl) : null;
    await setDistribution(priorRelativePath);
    await page.goto(baseUrl);
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    const priorNavigation = await page.reload();
    if (removal) await verifyAppDocument(priorNavigation, priorBuild);
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    const archivedEntryResponses = earlyCallerTraffic ? await earlyCallerTraffic.read() : null;
    earlyCallerTraffic?.stop();
    if (archivedEntryResponses)
      assert(
        archivedEntryResponses.some(
          ({ path, serviceWorkerInitiated }) =>
            path === assetPath(RETIRED_WEBP_CALLERS[0]) && !serviceWorkerInitiated
        ),
        'No actual archived document entry response'
      );
    await page.waitForFunction(async () => {
      const names = await caches.keys();
      for (const name of names.filter((value) => value.startsWith('dropconvert-dynamic-'))) {
        const keys = await (await caches.open(name)).keys();
        if (keys.some((key) => new URL(key.url).pathname.endsWith('.js'))) return true;
      }
      return false;
    });
    const cached = await page.evaluate(async () => {
      for (const name of (await caches.keys()).filter((value) =>
        value.startsWith('dropconvert-dynamic-')
      )) {
        const cache = await caches.open(name);
        for (const key of await cache.keys()) {
          if (!new URL(key.url).pathname.endsWith('.js')) continue;
          const response = await cache.match(key);
          if (response)
            return {
              cacheName: name,
              url: key.url,
              bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
            };
        }
      }
      throw new Error('Prior build has no cached JS asset');
    });
    const nextAssets = new Set(await readdir(join(bundleRoot, 'dist/assets')));
    const oldOnly = priorBuild.state.files
      .filter((file) => /^assets\/[^/]+\.js$/.test(file.path))
      .map((file) => file.path.slice('assets/'.length))
      .filter((name) => !nextAssets.has(name));
    const priorForcedWebp = priorSoftware
      ? await convertAndVerifySoftwareWebp(
          page,
          baseUrl,
          smallFixture,
          priorSoftware,
          false,
          exactLegacyLoader
        )
      : null;
    const warmedArchivedAssets = removal ? await verifyArchivedAssetFetches(page, true) : null;
    if (removal) {
      coldContext = await browser.newContext({ locale: 'en-US', acceptDownloads: true });
      coldPage = await coldContext.newPage();
      const tab = coldPage;
      const traffic = await stageColdLegacyTab(tab, baseUrl, priorBuild);
      try {
        const pipeline = emittedAsset(priorBuild, /^assets\/conversion-pipeline[.-][\w-]{8}\.js$/);
        // A real GIF conversion loads the prior main pipeline without loading WebP.
        const pipelineResponse = tab.waitForResponse(
          (response) => new URL(response.url()).pathname === assetPath(pipeline),
          { timeout: 120_000 }
        );
        const [, served] = await Promise.all([
          (async () => {
            await tab.locator('[data-testid="option-format-gif"]').click();
            await tab.locator('[data-testid="file-input"]').setInputFiles(smallFixture);
            await tab.locator('[data-testid="convert-button"]').click();
            const confirm = tab.locator('[data-testid="modal-confirm-button"]');
            if (await confirm.isVisible()) await confirm.click();
          })(),
          pipelineResponse,
        ]);
        assert.equal(served.status(), 200);
        assert.equal(sha256(await served.body()), pipeline.sha256);
        await tab
          .locator('[data-testid="result-section"]')
          .waitFor({ state: 'visible', timeout: 120_000 });
        assert(traffic.requests.every((path) => !isRetiredWebpExecutable(path)));
        assert.deepEqual(await cachedLegacyExecutablePaths(coldPage), []);
        coldDocument = await coldPage.evaluate(() => {
          const controller = navigator.serviceWorker.controller;
          if (controller?.state !== 'activated')
            throw new Error('Cold legacy tab has no old controller');
          globalThis.__wmcUpgradeInitialController = controller;
          return performance.timeOrigin;
        });
      } finally {
        traffic.stop();
      }
    }
    if (!priorForcedWebp) {
      await page.locator('[data-testid="file-input"]').setInputFiles(smallFixture);
      await page.locator('[data-testid="convert-button"]').click();
      const proceed = page.locator('[data-testid="modal-confirm-button"]');
      if (await proceed.isVisible({ timeout: 1500 }).catch(() => false)) await proceed.click();
      await page
        .locator('[data-testid="result-section"]')
        .waitFor({ state: 'visible', timeout: 120_000 });
    }
    const oldDocumentTimeOrigin = await page.evaluate(() => performance.timeOrigin);
    const oldDownloadHref = await page
      .locator('[data-testid="download-result-button"]')
      .getAttribute('href');
    assert(
      oldDownloadHref && oldDownloadHref.startsWith('blob:'),
      'Prior build result has no downloadable Blob'
    );
    const priorResultBytes = Buffer.from(
      await page.evaluate(
        async (url) => Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())),
        oldDownloadHref
      )
    );
    assert(priorResultBytes.length > 100, 'Prior result Blob is unexpectedly small');
    const priorResultSha256 = sha256(priorResultBytes);
    if (priorForcedWebp) assert.equal(priorResultSha256, priorForcedWebp.outputSha256);
    const priorLegacyPaths = priorSoftware?.legacyExecutables.map(assetPath) ?? [];
    const cachedLegacyBeforeUpdate = await cachedLegacyExecutablePaths(page, priorLegacyPaths);
    const legacyCacheWarmed =
      priorSoftware?.family === 'wasm-webp' &&
      (removal
        ? LEGACY_WEBP_DEPLOYMENT.files.every((asset) =>
            cachedLegacyBeforeUpdate.includes(assetPath(asset))
          )
        : cachedLegacyBeforeUpdate.includes(assetPath(priorSoftware.asset)));
    if (removal)
      assert(legacyCacheWarmed, 'The three archived URLs were not warmed in Cache Storage');
    const warmedShim = removal
      ? await verifyArchivedAssetFetches(page, true, 'no-store', true, [RETIRED_WEBP_SHIM])
      : null;
    if (removal)
      await page.waitForFunction(
        async (path) => {
          for (const name of await caches.keys()) {
            if (!name.startsWith('dropconvert-')) continue;
            if (await (await caches.open(name)).match(path)) return true;
          }
          return false;
        },
        assetPath(RETIRED_WEBP_SHIM),
        { timeout: 15_000 }
      );
    const seededArchiveKeys = removal
      ? await seedArchivedCacheAliases(page, bundleRoot, priorRelativePath)
      : null;
    const archivedWorkerRequests = removal
      ? await verifyArchivedWorkerCaller(context, baseUrl, priorBuild, smallFixture)
      : null;
    const predecessorBeforeUpdate = predecessorAssets
      ? await snapshotPredecessorCaches(page, predecessorAssets)
      : null;
    const seededCallerAliases = removal
      ? await seedArchivedCacheAliases(page, bundleRoot, priorRelativePath, RETIRED_WEBP_CALLERS)
      : null;
    const cachedPaths = await page.evaluate(async () => {
      const paths = [];
      for (const name of (await caches.keys()).filter((value) =>
        value.startsWith('dropconvert-')
      )) {
        for (const key of await (await caches.open(name)).keys())
          paths.push(new URL(key.url).pathname);
      }
      return paths;
    });
    const neverFetchedLocale = oldOnly.find(
      (name) => /^(?:ar|es|ja|ko|zh-CN)\./.test(name) && !cachedPaths.includes(`/assets/${name}`)
    );
    // A codec-only change need not rebuild locale chunks. Keep the same real,
    // inventoried removed/uncached asset contract, using the retired codec when
    // no locale changed. Never fabricate a removed asset for ordinary upgrades.
    const neverFetched = neverFetchedLocale ?? selectRemovedUncachedAsset(oldOnly, cachedPaths);
    if (!requireChangedWorker)
      assert(
        neverFetched,
        'Prior build has no removed, never-fetched JS chunk for upgrade acceptance'
      );
    const missingAsset = neverFetched ?? 'handoff-control.abcdefgh.js';
    assert(!nextAssets.has(missingAsset) && !cachedPaths.includes(`/assets/${missingAsset}`));
    const locale = neverFetchedLocale?.split('.')[0];
    assert.equal(
      await page.evaluate(
        (path) =>
          performance
            .getEntriesByType('resource')
            .some((entry) => new URL(entry.name).pathname === path),
        `/assets/${missingAsset}`
      ),
      false,
      'Uncached control was already requested'
    );

    // A second old-build tab runs an actual conversion while the completed
    // result remains available in the first tab. The high-motion fixture is
    // also used by the maintained cancellation acceptance.
    activePage = await context.newPage();
    const activeTraffic = removal ? observeSoftwareWebp(activePage, baseUrl) : null;
    if (removal) await forceMainSoftwareWebp(activePage);
    const activeNavigation = await activePage.goto(baseUrl);
    if (removal) await verifyAppDocument(activeNavigation, priorBuild);
    await activePage.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    await activePage.waitForFunction(
      () => navigator.serviceWorker.controller?.state === 'activated'
    );
    await activePage.locator('[data-testid="file-input"]').setInputFiles(activeFixture);
    for (const [group, value] of [
      ['format', removal ? 'webp' : 'gif'],
      ['quality', 'high'],
      ['scale', '1'],
      ['smart-frame-skip', 'adaptive'],
    ]) {
      const option = activePage.locator(`[data-testid="option-${group}-${value}"]`);
      if (!(await option.isVisible())) {
        await activePage.locator('[data-testid="advanced-settings"] summary').click();
      }
      await option.click();
      assert.equal(await option.locator('input').isChecked(), true);
    }
    await activePage.locator('[data-testid="convert-button"]').click();
    const activeProceed = activePage.locator('[data-testid="modal-confirm-button"]');
    if (await activeProceed.isVisible({ timeout: 1500 }).catch(() => false))
      await activeProceed.click();
    await activePage.waitForFunction(
      () => {
        const progress = document.querySelector('[data-testid="dropzone"] [role="progressbar"]');
        const result = document.querySelector('[data-testid="result-section"]');
        const error = document.querySelector('[data-testid="error-display"]');
        return Number(progress?.getAttribute('data-progress')) > 0 || result || error;
      },
      undefined,
      { timeout: 180_000 }
    );
    if (removal && priorSoftware && activeTraffic) {
      const wasmPath = assetPath(priorSoftware.asset);
      if (
        !activeTraffic.responses.some((response) => new URL(response.url()).pathname === wasmPath)
      )
        await activePage.waitForResponse(
          (response) => new URL(response.url()).pathname === wasmPath,
          { timeout: 120_000 }
        );
    }
    const activeProgressAtSwitch = await activePage.evaluate(() =>
      Number(
        document
          .querySelector('[data-testid="dropzone"] [role="progressbar"]')
          ?.getAttribute('data-progress')
      )
    );
    assert(
      activeProgressAtSwitch > 0 &&
        !(await activePage.locator('[data-testid="result-section"]').isVisible()) &&
        !(await activePage.locator('[data-testid="error-display"]').isVisible()),
      'High-motion conversion completed or failed before the upgrade could begin'
    );
    const activeDocumentTimeOrigin = await activePage.evaluate(() => performance.timeOrigin);
    // Capture DOM state synchronously at controllerchange for changed workers.
    // An identical worker keeps the controller, so sample the active tab just
    // after registration.update() instead.
    await activePage.evaluate(() => {
      globalThis.__wmcUpgradeInitialController = navigator.serviceWorker.controller;
      globalThis.__wmcUpgradeControllerObservation = null;
      globalThis.__wmcObserveActiveConversion = () => {
        const visible = (selector: string) => {
          const element = document.querySelector(selector);
          return element instanceof HTMLElement && element.getClientRects().length > 0;
        };
        return {
          timeOrigin: performance.timeOrigin,
          progress: Number(
            document
              .querySelector('[data-testid="dropzone"] [role="progressbar"]')
              ?.getAttribute('data-progress')
          ),
          stopVisible: visible('[data-testid="stop-conversion-button"]'),
          resultVisible: visible('[data-testid="result-section"]'),
          errorVisible: visible('[data-testid="error-display"]'),
        };
      };
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => {
          globalThis.__wmcUpgradeControllerObservation = globalThis.__wmcObserveActiveConversion();
        },
        { once: true }
      );
    });

    await setDistribution('dist');
    assert(
      await activePage.locator('[data-testid="stop-conversion-button"]').isVisible(),
      'High-motion conversion ended before the worker update was requested'
    );
    const resultControllerChanged = await page.evaluate(async (expectChange) => {
      const old = navigator.serviceWorker.controller;
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) throw new Error('Prior service worker registration disappeared');
      globalThis.__wmcUpgradeInitialController = old;
      // Listen before update(): a quick activation must not escape the wait.
      const changed = expectChange
        ? new Promise((resolve) =>
            navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })
          )
        : null;
      await registration.update();
      if (expectChange && navigator.serviceWorker.controller === old)
        await new Promise((resolve, reject) => {
          if (!changed) {
            reject(new Error('Controller change listener was not installed'));
            return;
          }
          const timeout = setTimeout(
            () => reject(new Error('New worker did not claim retained tab')),
            15_000
          );
          changed.then(() => {
            clearTimeout(timeout);
            resolve(undefined);
          });
        });
      return navigator.serviceWorker.controller !== old;
    }, !workerByteIdentical);
    if (!workerByteIdentical)
      await activePage.waitForFunction(
        () => Boolean(globalThis.__wmcUpgradeControllerObservation),
        undefined,
        { timeout: 15_000 }
      );
    const activeUpdate = await activePage.evaluate(
      (expectChange) => ({
        observation: expectChange
          ? globalThis.__wmcUpgradeControllerObservation
          : globalThis.__wmcObserveActiveConversion(),
        controllerChanged:
          navigator.serviceWorker.controller !== globalThis.__wmcUpgradeInitialController,
        controllerChangeObserved: Boolean(globalThis.__wmcUpgradeControllerObservation),
      }),
      !workerByteIdentical
    );
    const workerUpdateOutcome = assertWorkerUpdateOutcome(
      priorBuild.workerSha256,
      currentBuild.workerSha256,
      { resultControllerChanged, activeControllerChanged: activeUpdate.controllerChanged }
    );
    assert.equal(
      activeUpdate.controllerChangeObserved,
      !workerByteIdentical,
      'Active conversion tab controllerchange did not match the worker update'
    );
    const atWorkerUpdate = activeUpdate.observation;
    assert(atWorkerUpdate, 'Active conversion observation was not captured');
    assert.equal(
      atWorkerUpdate.timeOrigin,
      activeDocumentTimeOrigin,
      'The active tab reloaded before the worker update was observed'
    );
    assert(
      atWorkerUpdate.progress > 0 &&
        atWorkerUpdate.progress < 100 &&
        atWorkerUpdate.stopVisible &&
        !atWorkerUpdate.resultVisible &&
        !atWorkerUpdate.errorVisible,
      `Conversion was not active at worker update: ${JSON.stringify(atWorkerUpdate)}`
    );
    assert.equal(
      await page.evaluate(() => performance.timeOrigin),
      oldDocumentTimeOrigin,
      'Service worker upgrade reloaded the retained result tab'
    );
    assert.equal(
      await page.locator('[data-testid="download-result-button"]').getAttribute('href'),
      oldDownloadHref,
      'Service worker upgrade discarded the prior result'
    );
    assert.equal(
      await activePage.evaluate(() => performance.timeOrigin),
      activeDocumentTimeOrigin,
      'Service worker upgrade reloaded an actively converting old tab'
    );
    const freshGrace = removal
      ? await verifyFreshOfflineDuringGrace(page, baseUrl, currentBuild)
      : null;
    const freshOfflineDuringGrace = freshGrace?.codec ?? null;
    if (removal) {
      assert.equal(await page.evaluate(() => performance.timeOrigin), oldDocumentTimeOrigin);
      assert.equal(
        await activePage.evaluate(() => performance.timeOrigin),
        activeDocumentTimeOrigin
      );
    }
    await activePage
      .locator('[data-testid="result-section"]')
      .waitFor({ state: 'visible', timeout: 180_000 });
    assert.equal(
      await activePage.evaluate(() => performance.timeOrigin),
      activeDocumentTimeOrigin,
      'Active old-build conversion reloaded before completion'
    );
    assert.equal(
      await activePage.locator('[data-testid="error-display"]').isVisible(),
      false,
      'Active old-build conversion failed after worker update'
    );
    const activeLegacyWebp =
      activeTraffic && priorSoftware
        ? await verifySoftwareWebp(
            activePage,
            await readResultDownload(activePage),
            priorSoftware,
            activeTraffic,
            { exactLegacyLoader }
          )
        : null;
    activeTraffic?.stop();
    const coldLegacyWebp =
      removal && coldPage && coldDocument !== undefined && currentSoftware
        ? await exerciseColdLegacyTab(
            coldPage,
            baseUrl,
            smallFixture,
            currentBuild,
            currentSoftware,
            coldDocument
          )
        : null;
    if (coldContext) {
      await coldContext.close();
      coldContext = undefined;
    }
    const retainedDownload = await readResultDownload(page);
    assert.equal(
      sha256(retainedDownload),
      priorResultSha256,
      'Prior result download bytes changed after worker update'
    );

    await context.setOffline(true);
    const oldAsset = await page.evaluate(async (url) => {
      const response = await fetch(url);
      return {
        status: response.status,
        bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
      };
    }, cached.url);
    assert.equal(oldAsset.status, 200);
    assert.equal(
      sha256(Buffer.from(oldAsset.bytes)),
      sha256(Buffer.from(cached.bytes)),
      'Cached prior JS changed after upgrade'
    );
    const retainedLegacyAfterWorkerClaim = removal
      ? await verifyArchivedAssetFetches(page, true, 'no-store', true)
      : null;
    const retainedLegacyAliasesAfterWorkerClaim = removal
      ? await verifyArchivedAssetFetches(
          page,
          true,
          'no-store',
          true,
          LEGACY_WEBP_DEPLOYMENT.files,
          STALE_ALIAS_QUERY
        )
      : null;
    const graceWorkerRestart = removal
      ? await verifyGraceWorkerRestart(page, activePage, currentBuild.workerSha256)
      : null;
    await context.setOffline(false);

    const missingPath = `/assets/${missingAsset}`;
    const missingUrl = `${baseUrl}${missingPath}`;
    // The updated worker intentionally turns an invalid 404 asset response
    // into Response.error(). The browser sees requestfailed, not a 404 response.
    const missingAtOrigin = await context.request.get(missingUrl);
    assert.equal(
      missingAtOrigin.status(),
      404,
      'Uncached control exists in the candidate distribution'
    );
    assert(
      !/\bimmutable\b/i.test(missingAtOrigin.headers()['cache-control'] ?? ''),
      'Uncached control received immutable caching at the origin'
    );
    // This listener records the updated worker's message in the exact old document.
    // The separately retained cold scenario verifies the archived in-app reload action.
    await page.evaluate(() => {
      globalThis.__wmcUpgradeAssetMessages = [];
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'dropconvert:asset-unavailable') {
          globalThis.__wmcUpgradeAssetMessages.push(event.data);
        }
      });
    });
    const [blockedRequest] = await Promise.all([
      page.waitForEvent('requestfailed', {
        predicate: (request) => request.url() === missingUrl,
        timeout: 15_000,
      }),
      locale
        ? page.locator('[data-testid="language-selector"]').selectOption(locale!)
        : page
            .evaluate(async (url) => {
              try {
                await fetch(url);
                return 'resolved';
              } catch {
                return 'rejected';
              }
            }, missingUrl)
            .then((outcome) => assert.equal(outcome, 'rejected')),
    ]);
    const requestFailure = blockedRequest.failure()?.errorText;
    assert(requestFailure, 'Uncached control failed without browser failure detail');
    await page.waitForFunction(
      (path) =>
        globalThis.__wmcUpgradeAssetMessages?.some(
          (message) =>
            message.path === path && message.status === 404 && message.reason === 'invalid-response'
        ),
      missingPath,
      { timeout: 15_000 }
    );
    const workerMessage = await page.evaluate(
      (path) => globalThis.__wmcUpgradeAssetMessages.find((message) => message.path === path),
      missingPath
    );
    assert(workerMessage, 'Worker did not report the unavailable asset');
    assert.equal(workerMessage.status, 404);
    assert.equal(workerMessage.reason, 'invalid-response');
    assert.equal(
      await page.evaluate(() => performance.timeOrigin),
      oldDocumentTimeOrigin,
      'Unavailable asset reloaded the retained result tab'
    );
    assert.equal(
      await page.locator('[data-testid="download-result-button"]').getAttribute('href'),
      oldDownloadHref,
      'Unavailable asset discarded the prior result'
    );
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="result-section"] h2')?.textContent?.trim() ===
        'Result',
      undefined,
      { timeout: 15_000 }
    );
    const retainedAfterMissing = await readResultDownload(page);
    assert.equal(
      sha256(retainedAfterMissing),
      priorResultSha256,
      'Prior result download bytes changed after an unavailable asset'
    );

    const currentJs = [...nextAssets].find((name) => name.endsWith('.js'));
    assert(currentJs, 'Candidate build has no JS assets');
    const polluted = await page.evaluate(async (url) => {
      const names = (await caches.keys()).filter((name) => name.startsWith('dropconvert-dynamic-'));
      const name = names.at(-1);
      if (!name) throw new Error('No dynamic cache for poisoned response probe');
      const cache = await caches.open(name);
      await cache.put(
        url,
        new Response('<!doctype html><title>poison</title>', {
          headers: { 'content-type': 'text/javascript' },
        })
      );
      const response = await fetch(url);
      const body = await response.text();
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        html: /^\s*<!doctype html/i.test(body),
      };
    }, `${baseUrl}/assets/${currentJs}`);
    assert.equal(polluted.status, 200);
    assert.match(polluted.contentType ?? '', /^(?:text|application)\/javascript\b/i);
    assert.equal(polluted.html, false, 'Polluted JS cache entry was served as executable content');
    assert.equal(await page.evaluate(() => performance.timeOrigin), oldDocumentTimeOrigin);
    if (workerByteIdentical) {
      const controllersStillOriginal = await Promise.all(
        [page, activePage].map((tab) =>
          tab.evaluate(
            () => navigator.serviceWorker.controller === globalThis.__wmcUpgradeInitialController
          )
        )
      );
      assert.deepEqual(
        controllersStillOriginal,
        [true, true],
        'Byte-identical worker update later changed an old tab controller'
      );
    }

    // The user has downloaded the retained result and explicitly reloads the
    // browser tab. The new document must load the current build and remain usable.
    const currentNavigation = await page.reload();
    if (removal) await verifyAppDocument(currentNavigation, currentBuild);
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    assert.notEqual(
      await page.evaluate(() => performance.timeOrigin),
      oldDocumentTimeOrigin,
      'Explicit browser reload did not replace the old document'
    );
    const currentScripts = await page.evaluate(() =>
      [...document.scripts]
        .map((script) => script.src && new URL(script.src).pathname)
        .filter(Boolean)
    );
    const candidateHtml = await readFile(join(bundleRoot, 'dist/index.html'), 'utf8');
    const candidateEntry = candidateHtml.match(
      /<script[^>]+type="module"[^>]+src="(\/assets\/[^"]+\.js)"/i
    )?.[1];
    assert(candidateEntry, 'Candidate distribution has no module entry script');
    assert(
      currentScripts.includes(candidateEntry),
      'Explicit reload did not load the current document entry script'
    );
    assert(
      currentScripts.some((path) => nextAssets.has(path.split('/').at(-1) ?? '')),
      'Explicit reload did not load a current-build entry script'
    );
    assert(
      currentScripts.every((path) => !oldOnly.includes(path.split('/').at(-1) ?? '')),
      'Explicit reload retained a removed old-build entry script'
    );
    await page.locator('[data-testid="option-format-webp"]').click();
    assert.equal(
      await page.locator('[data-testid="option-format-webp"] input').isChecked(),
      true,
      'Current application did not accept a settings interaction after explicit reload'
    );
    const currentForcedWebp =
      currentSoftware?.family === 'owned-vp8'
        ? await convertAndVerifySoftwareWebp(page, baseUrl, smallFixture, currentSoftware)
        : null;
    const cachedRetiredKeysAfterReload = await cachedLegacyExecutableKeys(page, priorLegacyPaths);
    const cachedLegacyAfterReload = removal
      ? LEGACY_WEBP_DEPLOYMENT.files
          .map(assetPath)
          .filter((path) =>
            cachedRetiredKeysAfterReload.some((key) => key.path === path && !key.search)
          )
          .sort()
      : [...new Set(cachedRetiredKeysAfterReload.map(({ path }) => path))].sort();
    if (removal) {
      assert.equal(
        await activePage.evaluate(() => performance.timeOrigin),
        activeDocumentTimeOrigin
      );
      assert(
        LEGACY_WEBP_DEPLOYMENT.files.every((asset) =>
          cachedLegacyAfterReload.includes(assetPath(asset))
        ),
        'The three archived executables must remain cached until the last old tab closes'
      );
    }
    // Keep the last old tab visible until closure, then foreground the existing
    // current app. The harness observes cache state without triggering a request.
    const currentDocumentTimeOrigin = await page.evaluate(() => performance.timeOrigin);
    let retirementNavigations = 0;
    const recordRetirementNavigation = (frame: ReturnType<Page['mainFrame']>) => {
      if (frame === page.mainFrame()) retirementNavigations++;
    };
    if (removal) page.on('framenavigated', recordRetirementNavigation);
    let beforeOldCloseEvents: RetirementEvent[] = [];
    if (removal) {
      await page.bringToFront();
      await page.waitForFunction(
        () =>
          globalThis.__wmcRetirementEvents.some(
            ({ kind, value }) => kind === 'worker' && value === 'grace'
          ),
        undefined,
        { timeout: 15_000 }
      );
      await activePage.bringToFront();
      await page.waitForFunction(() => document.visibilityState === 'hidden');
      beforeOldCloseEvents = await page.evaluate(() => globalThis.__wmcRetirementEvents.slice());
      assert(
        !beforeOldCloseEvents.some(({ kind, value }) => kind === 'worker' && value === 'retired')
      );
    }
    const clientBeforeClose = removal ? await retirementClientIdentity(page) : null;
    const originBeforeClose = archivedOrigin?.archivedOriginSnapshot(false);
    const predecessorBeforeClose = predecessorAssets
      ? await snapshotPredecessorCaches(page, predecessorAssets)
      : null;
    if (predecessorBeforeClose && seededCallerAliases) {
      for (const key of seededCallerAliases)
        assert(
          predecessorBeforeClose.oldKeys.some(
            (row) => row.cache === key.cache && row.path === key.path && row.search === key.search
          ),
          `Caller alias disappeared before the last old tab closed: ${key.path}${key.search}`
        );
    }
    await activePage.close();
    let currentClientWake = null;
    if (removal) {
      const closedAt = Date.now();
      const remaining = () => Math.max(1, 15_000 - (Date.now() - closedAt));
      await page.bringToFront();
      await page.waitForFunction(() => document.visibilityState === 'visible', undefined, {
        timeout: remaining(),
      });
      await page.waitForFunction(
        (offset) => {
          const events = globalThis.__wmcRetirementEvents.slice(offset);
          const wake = events.findIndex(
            ({ kind, value }) => kind === 'visibility' && value === 'visible'
          );
          return (
            wake >= 0 &&
            events
              .slice(wake + 1)
              .some(({ kind, value }) => kind === 'worker' && value === 'retired')
          );
        },
        beforeOldCloseEvents.length,
        { timeout: remaining() }
      );
      await page.waitForFunction(
        async (retired) => {
          for (const name of (await caches.keys()).filter((value) =>
            value.startsWith('dropconvert-')
          )) {
            const requests = await (await caches.open(name)).keys();
            if (requests.some((request) => retired.includes(new URL(request.url).pathname)))
              return false;
          }
          return true;
        },
        RETIRED_WEBP_EXECUTABLES.map(assetPath),
        { timeout: remaining() }
      );
      const retirementObservedAfterMs = Date.now() - closedAt;
      assert(
        retirementObservedAfterMs <= 15_000,
        'Retirement exceeded its 15-second foreground bound'
      );
      assert.equal(await page.evaluate(() => performance.timeOrigin), currentDocumentTimeOrigin);
      page.off('framenavigated', recordRetirementNavigation);
      assert.equal(retirementNavigations, 0, 'Current app navigated during retirement');
      assert.equal(sha256(await readResultDownload(page)), currentForcedWebp?.outputSha256);
      currentClientWake = {
        visibility: 'visible',
        sameDocument: true,
        retainedOwnedResult: true,
        beforeOldCloseEvents,
        afterOldCloseEvents: await page.evaluate(
          (offset) => globalThis.__wmcRetirementEvents.slice(offset),
          beforeOldCloseEvents.length
        ),
        retirementObservedAfterMs,
      };
    }
    const cachedLegacyWithoutOldTabs = await cachedLegacyExecutablePaths(page, priorLegacyPaths);
    const predecessorAfterClose = predecessorAssets
      ? await snapshotPredecessorCaches(page, predecessorAssets)
      : null;
    if (predecessorAfterClose && predecessorBeforeClose)
      assertPredecessorCacheSettlement(
        predecessorAfterClose,
        predecessorBeforeClose,
        priorBuild.indexSha256,
        currentBuild.indexSha256
      );
    let retiredAssetsAfterUpgrade = null;
    let retirementOrigin = null;
    let archivedOriginDenial = null;
    let predecessorReadmission = null;
    if (removal) {
      assert(archivedOrigin && clientBeforeClose && originBeforeClose);
      const clientAfter = await retirementClientIdentity(page);
      assert.equal(clientAfter.workerState, 'activated');
      assert.deepEqual(clientAfter, clientBeforeClose);
      const normal = await retiredBrowserOriginWindow(page, archivedOrigin, false, 'default');
      const bypass = await retiredBrowserOriginWindow(page, archivedOrigin, false, 'no-store');
      const query = await retiredBrowserOriginWindow(
        page,
        archivedOrigin,
        false,
        'no-store',
        STALE_ALIAS_QUERY
      );
      requireQuietOrigin(originBeforeClose, query.after);
      retiredAssetsAfterUpgrade = {
        normal: normal.rows,
        bypassHttpCache: bypass.rows,
        queryAlias: query.rows,
      };
      const directOrigin = await readDirectArchivedOrigin(
        page,
        baseUrl,
        archivedOrigin,
        LEGACY_WEBP_DEPLOYMENT.files,
        false,
        false
      );
      assert.deepEqual(directOrigin.before, query.after);
      const { rows: _normal, ...normalWindow } = normal;
      const { rows: _bypass, ...bypassWindow } = bypass;
      const { rows: _query, ...queryWindow } = query;
      retirementOrigin = {
        schemaVersion: 1,
        origin: new URL(baseUrl).origin,
        retiredPaths: LEGACY_WEBP_DEPLOYMENT.files.map(assetPath),
        candidate: {
          sourceSha: currentBuild.state.sourceSha,
          manifestSha256: currentBuild.manifestSha256,
          workerSha256: currentBuild.workerSha256,
        },
        controlled: {
          clientBeforeClose,
          clientAfter,
          beforeLastOldTabClose: originBeforeClose,
          afterControlled: query.after,
          normal: normalWindow,
          bypassHttpCache: bypassWindow,
          queryAlias: queryWindow,
        },
        directOrigin,
      };
      let direct;
      let denied;
      await archivedOrigin.setArchivedOrigin(priorRelativePath, RETIRED_WEBP_EXECUTABLES);
      try {
        direct = await readDirectArchivedOrigin(
          page,
          baseUrl,
          archivedOrigin,
          RETIRED_WEBP_EXECUTABLES,
          true,
          true
        );
        denied = {
          normal: await retiredBrowserOriginWindow(
            page,
            archivedOrigin,
            true,
            'default',
            STALE_ALIAS_QUERY
          ),
          noStore: await retiredBrowserOriginWindow(page, archivedOrigin, true, 'no-store'),
        };
        requireQuietOrigin(direct.after, denied.noStore.after);
      } finally {
        await archivedOrigin.setArchivedOrigin(null, []);
      }
      const afterResetDirect404 = await readDirectArchivedOrigin(
        page,
        baseUrl,
        archivedOrigin,
        RETIRED_WEBP_EXECUTABLES,
        false,
        true
      );
      assert.deepEqual(afterResetDirect404.before, denied.noStore.after);
      const physicalKeys = await cachedLegacyExecutableKeys(page, priorLegacyPaths);
      assert.deepEqual(physicalKeys, [], 'A retired canonical or query key was readmitted');
      assert.deepEqual(await retirementClientIdentity(page), clientBeforeClose);
      archivedOriginDenial = {
        schemaVersion: 1,
        origin: new URL(baseUrl).origin,
        retiredPaths: RETIRED_WEBP_EXECUTABLES.map(assetPath),
        client: clientBeforeClose,
        direct,
        denied,
        afterResetDirect404,
        controlledRequestsReachedOrigin: 0,
        physicalKeys,
      };
      assert(predecessorAssets && predecessorBeforeClose);
      const callerChallenge = await verifyCallerReadmissionDenied(
        page,
        baseUrl,
        archivedOrigin,
        priorRelativePath
      );
      const afterChallenge = await snapshotPredecessorCaches(page, predecessorAssets);
      assertPredecessorCacheSettlement(
        afterChallenge,
        predecessorBeforeClose,
        priorBuild.indexSha256,
        currentBuild.indexSha256
      );
      predecessorReadmission = { ...callerChallenge, afterChallenge };
    }
    let restart = null;
    let predecessorRestart = null;
    if (persistent) {
      assert(currentSoftware?.ownedOnly && currentForcedWebp && 'version' in warm);
      assert(predecessorAssets && predecessorBeforeClose);
      // Close the entire process for the profile that actually upgraded from
      // the archived build. A fresh candidate profile cannot prove eviction survives restart.
      await context.close();
      context = undefined;
      const { predecessor, ...legacyRestart } = await verifyInstalledProfileRestart(
        persistent,
        warm.version,
        baseUrl,
        currentBuild,
        smallFixture,
        currentSoftware,
        currentForcedWebp.outputSha256,
        predecessorAssets,
        predecessorBeforeClose,
        priorBuild.indexSha256
      );
      restart = legacyRestart;
      predecessorRestart = predecessor;
    }
    const predecessorMigration =
      predecessorAssets && predecessorBeforeUpdate
        ? {
            schemaVersion: 1,
            inventory: predecessorAssets,
            archivedEntryResponses,
            archivedWorkerRequests,
            absentBeforeUpdate: predecessorAssets.oldOnly
              .map(assetPath)
              .filter((path) => !predecessorBeforeUpdate.oldKeys.some((row) => row.path === path)),
            beforeUpdate: predecessorBeforeUpdate,
            seededCallerAliases,
            grace: freshGrace?.callers,
            beforeLastClose: predecessorBeforeClose,
            afterLastClose: predecessorAfterClose,
            readmission: predecessorReadmission,
            restart: predecessorRestart,
          }
        : null;
    return {
      id: 'real-build-upgrade',
      status: 'passed',
      priorOnlyNeverFetchedChunk: neverFetched,
      missingChunkTriggeredBy: locale
        ? `language-selector=${locale}`
        : neverFetched
          ? 'uncached removed asset fetch'
          : 'uncached synthetic control fetch',
      cachedPriorAsset: new URL(cached.url).pathname,
      cachedPriorSha256: sha256(Buffer.from(cached.bytes)),
      retainedResultDownload: true,
      retainedResultSha256: priorResultSha256,
      retainedResultBytes: priorResultBytes.length,
      retainedDownloadAfterMissing: true,
      retainedDocument: true,
      priorSourceSha: priorBuild.state.sourceSha,
      currentSourceSha: currentBuild.state.sourceSha,
      priorManifestSha256: priorBuild.manifestSha256,
      currentManifestSha256: currentBuild.manifestSha256,
      priorForcedWebp,
      currentForcedWebp,
      ...(removal
        ? {
            warmedArchivedAssets,
            warmedShim,
            activeLegacyWebp,
            coldLegacyWebp,
            retainedLegacyAfterWorkerClaim,
            retainedLegacyAliasesAfterWorkerClaim,
            freshOfflineDuringGrace,
            graceWorkerRestart,
            offlineDuringGrace: freshOfflineDuringGrace && {
              sourceSha: freshOfflineDuringGrace.sourceSha,
              sha256: freshOfflineDuringGrace.sha256,
            },
            seededArchiveKeys,
            cachedRetiredKeysAfterReload,
            retirementNavigations,
            currentClientWake,
            archivedOriginDenial,
            retirementOrigin,
            retiredAssetsAfterUpgrade,
            restart,
            predecessorMigration,
          }
        : {}),
      cachedLegacyBeforeUpdate,
      legacyCacheWarmed,
      cachedLegacyAfterReload,
      cachedLegacyWithoutOldTabs,
      ownedOnlyAfterUpgrade: Boolean(
        currentSoftware?.ownedOnly &&
        currentForcedWebp &&
        priorForcedWebp &&
        legacyCacheWarmed &&
        cachedLegacyWithoutOldTabs.length === 0 &&
        (!removal ||
          (activeLegacyWebp &&
            coldLegacyWebp &&
            warmedShim &&
            retainedLegacyAfterWorkerClaim &&
            retainedLegacyAliasesAfterWorkerClaim &&
            freshOfflineDuringGrace &&
            graceWorkerRestart?.status === 'passed' &&
            seededArchiveKeys &&
            currentClientWake &&
            archivedOriginDenial &&
            retirementOrigin &&
            retiredAssetsAfterUpgrade &&
            predecessorMigration &&
            predecessorReadmission &&
            predecessorRestart &&
            restart))
      ),
      priorWorkerSha256: priorBuild.workerSha256,
      currentWorkerSha256: currentBuild.workerSha256,
      workerUpdateOutcome,
      resultControllerChanged,
      activeControllerChanged: activeUpdate.controllerChanged,
      activeConversionProgressAtSwitch: activeProgressAtSwitch,
      activeConversionAtWorkerUpdate: atWorkerUpdate,
      activeConversionCompletedWithoutReload: true,
      missingChunkStatus: missingAtOrigin.status(),
      missingChunkRequestFailure: requestFailure,
      missingChunkWorkerMessage: workerMessage,
      messageObservedByHarnessOnly: true,
      oldLocaleFallback: locale ? 'English' : null,
      pollutedAssetRejected: true,
      explicitReloadLoadedCurrentBuild: true,
      currentAppSettingsInteraction: true,
    };
  } finally {
    try {
      await coldContext?.close();
      if (context) {
        await context.setOffline(false).catch(() => {});
        await context.close();
      }
    } finally {
      try {
        await persistent?.dispose();
      } finally {
        await setDistribution('dist');
      }
    }
  }
}

async function installedBrowserVersion(context: BrowserContext, page: Page) {
  const session = await context.newCDPSession(page);
  try {
    const { product, userAgent } = await session.send('Browser.getVersion');
    return { product, userAgent };
  } finally {
    await session.detach();
  }
}

async function prepareInstalledProfile(browser: Browser, bundleRoot: string) {
  assert.equal(
    browser.browserType().name(),
    'chromium',
    'Removal requires the installed Chromium controller'
  );
  const detection = await browser.newContext();
  let expected: Awaited<ReturnType<typeof installedBrowserVersion>>;
  try {
    expected = await installedBrowserVersion(detection, await detection.newPage());
  } finally {
    await detection.close();
  }
  const channel = expected.userAgent.includes('Edg/') ? 'msedge' : 'chrome';
  assert.match(expected.userAgent, /Chrome\//, 'Unsupported installed Chromium channel');
  const profilePath = await mkdtemp(join(bundleRoot, '.wmc-owned-removal-'));
  return {
    channel,
    async launch() {
      const context = await browser.browserType().launchPersistentContext(profilePath, {
        channel,
        headless: false,
        acceptDownloads: true,
        locale: 'en-US',
        args: ['--mute-audio'],
      });
      try {
        const page = context.pages()[0] ?? (await context.newPage());
        const version = await installedBrowserVersion(context, page);
        assert.deepEqual(version, expected, 'Removal profile changed the installed browser build');
        return { context, version };
      } catch (error) {
        await context.close();
        throw error;
      }
    },
    async dispose() {
      await rm(profilePath, { recursive: true, force: true });
    },
  };
}

async function verifyInstalledProfileRestart(
  persistent: Awaited<ReturnType<typeof prepareInstalledProfile>>,
  before: Awaited<ReturnType<typeof installedBrowserVersion>>,
  baseUrl: string,
  build: Build,
  fixture: string,
  software: ReturnType<typeof softwareWebpInventory>,
  outputSha256: string,
  predecessorAssets: PredecessorAssets,
  predecessorBeforeClose: PredecessorCacheSnapshot,
  priorIndexSha256: string
) {
  const { context, version: after } = await persistent.launch();
  try {
    await context.setOffline(true);
    const page = context.pages()[0] ?? (await context.newPage());
    await forceMainSoftwareWebp(page);
    await verifyAppDocument(await page.goto(baseUrl), build, true);
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    await page.locator('[data-testid="offline-banner"]').waitFor({ state: 'visible' });
    const cachePaths = await cachedLegacyExecutablePaths(page);
    assert.deepEqual(cachePaths, [], 'Retired cache entries survived process restart');
    const retiredRequests = {
      canonical: await verifyArchivedAssetFetches(
        page,
        false,
        'default',
        false,
        RETIRED_WEBP_EXECUTABLES
      ),
      aliases: await verifyArchivedAssetFetches(
        page,
        false,
        'default',
        false,
        RETIRED_WEBP_EXECUTABLES,
        STALE_ALIAS_QUERY
      ),
    };
    const webp = await convertAndVerifySoftwareWebp(page, baseUrl, fixture, software, true);
    assert.equal(webp.outputSha256, outputSha256, 'Offline restart changed WebP output');
    assert.deepEqual(await cachedLegacyExecutablePaths(page), []);
    const callerRequests = {
      canonical: await verifyArchivedAssetFetches(
        page,
        false,
        'default',
        false,
        RETIRED_WEBP_CALLERS
      ),
      aliases: await verifyArchivedAssetFetches(
        page,
        false,
        'no-store',
        false,
        RETIRED_WEBP_CALLERS,
        STALE_ALIAS_QUERY
      ),
    };
    const settled = await snapshotPredecessorCaches(page, predecessorAssets);
    assertPredecessorCacheSettlement(
      settled,
      predecessorBeforeClose,
      priorIndexSha256,
      build.indexSha256
    );
    return {
      status: 'passed',
      profile: 'migrated',
      channel: persistent.channel,
      before,
      after,
      cachePaths,
      retiredRequests,
      webp,
      predecessor: { callerRequests, settled },
    };
  } finally {
    await context.close();
  }
}

export function assertRemovalUpgradeEvidence(
  removal: boolean,
  upgrade: {
    ownedOnlyAfterUpgrade: boolean;
    graceWorkerRestart?: { status: 'passed' } | { status: 'unverified'; reason: string } | null;
  }
) {
  if (!removal) return;
  const restart = upgrade.graceWorkerRestart;
  if (restart?.status === 'unverified')
    assert.fail(`Removal grace worker restart unverified (${restart.reason})`);
  assert.equal(restart?.status, 'passed', 'Removal grace worker restart evidence is missing');
  assert(upgrade.ownedOnlyAfterUpgrade, 'Removal upgrade evidence is incomplete');
}

export async function exerciseOfflineRecovery(
  browser: Browser,
  baseUrl: string,
  outputRoot: string,
  setDistribution: StartedServer['setDistribution'],
  bundleRoot: string,
  smallFixture: string,
  activeFixture: string,
  priorRelativePath = 'validation/windows/prior-dist',
  requireChangedWorker = false,
  removal?: RemovalVerification,
  archivedOrigin?: ArchivedOriginControl
) {
  const upgrade = await exerciseBuildUpgrade(
    browser,
    baseUrl,
    bundleRoot,
    smallFixture,
    activeFixture,
    setDistribution,
    priorRelativePath,
    requireChangedWorker,
    removal,
    archivedOrigin
  );
  assertRemovalUpgradeEvidence(Boolean(removal), upgrade);
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const build = await readBuild(bundleRoot, 'dist', async (_root, path) => join(bundleRoot, path));
  const software =
    requireChangedWorker && !removal ? null : softwareWebpInventory(build.state.files);
  if (software?.family === 'owned-vp8') await forceMainSoftwareWebp(page);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    // Seed the old poisoned entry before the production worker activates.
    await page.goto(`${baseUrl}/robots.txt`);
    await page.evaluate(async () => {
      const old = await caches.open('dropconvert-dynamic-v20260714');
      await old.put(
        '/',
        new Response('old polluted recovery document', {
          headers: { 'content-type': 'text/plain' },
        })
      );
      const unrelated = await caches.open('acceptance-unrelated');
      await unrelated.put('/unrelated', new Response('preserved'));
    });
    await page.goto(baseUrl);
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    const identity = await page.evaluate(async () => ({
      controller: navigator.serviceWorker.controller?.scriptURL ?? null,
      caches: await caches.keys(),
      unrelated: await (
        await (await caches.open('acceptance-unrelated')).match('/unrelated')
      )?.text(),
    }));
    assert.equal(identity.controller, `${baseUrl}/service-worker.js`);
    assert(!identity.caches.includes('dropconvert-dynamic-v20260714'));
    assert.equal(identity.unrelated, 'preserved');

    // Reload under the controller so application assets and the root response
    // reach the real worker before the browser's network is disabled.
    const onlineResponse = await page.goto(`${baseUrl}/?offline-acceptance=online`);
    if (removal) await verifyAppDocument(onlineResponse, build, true);
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    await page.waitForFunction(async () => {
      const names = await caches.keys();
      const name = names.find((value) => value.startsWith('dropconvert-dynamic-'));
      if (!name) return false;
      const cache = await caches.open(name);
      return (
        Boolean(await cache.match('/')) &&
        (await cache.keys()).some((request) => new URL(request.url).pathname.endsWith('.js'))
      );
    });
    const inspect = () =>
      page.evaluate(async () => {
        const names = await caches.keys();
        const cacheName = names.find((name) => name.startsWith('dropconvert-dynamic-'));
        if (!cacheName) throw new Error('Dynamic recovery cache is missing');
        const response = await (await caches.open(cacheName)).match('/');
        if (!response) throw new Error('Recovery cache has no root response');
        return {
          cacheName,
          url: response.url,
          status: response.status,
          contentType: response.headers.get('content-type'),
          body: await response.text(),
        };
      });
    const before = await inspect();
    assert.match(before.contentType ?? '', /^text\/html\b/);
    assert.equal(before.status, 200);
    const onlineWebp =
      software?.family === 'owned-vp8'
        ? await convertAndVerifySoftwareWebp(page, baseUrl, smallFixture, software)
        : null;

    const textResponse = await page.goto(`${baseUrl}/robots.txt`);
    assert(textResponse);
    assert.equal(textResponse.status(), 200);
    assert.equal(textResponse.fromServiceWorker(), true);
    assert.match(textResponse.headers()['content-type'] ?? '', /^text\/plain\b/);
    assert((await page.locator('body').textContent())?.includes('User-agent:'));
    const after = await inspect();
    assert.deepEqual(
      after,
      before,
      'Non-application navigation changed the canonical recovery entry'
    );

    await context.setOffline(true);
    const offlineResponse = await page.goto(`${baseUrl}/?offline-acceptance=recovery`);
    if (removal) await verifyAppDocument(offlineResponse, build, true);
    assert(offlineResponse);
    assert.equal(offlineResponse.status(), 200);
    assert.equal(offlineResponse.fromServiceWorker(), true);
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    await page.locator('[data-testid="offline-banner"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-testid="choose-file-button"]').isEnabled(), true);
    await page.locator('[data-testid="option-format-webp"]').click();
    assert.equal(await page.locator('[data-testid="option-format-webp"] input').isChecked(), true);
    await page.screenshot({ path: join(outputRoot, 'offline-app-recovery.png'), fullPage: true });
    const offlineWebp =
      software?.family === 'owned-vp8'
        ? await convertAndVerifySoftwareWebp(page, baseUrl, smallFixture, software, true)
        : null;
    await page.evaluate(async (cacheName) => {
      const cache = await caches.open(cacheName);
      await cache.put(
        '/',
        new Response('current polluted recovery document', {
          headers: { 'content-type': 'text/plain' },
        })
      );
    }, before.cacheName);
    const staticFallback = await page.reload();
    if (removal) await verifyAppDocument(staticFallback, build, true);
    assert(staticFallback);
    assert.equal(staticFallback.status(), 200);
    assert.equal(staticFallback.fromServiceWorker(), true);
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-testid="choose-file-button"]').isEnabled(), true);
    assert.equal(
      await page.evaluate(
        async (cacheName) => Boolean(await (await caches.open(cacheName)).match('/')),
        before.cacheName
      ),
      false,
      'Current polluted dynamic entry was retained'
    );
    await page.screenshot({
      path: join(outputRoot, 'offline-static-recovery.png'),
      fullPage: true,
    });
    const staticFallbackWebp =
      software?.family === 'owned-vp8'
        ? await convertAndVerifySoftwareWebp(page, baseUrl, smallFixture, software, true)
        : null;
    if (onlineWebp) {
      assert.equal(offlineWebp?.outputSha256, onlineWebp.outputSha256);
      assert.equal(staticFallbackWebp?.outputSha256, onlineWebp.outputSha256);
    }
    const currentLegacyCachePaths = await cachedLegacyExecutablePaths(page);
    if (software?.ownedOnly) assert.deepEqual(currentLegacyCachePaths, []);
    await context.setOffline(false);
    await page.locator('[data-testid="offline-banner"]').waitFor({ state: 'hidden' });
    assert.deepEqual(pageErrors, []);
    if (removal)
      assert(
        software?.ownedOnly && onlineWebp && offlineWebp && staticFallbackWebp,
        'Owned-only online and offline conversions were not all verified'
      );
    const digest = (body: string) => createHash('sha256').update(body).digest('hex');
    return {
      id: 'offline-app-recovery',
      status: 'passed',
      upgrade,
      sourceSha: build.state.sourceSha,
      manifestSha256: build.manifestSha256,
      software: software ? { family: software.family, ownedOnly: software.ownedOnly } : null,
      onlineWebp,
      offlineWebp,
      staticFallbackWebp,
      currentLegacyCachePaths,
      controller: identity.controller,
      cacheName: before.cacheName,
      priorPollutedCacheRemoved: true,
      unrelatedCachePreserved: true,
      before: {
        url: before.url,
        status: before.status,
        contentType: before.contentType,
        bodySha256: digest(before.body),
      },
      after: {
        url: after.url,
        status: after.status,
        contentType: after.contentType,
        bodySha256: digest(after.body),
      },
      offlineResponseFromServiceWorker: true,
      offlineSettingsInteraction: true,
      onlineRestored: true,
      nonAppNavigationFromServiceWorker: true,
      currentPollutedEntryRemoved: true,
      staticFallbackFromServiceWorker: true,
      pageErrors: pageErrors.length,
    };
  } catch (error) {
    await page
      .screenshot({ path: join(outputRoot, 'offline-recovery-error.png'), fullPage: true })
      .catch(() => {});
    throw error;
  } finally {
    await context.setOffline(false);
    await context.close();
  }
}

const RECOVERY_BASELINE = 'validation/windows/inputs/recovery-baseline';
const RECOVERY_A = 'validation/windows/inputs/recovery-a';
const RECOVERY_BUSY_FIXTURE = 'validation/windows/inputs/cancel-high-motion.mp4';
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const FILE_SHA = /^[a-f0-9]{64}$/;

// Ignored selector: {schemaVersion:1, mode:'recovery', baseline:RECOVERY_BASELINE,
// baselineSourceSha, baselineTreeSha, buildA:RECOVERY_A, sourceA, treeA,
// sourceB, treeB, busyFixture:RECOVERY_BUSY_FIXTURE, busyFixtureSha256,
// assertionProbe?:boolean}. B is always the bundled dist/.
// Run the optional assertion probe in a separate output directory; it must fail.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecoverySelector(config: unknown): asserts config is RecoveryConfig {
  assert(isRecord(config), 'Invalid recovery selector');
  const keys = [
    'schemaVersion',
    'mode',
    'baseline',
    'baselineSourceSha',
    'baselineTreeSha',
    'buildA',
    'sourceA',
    'treeA',
    'sourceB',
    'treeB',
    'busyFixture',
    'busyFixtureSha256',
  ];
  const expected = 'assertionProbe' in config ? [...keys, 'assertionProbe'] : keys;
  assert.deepEqual(Object.keys(config).sort(), expected.sort(), 'Invalid recovery selector keys');
  assert('schemaVersion' in config && config.schemaVersion === 1);
  assert('mode' in config && config.mode === 'recovery');
  assert('baseline' in config && config.baseline === RECOVERY_BASELINE);
  assert('buildA' in config && config.buildA === RECOVERY_A);
  assert('busyFixture' in config && config.busyFixture === RECOVERY_BUSY_FIXTURE);
  assert(
    'busyFixtureSha256' in config &&
      typeof config.busyFixtureSha256 === 'string' &&
      FILE_SHA.test(config.busyFixtureSha256)
  );
  if ('assertionProbe' in config) assert(typeof config.assertionProbe === 'boolean');
  for (const key of [
    'baselineSourceSha',
    'baselineTreeSha',
    'sourceA',
    'treeA',
    'sourceB',
    'treeB',
  ] as const) {
    assert(
      key in config && typeof config[key] === 'string' && SOURCE_SHA.test(config[key]),
      `Invalid ${key}`
    );
  }
}

function emittedAsset(build: Build, pattern: RegExp) {
  const matches = build.state.files.filter((file) => pattern.test(file.path));
  assert.equal(matches.length, 1, `${build.relativePath} needs exactly one emitted ${pattern}`);
  const asset = matches[0];
  assert(asset);
  return asset;
}

export function selectPipelineDependency(files: readonly InventoryFile[]) {
  const gifenc = files.filter(({ path }) => /^assets\/gifenc[.-][\w-]{8}\.js$/.test(path));
  const dependency = gifenc.length
    ? gifenc
    : files.filter(({ path }) => /^assets\/owned-demux-index-snapshot[.-][\w-]{8}\.js$/.test(path));
  assert.equal(dependency.length, 1, 'Build needs one known first-pipeline preload dependency');
  return { asset: dependency[0]!, firstConversion: gifenc.length > 0 };
}

function assetPath(asset: Build['main']) {
  return `/${asset.path}`;
}

async function assertNeverFetched(page: Page, path: string) {
  const observed = await page.evaluate(async (assetPathname) => {
    const resource = performance
      .getEntriesByType('resource')
      .some((entry) => new URL(entry.name).pathname === assetPathname);
    const cache = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith('dropconvert-')) continue;
      for (const request of await (await caches.open(name)).keys())
        if (new URL(request.url).pathname === assetPathname) cache.push(name);
    }
    return { resource, cache };
  }, path);
  assert.equal(observed.resource, false, `${path} was requested before the failure`);
  assert.deepEqual(observed.cache, [], `${path} was cached before the failure`);
}

function observePage(page: Page) {
  const events: PageEvents = {
    pageErrors: [],
    consoleErrors: [],
    consoleWarnings: [],
    requestedAssets: [],
    failedRequests: [],
    failedResponses: [],
    overflow: false,
  };
  const append = <T>(array: T[], value: T) => {
    if (array.length >= 128) events.overflow = true;
    else array.push(value);
  };
  const safePath = (url: string) => {
    try {
      return url ? new URL(url).pathname : null;
    } catch {
      return null;
    }
  };
  page.on('pageerror', (error) => append(events.pageErrors, String(error.message).slice(0, 500)));
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/assets\/.*\.(?:js|json)$/.test(path)) append(events.requestedAssets, path);
  });
  page.on('console', (message) => {
    if (message.type() === 'error')
      append(events.consoleErrors, {
        text: message.text().slice(0, 500),
        path: safePath(message.location().url),
      });
    if (message.type() === 'warning') append(events.consoleWarnings, message.text().slice(0, 500));
  });
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    if (url.protocol === 'blob:' && request.failure()?.errorText === 'net::ERR_ABORTED') return;
    append(events.failedRequests, { path: url.pathname, error: request.failure()?.errorText });
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      append(events.failedResponses, {
        path: new URL(response.url()).pathname,
        status: response.status(),
      });
  });
  return events;
}

function assertExpectedNetwork(events: PageEvents, expectedPath: string) {
  const unrelated = [
    ...events.failedRequests.filter((item) => item.path !== expectedPath),
    ...events.failedResponses.filter((item) => item.path !== expectedPath),
  ];
  assert.deepEqual(unrelated, [], 'Unexpected failed request or response');
  assert.equal(events.pageErrors.length, 0, 'Unhandled page error after caught optional import');
  assert.deepEqual(
    events.consoleErrors.filter(
      (item) => item.path !== expectedPath && !item.text.includes(expectedPath)
    ),
    [],
    'Unrelated console error after caught optional import'
  );
}

async function readLogExport(page: Page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-testid="export-logs-button"]').click(),
  ]);
  const bytes = await readFile(await download.path());
  assert(bytes.length > 0 && bytes.length < 1024 * 1024, 'Log export is empty or unbounded');
  return { sha256: sha256(bytes), bytes: bytes.length, text: bytes.toString('utf8') };
}

async function observeLogExportInteraction(page: Page) {
  await page.evaluate(() => {
    const observation: LogExportInteraction = { buttonClicks: 0, downloadAnchors: [] };
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest('[data-testid="export-logs-button"]')) observation.buttonClicks += 1;
        const anchor = target.closest('a[download]');
        if (anchor instanceof HTMLAnchorElement && observation.downloadAnchors.length < 4)
          observation.downloadAnchors.push({
            blobHref: anchor.href.startsWith('blob:'),
            logFilename: anchor.download.startsWith('motion-converter-logs-'),
            connectedAtClick: anchor.isConnected,
          });
      },
      true
    );
    globalThis.__wmcLogExportInteraction = observation;
  });
}

async function persistOfflineExportFailure(
  page: Page,
  outputRoot: string,
  controlled: boolean,
  details: object,
  events: PageEvents,
  error: unknown
) {
  const id = `recovery-offline-miss-${controlled ? 'controlled' : 'blocked'}`;
  const screenshot = join(outputRoot, `${id}-export-failed.png`);
  let screenshotSha256 = null;
  let screenshotFailure = null;
  try {
    await page.screenshot({ path: screenshot, timeout: 5_000 });
    screenshotSha256 = sha256(await readFile(screenshot));
  } catch (captureError) {
    screenshotFailure = String(captureError).slice(0, 500);
  }
  const pageState = await page
    .evaluate(() => {
      const exportButton = document.querySelector('[data-testid="export-logs-button"]');
      return {
        online: navigator.onLine,
        timeOrigin: performance.timeOrigin,
        visibility: document.visibilityState,
        exportButtonPresent: Boolean(exportButton),
        exportButtonEnabled: exportButton instanceof HTMLButtonElement && !exportButton.disabled,
        resultVisible: Boolean(document.querySelector('[data-testid="result-section"]')),
        exportInteraction: globalThis.__wmcLogExportInteraction ?? null,
      };
    })
    .catch((captureError) => ({ captureFailure: String(captureError).slice(0, 500) }));
  await writeFile(
    join(outputRoot, `${id}-export-failed.json`),
    JSON.stringify(
      {
        id,
        failure: String(error).slice(0, 1000),
        details,
        pageState,
        exportFailedWarnings: events.consoleWarnings.filter((line) =>
          line.includes('export-failed')
        ),
        events: JSON.parse(JSON.stringify(events)),
        screenshotSha256,
        screenshotFailure,
      },
      null,
      2
    )
  );
}

async function waitForOriginAsset(started: StartedServer, path: string, priorCount: number) {
  // SW-originated requests can bypass Playwright page.route; observe the owned
  // loopback server itself and keep the wait bounded.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (started.observedAssetRequests.slice(priorCount).includes(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`The owned origin never received ${path}`);
}

async function requireApp(page: Page, baseUrl: string) {
  const response = await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  assert.equal(response?.status(), 200, 'Built app did not boot');
  await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => globalThis.crossOriginIsolated), true);
  return await page.evaluate(() => performance.timeOrigin);
}

async function validationError(page: Page) {
  await page.locator('[data-testid="file-input"]').setInputFiles({
    name: 'unsupported.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('This is not a video.'),
  });
}

async function baselineFirstError(
  browser: Browser,
  started: StartedServer,
  baseline: Build,
  outputRoot: string
) {
  await started.setDistribution(baseline.relativePath);
  const errorChunk = emittedAsset(baseline, /^assets\/ErrorDisplay[.-][\w-]{8}\.js$/);
  const path = assetPath(errorChunk);
  const context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' });
  const page = await context.newPage();
  const events = observePage(page);
  try {
    const timeOrigin = await requireApp(page, started.url);
    await assertNeverFetched(page, path);
    assert(!started.observedAssetRequests.includes(path), 'Baseline error chunk fetched at boot');
    started.setAssetFailure({ path, mode: '404' });
    await validationError(page);
    await waitForOriginAsset(started, path, 0);
    await page.getByRole('heading', { name: 'Application Error' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-testid="error-display"]').count(), 0);
    assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin);
    const primary = events.consoleWarnings.find((line) => line.includes('File validation failed'));
    assert(
      primary && primary.includes('Unsupported'),
      'Primary validation error was not separately logged'
    );
    assert(
      started.assetFailureRequests.length >= 1 && started.assetFailureRequests.length <= 2,
      'Blocked baseline chunk request count is outside the Vite preload/import pair'
    );
    const screenshot = join(outputRoot, 'recovery-baseline-first-error.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    return {
      id: 'baseline-first-error-red',
      status: 'passed',
      sourceSha: baseline.state.sourceSha,
      emittedChunk: path,
      chunkSha256: errorChunk.sha256,
      failure: 'origin-404',
      outerFallback: true,
      primaryValidationLog: primary.slice(0, 500),
      timeOriginUnchanged: true,
      requests: started.assetFailureRequests.length,
      events,
      screenshotSha256: sha256(await readFile(screenshot)),
    };
  } finally {
    started.setAssetFailure(null);
    await context.close();
  }
}

async function fixedFirstError(
  browser: Browser,
  started: StartedServer,
  build: Build,
  outputRoot: string
) {
  await started.setDistribution(build.relativePath);
  assert.equal(
    build.state.files.some((file) => /^assets\/(?:ErrorDisplay|MemoryWarning)[.-]/.test(file.path)),
    false,
    'Essential error or memory UI is still a named lazy chunk'
  );
  const context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' });
  const page = await context.newPage();
  const events = observePage(page);
  try {
    const timeOrigin = await requireApp(page, started.url);
    const before = started.observedAssetRequests.length;
    const beforeRequests = events.requestedAssets.length;
    await context.setOffline(true);
    await validationError(page);
    const display = page.locator('[data-testid="error-display"]');
    await display.waitFor({ state: 'visible' });
    assert.match((await display.textContent()) ?? '', /Unsupported/i);
    assert.equal(
      (await page
        .locator(
          '[data-testid="error-select-different-button"], [data-testid="error-select-different-fallback-button"]'
        )
        .count()) > 0,
      true
    );
    assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin);
    const extra = started.observedAssetRequests.slice(before);
    assert.deepEqual(extra, [], 'First error fetched a new JavaScript asset');
    assert.deepEqual(
      events.requestedAssets.slice(beforeRequests),
      [],
      'First error requested a JavaScript or locale asset'
    );
    assert.deepEqual(events.failedRequests, [], 'First error requested network while offline');
    await page.locator('[data-testid="offline-banner"]').waitFor({ state: 'visible' });
    const screenshot = join(outputRoot, 'recovery-fixed-first-error.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    const exportHitTarget = await page
      .locator('[data-testid="export-logs-button"]')
      .evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const x = bounds.left + bounds.width / 2;
        const y = bounds.top + bounds.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          x,
          y,
          centerInViewport:
            bounds.width > 0 &&
            bounds.height > 0 &&
            x >= 0 &&
            y >= 0 &&
            x < innerWidth &&
            y < innerHeight,
          buttonReceivesCenterClick: hit !== null && button.contains(hit),
          hitTestId: hit?.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
        };
      });
    assert.equal(
      exportHitTarget.centerInViewport && exportHitTarget.buttonReceivesCenterClick,
      true,
      `Offline header export button is obstructed: ${JSON.stringify(exportHitTarget)}`
    );
    await context.setOffline(false);
    const optional = emittedAsset(build, /^assets\/es[.-][\w-]{8}\.js$/);
    const secondaryPath = await triggerLocaleFailure(page, started, optional, '404');
    assert.equal(
      await display.isVisible(),
      true,
      'Secondary import failure replaced primary error'
    );
    const log = await readLogExport(page);
    assert.match(log.text, /File validation failed/, 'Primary error absent from bounded export');
    assert.match(log.text, /i18n\.load-failed/, 'Secondary failure absent from bounded export');
    assert.match(log.text, /app\.asset-unavailable/, 'Asset evidence absent from bounded export');
    assertExpectedNetwork(events, secondaryPath);
    assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin);
    return {
      id: 'fixed-first-error-offline',
      status: 'passed',
      sourceSha: build.state.sourceSha,
      noEssentialChunk: true,
      noNewJavaScriptRequest: true,
      timeOriginUnchanged: true,
      primaryAndSecondaryExportSha256: log.sha256,
      primaryAndSecondaryExportBytes: log.bytes,
      secondaryOptionalChunk: secondaryPath,
      offlineExportHitTarget: exportHitTarget,
      screenshotSha256: sha256(await readFile(screenshot)),
      events,
    };
  } finally {
    started.setAssetFailure(null);
    await context.setOffline(false).catch(() => {});
    await context.close();
  }
}

async function firstPipelineImportFailure(
  browser: Browser,
  started: StartedServer,
  build: Build,
  fixture: string,
  outputRoot: string,
  controlled: boolean,
  baseline: boolean
) {
  await started.setDistribution(build.relativePath);
  const pipeline = emittedAsset(build, /^assets\/conversion-pipeline[.-][\w-]{8}\.js$/);
  const pipelineDependency = selectPipelineDependency(build.state.files);
  const path = assetPath(pipeline);
  const errorChunk = baseline
    ? emittedAsset(build, /^assets\/ErrorDisplay[.-][\w-]{8}\.js$/)
    : null;
  if (!baseline)
    assert.equal(
      build.state.files.some((file) => /^assets\/ErrorDisplay[.-]/.test(file.path)),
      false,
      'Fixed error UI unexpectedly requires a separate JavaScript chunk'
    );
  const id = `${baseline ? 'baseline-first-pipeline-offline' : 'fixed-first-pipeline-network'}-${controlled ? 'controlled' : 'blocked'}`;
  const context = await browser.newContext({
    locale: 'en-US',
    acceptDownloads: true,
    serviceWorkers: controlled ? 'allow' : 'block',
  });
  const page = await context.newPage();
  const events = observePage(page);
  const screenshot = join(outputRoot, `recovery-${id}.png`);
  const importResponses: { path: string; status: number; fromServiceWorker: boolean }[] = [];
  context.on('response', (response) => {
    const responsePath = new URL(response.url()).pathname;
    if (responsePath !== path && responsePath !== (errorChunk && assetPath(errorChunk))) return;
    if (importResponses.length >= 128) events.overflow = true;
    else
      importResponses.push({
        path: responsePath,
        status: response.status(),
        fromServiceWorker: response.fromServiceWorker(),
      });
  });
  try {
    await requireApp(page, started.url);
    if (controlled) {
      await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
      await page.reload();
      await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
      await captureWorkerAssetMessages(page);
    }
    assert.equal(
      await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
      controlled,
      'Pipeline import did not use the requested service-worker state'
    );
    await page.locator('[data-testid="file-input"]').setInputFiles(fixture);
    for (const [group, value] of [
      ['format', 'webp'],
      ['quality', 'high'],
      ['scale', '1'],
      ['smart-frame-skip', 'off'],
    ]) {
      const option = page.locator(`[data-testid="option-${group}-${value}"]`);
      if (!(await option.isVisible()))
        await page.locator('[data-testid="advanced-settings"] summary').click();
      await option.click();
      assert.equal(await option.locator('input').isChecked(), true);
    }
    await assertNeverFetched(page, path);
    const dependencyPath = assetPath(pipelineDependency.asset);
    // Owned demux is shared with media inspection and already requested on
    // upload. The historical gifenc preload is cold when conversion starts.
    if (pipelineDependency.firstConversion) await assertNeverFetched(page, dependencyPath);
    else
      assert(
        events.requestedAssets.includes(dependencyPath),
        'Shared owned demux preload was not observed during media inspection'
      );
    if (errorChunk) await assertNeverFetched(page, assetPath(errorChunk));
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    const beforeOrigin = started.observedAssetRequests.length;
    const beforePageRequests = events.requestedAssets.length;
    if (baseline) {
      await context.setOffline(true);
      await page.waitForFunction(() => navigator.onLine === false);
    } else {
      started.setAssetFailure({ path, mode: 'network' });
    }
    await page.locator('[data-testid="convert-button"]').click();
    const proceed = page.locator('[data-testid="modal-confirm-button"]');
    if (await proceed.isVisible({ timeout: 1500 }).catch(() => false)) await proceed.click();
    const display = page.locator('[data-testid="error-display"]');
    if (baseline) {
      await page.getByRole('heading', { name: 'Application Error' }).waitFor({ state: 'visible' });
      assert.equal(await display.count(), 0, 'Pre-fix error UI unexpectedly survived its import');
    } else {
      await display.waitFor({ state: 'visible', timeout: 30_000 });
      assert.match(
        (await display.locator('details pre').textContent()) ?? '',
        /Failed to fetch dynamically imported module.*conversion-pipeline/i,
        'Error UI did not retain the original pipeline import failure'
      );
      assert.equal(await page.locator('[data-testid="app-error-fallback"]').count(), 0);
      assert.equal(
        await page.locator('[data-testid="error-select-different-button"]').isEnabled(),
        true
      );
      const reload = page
        .getByRole('status')
        .filter({ has: page.getByRole('button', { name: 'Reload page' }) })
        .getByRole('button', { name: 'Reload page' });
      await reload.waitFor({ state: 'visible' });
      assert.equal(
        await reload.isEnabled(),
        true,
        'Terminal import failure cannot be reloaded explicitly'
      );
    }
    const errorChunkPath = errorChunk ? assetPath(errorChunk) : null;
    if (baseline) assert(errorChunkPath);
    const firstConversionImports = pipelineDependency.firstConversion
      ? [path, dependencyPath]
      : [path];
    const expectedPaths = baseline ? [...firstConversionImports, errorChunkPath] : [path];
    const expectedRequestedPaths = baseline ? expectedPaths : firstConversionImports;
    const deadline = Date.now() + 15_000;
    while (
      Date.now() < deadline &&
      !expectedPaths.every((expected) =>
        events.failedRequests.some((failure) => failure.path === expected)
      )
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    const requested = events.requestedAssets.slice(beforePageRequests);
    assert.deepEqual(
      [...new Set(requested)].sort(),
      [...expectedRequestedPaths].sort(),
      'First conversion fetched a different JavaScript asset set'
    );
    assert.equal(requested[0], path, 'Pipeline failure did not precede the error UI request');
    for (const expected of expectedRequestedPaths) {
      const attempts = requested.filter((requestedPath) => requestedPath === expected).length;
      assert(
        attempts >= 1 && attempts <= 2,
        'Failed import request count is outside the bounded Vite preload/import pair'
      );
    }
    assert(
      expectedPaths.every((expected) =>
        events.failedRequests.some((failure) => failure.path === expected)
      ),
      'The emitted module request did not fail at the transport layer'
    );
    assert.deepEqual(importResponses, [], 'Transport failure was classified as an HTTP response');
    if (baseline)
      assert.deepEqual(
        started.observedAssetRequests.slice(beforeOrigin),
        [],
        'Offline import unexpectedly reached the origin'
      );
    else {
      await waitForOriginAsset(started, path, beforeOrigin);
      assert(
        started.assetFailureRequests.some(
          (request) => request.path === path && request.mode === 'network'
        ),
        'The owned origin did not inject the pipeline transport failure'
      );
    }
    const workerMessage = controlled
      ? await requireWorkerAssetMessage(page, path, 0, 'network-error')
      : null;
    assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin);
    // The pre-fix ErrorBoundary replaces the entire app, including its export
    // button. Its bounded console record is the surviving primary-error log.
    const primaryConversionLog = baseline
      ? events.consoleErrors.find(
          (entry) => entry.text.includes('Conversion failed') && entry.text.includes(path)
        )?.text
      : null;
    if (baseline)
      assert(primaryConversionLog, 'Pre-fix primary import failure is absent from the console');
    const log = baseline ? null : await readLogExport(page);
    if (!baseline) {
      assert(log);
      assert.match(log.text, /Conversion failed/);
      assert(
        log.text.includes(path),
        'Original pipeline import path is absent from the bounded log'
      );
      assert(
        log.text
          .split('\n')
          .some(
            (line) =>
              line.includes('app.asset-unavailable') &&
              line.includes(path) &&
              line.includes(controlled ? '"source":"service-worker"' : '"source":"vite-preload"') &&
              line.includes(controlled ? '"status":0' : '"status":null')
          ),
        'Asset log did not distinguish the failed transport and observer source'
      );
      assertExpectedNetwork(events, path);
    }
    await page.screenshot({ path: screenshot, fullPage: true });
    return {
      id,
      status: 'passed',
      sourceSha: build.state.sourceSha,
      emittedPipeline: path,
      pipelineSha256: pipeline.sha256,
      pipelineDependency: dependencyPath,
      pipelineDependencySha256: pipelineDependency.asset.sha256,
      pipelineDependencyFirstRequestedDuringConversion: pipelineDependency.firstConversion,
      secondaryErrorChunk: errorChunk ? assetPath(errorChunk) : null,
      secondaryErrorChunkSha256: errorChunk?.sha256 ?? null,
      serviceWorkerControlled: controlled,
      workerMessage,
      originalErrorVisible: !baseline,
      outerFallback: baseline,
      requestedAssets: requested,
      importResponses,
      originRequests: started.assetFailureRequests.filter((request) => request.path === path)
        .length,
      noOriginResponse: true,
      noAutomaticNavigation: true,
      primaryConversionLog,
      logExport: log ? { sha256: log.sha256, bytes: log.bytes } : null,
      screenshotSha256: sha256(await readFile(screenshot)),
      events,
    };
  } catch (error) {
    let screenshotSha256 = null;
    let screenshotFailure = null;
    try {
      await page.screenshot({ path: screenshot, timeout: 5_000 });
      screenshotSha256 = sha256(await readFile(screenshot));
    } catch (captureError) {
      screenshotFailure = String(captureError).slice(0, 500);
    }
    await writeFile(
      join(outputRoot, `recovery-${id}-failed.json`),
      JSON.stringify(
        {
          id,
          failure: String(error).slice(0, 1000),
          emittedPipeline: path,
          secondaryErrorChunk: errorChunk ? assetPath(errorChunk) : null,
          events,
          importResponses,
          screenshotSha256,
          screenshotFailure,
        },
        null,
        2
      )
    );
    throw error;
  } finally {
    started.setAssetFailure(null);
    await context.setOffline(false).catch(() => {});
    await context.close();
  }
}

async function memoryWarningOffline(
  browser: Browser,
  started: StartedServer,
  build: Build,
  smallFixture: string
) {
  await started.setDistribution(build.relativePath);
  const context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' });
  const page = await context.newPage();
  const events = observePage(page);
  try {
    await page.addInitScript(() => {
      Object.defineProperty(performance, 'memory', {
        configurable: true,
        value: {
          usedJSHeapSize: 15 * 1024 * 1024,
          totalJSHeapSize: 16 * 1024 * 1024,
          jsHeapSizeLimit: 16 * 1024 * 1024,
        },
      });
    });
    const timeOrigin = await requireApp(page, started.url);
    await page.locator('[data-testid="file-input"]').setInputFiles(smallFixture);
    await page.locator('[data-testid="convert-button"]').waitFor({ state: 'visible' });
    const before = started.observedAssetRequests.length;
    const beforeRequests = events.requestedAssets.length;
    await context.setOffline(true);
    await page.locator('[data-testid="convert-button"]').click();
    await page.locator('[data-testid="memory-warning"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-testid="memory-warning-dismiss"]').isEnabled(), true);
    assert.deepEqual(
      started.observedAssetRequests.slice(before),
      [],
      'Memory warning fetched JavaScript'
    );
    assert.deepEqual(
      events.requestedAssets.slice(beforeRequests),
      [],
      'Memory warning requested a JavaScript or locale asset'
    );
    assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin);
    assert.deepEqual(events.failedRequests, []);
    return {
      id: 'fixed-memory-warning-offline',
      status: 'passed',
      sourceSha: build.state.sourceSha,
      noNewJavaScriptRequest: true,
      timeOriginUnchanged: true,
      events,
    };
  } finally {
    await context.setOffline(false).catch(() => {});
    await context.close();
  }
}

async function createSmallGif(page: Page, fixture: string) {
  await page.locator('[data-testid="file-input"]').setInputFiles(fixture);
  await page.locator('[data-testid="option-format-gif"]').click();
  await page.locator('[data-testid="option-quality-low"]').click();
  await page.locator('[data-testid="option-scale-0.5"]').click();
  await page.locator('[data-testid="convert-button"]').click();
  const proceed = page.locator('[data-testid="modal-confirm-button"]');
  if (await proceed.isVisible({ timeout: 1500 }).catch(() => false)) await proceed.click();
  await page
    .locator('[data-testid="result-section"]')
    .waitFor({ state: 'visible', timeout: 120_000 });
  const bytes = await readResultDownload(page);
  assert(bytes.length > 100, 'Small GIF output is empty');
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

async function triggerLocaleFailure(
  page: Page,
  started: StartedServer,
  chunk: Build['main'],
  mode: '404' | 'wrong-mime' | 'network' | 'missing-after-update',
  events: PageEvents | null = null
) {
  const path = assetPath(chunk);
  await assertNeverFetched(page, path);
  const before = started.observedAssetRequests.length;
  if (mode !== 'missing-after-update') started.setAssetFailure({ path, mode });
  await page.locator('[data-testid="language-selector"]').selectOption('es');
  await waitForOriginAsset(started, path, before);
  await page
    .getByRole('status')
    .filter({
      has: page.getByRole('button', { name: 'Reload page' }),
    })
    .waitFor({ state: 'visible', timeout: 15_000 });
  if (mode !== 'missing-after-update') {
    const physical = started.assetFailureRequests.length;
    const logical = events?.requestedAssets.filter((requested) => requested === path).length ?? 0;
    // Chromium may reconnect after the origin destroys a socket. Bound the
    // page-level import attempt, while retaining the physical count as evidence.
    assert(
      physical >= 1 && (mode === 'network' || physical <= 2),
      `Injected origin attempts invalid: mode=${mode}, physical=${physical}, logical=${logical}`
    );
    if (mode === 'network')
      assert(
        logical >= 1 && logical <= 2,
        `Network failure has repeated page-level module requests: physical=${physical}, logical=${logical}, failed=${events?.failedRequests.filter((entry) => entry.path === path).length}`
      );
  }
  return path;
}

async function captureWorkerAssetMessages(page: Page) {
  await page.evaluate(() => {
    globalThis.__wmcRecoveryWorkerMessages = [];
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.source !== navigator.serviceWorker.controller) return;
      if (event.data?.type === 'dropconvert:asset-unavailable')
        globalThis.__wmcRecoveryWorkerMessages.push(event.data);
    });
  });
}

async function requireWorkerAssetMessage(page: Page, path: string, status: number, reason: string) {
  await page.waitForFunction(
    ({ path, status, reason }) =>
      globalThis.__wmcRecoveryWorkerMessages?.some(
        (message) => message.path === path && message.status === status && message.reason === reason
      ),
    { path, status, reason },
    { timeout: 15_000 }
  );
  return await page.evaluate(
    (path) => globalThis.__wmcRecoveryWorkerMessages.find((message) => message.path === path),
    path
  );
}

async function optionalFailureCase(
  browser: Browser,
  started: StartedServer,
  build: Build,
  fixture: string,
  outputRoot: string,
  mode: '404' | 'wrong-mime' | 'network',
  controlled: boolean
) {
  await started.setDistribution(build.relativePath);
  const chunk = emittedAsset(build, /^assets\/es[.-][\w-]{8}\.js$/);
  const context = await browser.newContext({
    locale: 'en-US',
    acceptDownloads: true,
    serviceWorkers: controlled ? 'allow' : 'block',
  });
  const page = await context.newPage();
  const events = observePage(page);
  try {
    await requireApp(page, started.url);
    if (controlled) {
      await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
      await page.reload();
      await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    }
    const actualController = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
    assert.equal(actualController, controlled, 'Optional import did not use requested SW state');
    if (controlled) await captureWorkerAssetMessages(page);
    const origin = await page.evaluate(() => performance.timeOrigin);
    const result = mode === '404' ? await createSmallGif(page, fixture) : null;
    const path = await triggerLocaleFailure(page, started, chunk, mode, events);
    if (mode === 'network')
      assert(
        events.failedRequests.some((entry) => entry.path === path),
        'Network fault did not fail the page-level optional module request'
      );
    const workerMessage = controlled
      ? await requireWorkerAssetMessage(
          page,
          path,
          mode === 'network' ? 0 : mode === '404' ? 404 : 200,
          mode === 'network' ? 'network-error' : 'invalid-response'
        )
      : null;
    const retained = result ? await readResultDownload(page) : null;
    if (result) {
      assert(retained);
      assert.equal(
        sha256(retained),
        result.sha256,
        'Optional import failure changed result download'
      );
    }
    assert.equal(await page.evaluate(() => performance.timeOrigin), origin);
    if (result)
      assert.equal(await page.locator('[data-testid="result-section"]').isVisible(), true);
    else assert.equal(await page.locator('[data-testid="choose-file-button"]').isVisible(), true);
    const log = await readLogExport(page);
    assert.match(
      log.text,
      /i18n\.load-failed/,
      'Optional import failure missing from bounded export'
    );
    const assetLogs = log.text.split('\n').filter((line) => line.includes('app.asset-unavailable'));
    assert(assetLogs.length > 0, 'Optional import missing asset evidence in bounded export');
    assert(
      assetLogs.some((line) => line.includes(controlled ? 'service-worker' : 'vite-preload')),
      'Asset evidence has the wrong observer source'
    );
    if (mode === 'network')
      assert(
        assetLogs.every((line) => !/"status":404/.test(line)),
        'Network failure was incorrectly classified as HTTP 404'
      );
    assertExpectedNetwork(events, path);
    const screenshot = join(
      outputRoot,
      `recovery-optional-${mode}-${controlled ? 'controlled' : 'blocked'}.png`
    );
    await page.screenshot({ path: screenshot, fullPage: true });
    return {
      id: `optional-${mode}-${controlled ? 'controlled' : 'blocked'}`,
      status: 'passed',
      sourceSha: build.state.sourceSha,
      emittedChunk: path,
      chunkSha256: chunk.sha256,
      expectedOriginFailure: mode,
      serviceWorkerControlled: controlled,
      actualController,
      workerMessage,
      output: result,
      downloadedAfterFailureSha256: retained ? sha256(retained) : null,
      logExport: { sha256: log.sha256, bytes: log.bytes },
      timeOriginUnchanged: true,
      originRequests: started.assetFailureRequests.length,
      logicalAssetRequests: events.requestedAssets.filter((requested) => requested === path).length,
      screenshotSha256: sha256(await readFile(screenshot)),
      events,
    };
  } finally {
    started.setAssetFailure(null);
    await context.close();
  }
}

async function offlineOptionalMiss(
  browser: Browser,
  started: StartedServer,
  build: Build,
  fixture: string,
  outputRoot: string,
  controlled: boolean
) {
  await started.setDistribution(build.relativePath);
  const chunk = emittedAsset(build, /^assets\/es[.-][\w-]{8}\.js$/);
  const path = assetPath(chunk);
  const context = await browser.newContext({
    locale: 'en-US',
    acceptDownloads: true,
    serviceWorkers: controlled ? 'allow' : 'block',
  });
  const page = await context.newPage();
  const events = observePage(page);
  try {
    await requireApp(page, started.url);
    if (controlled) {
      await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
      await page.reload();
      await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
      await captureWorkerAssetMessages(page);
    }
    assert.equal(
      await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
      controlled
    );
    const origin = await page.evaluate(() => performance.timeOrigin);
    const result = await createSmallGif(page, fixture);
    await assertNeverFetched(page, path);
    const beforeOriginRequests = started.observedAssetRequests.length;
    await context.setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false);
    await page.locator('[data-testid="language-selector"]').selectOption('es');
    await page
      .getByRole('status')
      .filter({ has: page.getByRole('button', { name: 'Reload page' }) })
      .waitFor({ state: 'visible', timeout: 15_000 });
    const workerMessage = controlled
      ? await requireWorkerAssetMessage(page, path, 0, 'network-error')
      : null;
    assert.deepEqual(
      started.observedAssetRequests.slice(beforeOriginRequests),
      [],
      'Offline miss unexpectedly received an origin response'
    );
    assert.equal(started.observedAssetOverflow, false, 'Origin asset observation overflowed');
    assert(
      events.requestedAssets.includes(path),
      'Offline miss did not attempt the real emitted optional import'
    );
    assert(
      events.failedRequests.some((entry) => entry.path === path),
      'Offline miss did not fail as a network request'
    );
    assert.deepEqual(events.failedResponses, [], 'Offline miss fabricated an HTTP error');
    const retained = await readResultDownload(page);
    assert.equal(sha256(retained), result.sha256, 'Offline miss changed retained result');
    assert.equal(await page.evaluate(() => performance.timeOrigin), origin);
    assert.equal(await page.locator('[data-testid="result-section"]').isVisible(), true);
    await observeLogExportInteraction(page);
    let log: Awaited<ReturnType<typeof readLogExport>>;
    try {
      log = await readLogExport(page);
    } catch (error) {
      try {
        await persistOfflineExportFailure(
          page,
          outputRoot,
          controlled,
          {
            sourceSha: build.state.sourceSha,
            emittedChunk: path,
            resultSha256: result.sha256,
            retainedDownloadSha256: sha256(retained),
            originalTimeOrigin: origin,
            noOriginResponse: true,
          },
          events,
          error
        );
      } catch (captureError) {
        if (error instanceof Error)
          error.message += `; export failure diagnostics could not be written: ${String(captureError)}`;
      }
      throw error;
    }
    assert.match(log.text, /i18n\.load-failed/);
    const assetLogs = log.text.split('\n').filter((line) => line.includes('app.asset-unavailable'));
    assert(
      assetLogs.some(
        (line) =>
          line.includes(controlled ? '"source":"service-worker"' : '"source":"vite-preload"') &&
          line.includes(controlled ? '"status":0' : '"status":null')
      ),
      'Offline miss lacks network/unknown-status observer evidence'
    );
    assert(
      assetLogs.every((line) => !/"status":404/.test(line)),
      'Offline cache miss was incorrectly classified as HTTP 404'
    );
    assertExpectedNetwork(events, path);
    const screenshot = join(
      outputRoot,
      `recovery-offline-miss-${controlled ? 'controlled' : 'blocked'}.png`
    );
    await page.screenshot({ path: screenshot, fullPage: true });
    return {
      id: `optional-offline-miss-${controlled ? 'controlled' : 'blocked'}`,
      status: 'passed',
      sourceSha: build.state.sourceSha,
      emittedChunk: path,
      chunkSha256: chunk.sha256,
      serviceWorkerControlled: controlled,
      workerMessage,
      noOriginResponse: true,
      result,
      downloadedAfterFailureSha256: sha256(retained),
      timeOriginUnchanged: true,
      logExport: { sha256: log.sha256, bytes: log.bytes },
      screenshotSha256: sha256(await readFile(screenshot)),
      events,
    };
  } finally {
    await context.setOffline(false).catch(() => {});
    await context.close();
  }
}

async function loadSpanishThenEnglish(page: Page) {
  await page.locator('[data-testid="language-selector"]').selectOption('es');
  await page
    .locator('[data-testid="choose-file-button"]')
    .filter({ hasText: 'Suelta un archivo de vídeo aquí' })
    .waitFor({ state: 'visible' });
  await page.locator('[data-testid="language-selector"]').selectOption('en');
  await page
    .locator('[data-testid="choose-file-button"]')
    .filter({ hasText: 'Drop a video file here' })
    .waitFor({ state: 'visible' });
}

async function installControlledFormatterFault(
  page: Page,
  target: ReturnType<typeof resultSizeFormatterTarget> | { kind: 'duration' }
) {
  await page.evaluate((target) => {
    const original = Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype, 'format');
    if (!original?.get || !original.configurable)
      throw new Error('Intl.NumberFormat formatter fault seam is unavailable');
    const getter = original.get;
    globalThis.__wmcRestoreNumberFormat = () =>
      Object.defineProperty(Intl.NumberFormat.prototype, 'format', original);
    Object.defineProperty(Intl.NumberFormat.prototype, 'format', {
      configurable: true,
      get() {
        const options = this.resolvedOptions();
        const formatter = getter.call(this);
        return (value: number) => {
          const resultSize =
            target.kind === 'result-size' &&
            options.maximumFractionDigits === target.maximumFractionDigits &&
            Math.abs(Number(value) - target.value) < 0.000001;
          const duration =
            target.kind === 'duration' &&
            (options.maximumFractionDigits === 0 ||
              (options.minimumFractionDigits === 1 && options.maximumFractionDigits === 1));
          if (options.locale.startsWith('es') && (resultSize || duration))
            throw new Error('Controlled result formatter render failure');
          return formatter(value);
        };
      },
    });
  }, target);
}

function resultSizeFormatterTarget(bytes: number) {
  const unitIndex = bytes >= 1024 ** 3 ? 3 : bytes >= 1024 ** 2 ? 2 : bytes >= 1024 ? 1 : 0;
  return {
    kind: 'result-size' as const,
    maximumFractionDigits: unitIndex === 0 ? 0 : 2,
    value: bytes / 1024 ** unitIndex,
  };
}

async function ordinaryRenderFailure(
  browser: Browser,
  started: StartedServer,
  build: Build,
  fixture: string,
  outputRoot: string
) {
  await started.setDistribution(build.relativePath);
  const context = await browser.newContext({
    locale: 'en-US',
    acceptDownloads: true,
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const events = observePage(page);
  try {
    await requireApp(page, started.url);
    // Load the real optional locale successfully before the render fault.
    await loadSpanishThenEnglish(page);
    const origin = await page.evaluate(() => performance.timeOrigin);
    const result = await createSmallGif(page, fixture);
    const before = started.observedAssetRequests.length;
    const target = resultSizeFormatterTarget(result.bytes);
    const inputTarget = resultSizeFormatterTarget((await readFile(fixture)).length);
    assert(
      target.maximumFractionDigits !== inputTarget.maximumFractionDigits ||
        Math.abs(target.value - inputTarget.value) >= 0.000001,
      'Result and input sizes cannot distinguish the formatter fault'
    );
    await installControlledFormatterFault(page, target);
    await page.locator('[data-testid="language-selector"]').selectOption('es');
    const fallback = page.locator('[data-testid="app-error-fallback"]');
    await fallback.waitFor({ state: 'visible' });
    await page.evaluate(() => globalThis.__wmcRestoreNumberFormat());
    assert.equal(await page.evaluate(() => performance.timeOrigin), origin);
    assert.deepEqual(
      started.observedAssetRequests.slice(before),
      [],
      'Ordinary render failure unexpectedly requested an optional asset'
    );
    assert.equal(
      await page.locator('[data-testid="result-section"]').count(),
      0,
      'Failed result renderer was not contained'
    );
    const recovered = await readResultDownload(page, '[data-testid="recovery-result-download"]');
    assert.equal(
      sha256(recovered),
      result.sha256,
      'Recovery fallback changed retained result download bytes'
    );
    const reload = fallback.locator('[data-testid="recovery-reload"]');
    assert.equal(await reload.isDisabled(), true, 'Fallback reload bypassed retained result guard');
    const log = await readLogExport(page);
    assert.match(log.text, /app\.feature-render-failed/);
    assert.match(log.text, /kind.*render/);
    assert.equal(events.pageErrors.length, 0, 'Contained render error escaped as page error');
    assert.deepEqual(events.failedRequests, [], 'Unrelated request failed during render recovery');
    assert.deepEqual(
      events.failedResponses,
      [],
      'Unrelated response failed during render recovery'
    );
    assert.deepEqual(
      events.consoleErrors.filter(
        (item) => !item.text.includes('Controlled result formatter render failure')
      ),
      [],
      'Unrelated console error during render recovery'
    );
    const screenshot = join(outputRoot, 'recovery-result-render-fallback.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    await fallback.locator('[data-testid="recovery-clear-results"]').click();
    assert.equal(
      await reload.isEnabled(),
      true,
      'Explicit result clear did not unlock fallback reload'
    );
    await reload.click();
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    assert.notEqual(
      await page.evaluate(() => performance.timeOrigin),
      origin,
      'Approved fallback reload did not navigate'
    );
    return {
      id: 'ordinary-result-render-fallback',
      status: 'passed',
      sourceSha: build.state.sourceSha,
      failure: 'controlled-es-number-formatter',
      optionalLocalePreviouslyLoaded: true,
      originalResult: result,
      recoveryDownloadSha256: sha256(recovered),
      timeOriginUnchangedThroughRecovery: true,
      protectedResultBeforeReload: true,
      explicitClearAndReload: true,
      logExport: { sha256: log.sha256, bytes: log.bytes },
      screenshotSha256: sha256(await readFile(screenshot)),
      events,
    };
  } finally {
    await page.evaluate(() => globalThis.__wmcRestoreNumberFormat?.()).catch(() => {});
    await context.close();
  }
}

async function busyRenderFailure(
  browser: Browser,
  started: StartedServer,
  build: Build,
  busyFixture: string,
  outputRoot: string
) {
  await started.setDistribution(build.relativePath);
  const context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' });
  const page = await context.newPage();
  const events = observePage(page);
  try {
    await requireApp(page, started.url);
    await loadSpanishThenEnglish(page);
    await page.locator('[data-testid="file-input"]').setInputFiles(busyFixture);
    for (const [group, value] of [
      ['format', 'gif'],
      ['quality', 'high'],
      ['scale', '1'],
      ['smart-frame-skip', 'adaptive'],
    ]) {
      const option = page.locator(`[data-testid="option-${group}-${value}"]`);
      if (!(await option.isVisible()))
        await page.locator('[data-testid="advanced-settings"] summary').click();
      await option.click();
      assert.equal(await option.locator('input').isChecked(), true);
    }
    await page.locator('[data-testid="convert-button"]').click();
    const proceed = page.locator('[data-testid="modal-confirm-button"]');
    if (await proceed.isVisible({ timeout: 1500 }).catch(() => false)) await proceed.click();
    await page.waitForFunction(
      () => {
        const progress = document.querySelector('[data-testid="dropzone"] [role="progressbar"]');
        const stop = document.querySelector('[data-testid="stop-conversion-button"]');
        const value = Number(progress?.getAttribute('data-progress'));
        return (
          value > 0 &&
          value < 100 &&
          stop instanceof HTMLButtonElement &&
          !stop.disabled &&
          !document.querySelector('[data-testid="result-section"], [data-testid="error-display"]')
        );
      },
      undefined,
      { timeout: 180_000 }
    );
    const activeProgress = await page
      .locator('[data-testid="dropzone"] [role="progressbar"]')
      .getAttribute('data-progress');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="dropzone"]')?.textContent?.includes('ETA ') &&
        Number(
          document
            .querySelector('[data-testid="dropzone"] [role="progressbar"]')
            ?.getAttribute('data-progress')
        ) < 100 &&
        Boolean(document.querySelector('[data-testid="stop-conversion-button"]')),
      undefined,
      { timeout: 30_000 }
    );
    const origin = await page.evaluate(() => performance.timeOrigin);
    await installControlledFormatterFault(page, { kind: 'duration' });
    await page.locator('[data-testid="language-selector"]').selectOption('es');
    const fallback = page.locator('[data-testid="app-error-fallback"]');
    await fallback.waitFor({ state: 'visible' });
    await page.evaluate(() => globalThis.__wmcRestoreNumberFormat());
    const cancel = fallback.locator('[data-testid="recovery-cancel"]');
    await cancel.waitFor({ state: 'visible' });
    assert.equal(
      await cancel.isEnabled(),
      true,
      'Conversion ended before recovery cancellation became usable'
    );
    const reload = fallback.locator('[data-testid="recovery-reload"]');
    assert.equal(await reload.isDisabled(), true, 'Busy fallback allowed reload');
    assert.equal(await page.evaluate(() => performance.timeOrigin), origin);
    await page.evaluate(() => {
      const record = {
        sawCancellingState: false,
        sawDisabledCancel: false,
        sawProtectedReload: false,
      };
      const capture = () => {
        const state = document.querySelector('#app-state')?.textContent?.trim() ?? '';
        const cancel = document.querySelector('[data-testid="recovery-cancel"]');
        const reload = document.querySelector('[data-testid="recovery-reload"]');
        if (state === 'Cancelando...') record.sawCancellingState = true;
        if (cancel instanceof HTMLButtonElement && cancel.disabled) record.sawDisabledCancel = true;
        if (reload instanceof HTMLButtonElement && reload.disabled)
          record.sawProtectedReload = true;
      };
      const observer = new MutationObserver(capture);
      observer.observe(document.body, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      capture();
      globalThis.__wmcBusyRecovery = { record, observer };
    });
    const screenshot = join(outputRoot, 'recovery-busy-render-fallback.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    await cancel.click();
    await page.waitForFunction(
      () => {
        const state = document.querySelector('#app-state')?.textContent?.trim();
        const cancel = document.querySelector('[data-testid="recovery-cancel"]');
        const reload = document.querySelector('[data-testid="recovery-reload"]');
        return (
          state === 'Selecciona un vídeo para iniciar la conversión' &&
          !cancel &&
          reload instanceof HTMLButtonElement &&
          !reload.disabled
        );
      },
      undefined,
      { timeout: 180_000 }
    );
    const observed = await page.evaluate(() => {
      globalThis.__wmcBusyRecovery.observer.disconnect();
      return globalThis.__wmcBusyRecovery.record;
    });
    assert.equal(observed.sawCancellingState, true, 'Cancellation transition was not observed');
    assert.equal(observed.sawDisabledCancel, true, 'Cancellation did not guard repeated action');
    assert.equal(observed.sawProtectedReload, true, 'Reload was not protected during cancellation');
    assert.equal(
      await fallback.locator('[data-testid="recovery-result-download"]').count(),
      0,
      'Cancelled conversion produced a result'
    );
    assert.equal(
      await page.evaluate(() => performance.timeOrigin),
      origin,
      'Busy recovery navigated before work settled'
    );
    const log = await readLogExport(page);
    assert.match(log.text, /app\.feature-render-failed/);
    assert.equal(events.pageErrors.length, 0);
    assert.deepEqual(events.failedRequests, []);
    assert.deepEqual(events.failedResponses, []);
    assert.deepEqual(
      events.consoleErrors.filter(
        (item) => !item.text.includes('Controlled result formatter render failure')
      ),
      [],
      'Unrelated console error during busy recovery'
    );
    await reload.click();
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    assert.notEqual(
      await page.evaluate(() => performance.timeOrigin),
      origin,
      'Approved post-cancellation reload did not navigate'
    );
    return {
      id: 'busy-render-fallback-cancellation',
      status: 'passed',
      sourceSha: build.state.sourceSha,
      activeProgress,
      terminalState: 'idle',
      observed,
      timeOriginUnchangedThroughCancellation: true,
      noResult: true,
      explicitReloadAfterTerminal: true,
      logExport: { sha256: log.sha256, bytes: log.bytes },
      screenshotSha256: sha256(await readFile(screenshot)),
      events,
    };
  } finally {
    await page
      .evaluate(() => {
        globalThis.__wmcRestoreNumberFormat?.();
        globalThis.__wmcBusyRecovery?.observer.disconnect();
      })
      .catch(() => {});
    await context.close();
  }
}

async function observeFreshBWhileARetained(
  browser: Browser,
  started: StartedServer,
  buildB: Build,
  retainedPage: Page,
  oldDocument: number
) {
  const context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const entryPath = assetPath(buildB.main);
    const pendingEntry = page
      .waitForResponse((response) => new URL(response.url()).pathname === entryPath, {
        timeout: 20_000,
      })
      .then(
        (response) => ({ response }),
        (error) => ({ error })
      );
    const document = await page.goto(started.url);
    assert.equal(document?.status(), 200, 'Fresh B document did not load');
    assert.equal(
      sha256(await document.body()),
      buildB.indexSha256,
      'Fresh tab did not receive B HTML'
    );
    const entryOutcome = await pendingEntry;
    if ('error' in entryOutcome) throw entryOutcome.error;
    const entry = entryOutcome.response;
    assert.equal(entry.status(), 200, 'Fresh B entry did not load');
    assert.equal(sha256(await entry.body()), buildB.main.sha256, 'Fresh tab did not receive B JS');
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    const scripts = await page.evaluate(() =>
      [...globalThis.document.scripts]
        .map((script) => (script.src ? new URL(script.src).pathname : null))
        .filter(Boolean)
    );
    assert(scripts.includes(entryPath), 'Fresh B tab did not execute B entry');
    assert.equal(
      await retainedPage.evaluate(() => performance.timeOrigin),
      oldDocument,
      'Opening B in a fresh tab navigated the retained A document'
    );
    return {
      sourceSha: buildB.state.sourceSha,
      indexSha256: buildB.indexSha256,
      entryPath,
      entrySha256: buildB.main.sha256,
      retainedATimeOriginUnchanged: true,
    };
  } finally {
    await context.close();
  }
}

async function buildUpgradeMissingAsset(
  browser: Browser,
  started: StartedServer,
  buildA: Build,
  buildB: Build,
  fixture: string,
  outputRoot: string,
  controlled: boolean
) {
  await started.setDistribution(buildA.relativePath);
  const oldChunk = emittedAsset(buildA, /^assets\/es[.-][\w-]{8}\.js$/);
  const newChunk = emittedAsset(buildB, /^assets\/es[.-][\w-]{8}\.js$/);
  assert.notEqual(oldChunk.sha256, newChunk.sha256, 'A/B optional dependency bytes did not change');
  assert.notEqual(oldChunk.path, newChunk.path, 'A/B optional dependency URL did not change');
  assert.equal(
    buildB.state.files.some((file) => file.path === oldChunk.path),
    false,
    'B still serves A optional asset'
  );
  const context = await browser.newContext({
    locale: 'en-US',
    acceptDownloads: true,
    serviceWorkers: controlled ? 'allow' : 'block',
  });
  const page = await context.newPage();
  const events = observePage(page);
  try {
    await requireApp(page, started.url);
    if (controlled) {
      await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
      await page.reload();
      await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    }
    assert.equal(
      await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
      controlled,
      'A/B optional import did not use requested SW state'
    );
    if (controlled) await captureWorkerAssetMessages(page);
    const oldDocument = await page.evaluate(() => performance.timeOrigin);
    const result = await createSmallGif(page, fixture);
    await assertNeverFetched(page, assetPath(oldChunk));
    await started.setDistribution(buildB.relativePath);
    const freshB = await observeFreshBWhileARetained(browser, started, buildB, page, oldDocument);
    const path = await triggerLocaleFailure(page, started, oldChunk, 'missing-after-update');
    const workerMessage = controlled
      ? await requireWorkerAssetMessage(page, path, 404, 'invalid-response')
      : null;
    assert(
      started.missingAssetResponses.some((entry) => entry.path === path && entry.status === 404),
      'B origin did not return 404 for the never-fetched A asset'
    );
    assert.equal(
      await page.evaluate(() => performance.timeOrigin),
      oldDocument,
      'Missing A asset navigated without user approval'
    );
    const notice = page.getByRole('status').filter({
      has: page.getByRole('button', { name: 'Reload page' }),
    });
    const reload = notice.getByRole('button', { name: 'Reload page' });
    assert.equal(await reload.isDisabled(), true, 'Retained result allowed immediate reload');
    const retained = await readResultDownload(page);
    assert.equal(sha256(retained), result.sha256);
    await notice.getByRole('button', { name: 'Clear result' }).click();
    assert.equal(await reload.isEnabled(), true, 'Explicit result clearing did not unlock reload');
    const log = await readLogExport(page);
    assert.match(log.text, /i18n\.load-failed/);
    assert.match(log.text, /app\.asset-unavailable/);
    assertExpectedNetwork(events, path);
    await reload.click();
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    assert.notEqual(await page.evaluate(() => performance.timeOrigin), oldDocument);
    const scripts = await page.evaluate(() =>
      [...document.scripts]
        .map((script) => (script.src ? new URL(script.src).pathname : null))
        .filter(Boolean)
    );
    assert(scripts.includes(assetPath(buildB.main)), 'Approved reload did not load B entry');
    const screenshot = join(
      outputRoot,
      `recovery-a-to-b-${controlled ? 'controlled' : 'blocked'}.png`
    );
    await page.screenshot({ path: screenshot, fullPage: true });
    return {
      id: `fixed-a-to-b-${controlled ? 'controlled' : 'blocked'}`,
      status: 'passed',
      sourceA: buildA.state.sourceSha,
      sourceB: buildB.state.sourceSha,
      oldNeverFetchedChunk: path,
      oldChunkSha256: oldChunk.sha256,
      missingOldAssetOriginStatus: 404,
      newChunk: assetPath(newChunk),
      newChunkSha256: newChunk.sha256,
      workerByteIdentical: buildA.workerSha256 === buildB.workerSha256,
      workerMessage,
      freshB,
      retainedOutputSha256: result.sha256,
      recoveryDownloadedSha256: sha256(retained),
      protectedResultBeforeReload: true,
      explicitClearAndReload: true,
      logExport: { sha256: log.sha256, bytes: log.bytes },
      screenshotSha256: sha256(await readFile(screenshot)),
      events,
    };
  } finally {
    await context.close();
    await started.setDistribution('dist');
  }
}

export async function runRecoveryBuilds({
  browser,
  bundleRoot,
  outputRoot,
  config,
  startStaticServer,
  closeServer,
  validateBundleFile,
}: {
  browser: Browser;
  bundleRoot: string;
  outputRoot: string;
  config: unknown;
  startStaticServer: (root: string, options?: { gzipAssets?: boolean }) => Promise<StartedServer>;
  closeServer: (server: Server) => Promise<void>;
  validateBundleFile: (root: string, relativePath: string) => Promise<string>;
}) {
  const diagnostics: RecoveryDiagnostics = {
    profile: 'wmc-media-recovery',
    status: 'incomplete',
    checks: [],
    builds: {},
    coldTransfer: { encoding: 'gzip', budgetBytesExclusive: 150_000, baseline: null, B: null },
    activeCheck: null,
    failure: null,
    assertionProbe: false,
  };
  let started: StartedServer | undefined;
  try {
    requireRecoverySelector(config);
    diagnostics.assertionProbe = config.assertionProbe === true;
    const [baseline, buildA, buildB, fixture, busyFixture] = await Promise.all([
      readBuild(bundleRoot, RECOVERY_BASELINE, validateBundleFile, {
        verifyInventory: true,
        exactInventory: true,
      }),
      readBuild(bundleRoot, RECOVERY_A, validateBundleFile, {
        verifyInventory: true,
        exactInventory: true,
      }),
      readBuild(bundleRoot, 'dist', validateBundleFile, {
        verifyInventory: true,
        exactInventory: true,
      }),
      validateBundleFile(bundleRoot, 'public/test-video-ci-h264.mp4'),
      validateBundleFile(bundleRoot, RECOVERY_BUSY_FIXTURE),
    ]);
    const busyFixtureBytes = await readFile(busyFixture);
    assert.equal(
      sha256(busyFixtureBytes),
      config.busyFixtureSha256,
      'Busy conversion fixture differs from selector'
    );
    diagnostics.busyFixture = { sha256: config.busyFixtureSha256, bytes: busyFixtureBytes.length };
    for (const [name, build, source, tree] of [
      ['baseline', baseline, config.baselineSourceSha, config.baselineTreeSha],
      ['A', buildA, config.sourceA, config.treeA],
      ['B', buildB, config.sourceB, config.treeB],
    ] as const) {
      assert.equal(build.state.sourceSha, source, `${name} source differs from selector`);
      assert.equal(build.state.treeSha, tree, `${name} tree differs from selector`);
      diagnostics.builds[name] = {
        sourceSha: source,
        treeSha: tree,
        coreSha: build.state.coreSha,
        version: build.state.version,
        manifestSha256: build.manifestSha256,
        inventorySha256: sha256(JSON.stringify(build.state.files)),
        entry: build.main,
        indexSha256: build.indexSha256,
        workerSha256: build.workerSha256,
        headersSha256: build.state.headersSha256,
      };
    }
    assert.equal(
      baseline.state.sourceSha,
      '0be5f0022fbde2231964273d5723317af5e68882',
      'Red control is not the reviewed #311 baseline'
    );
    assert.notEqual(baseline.state.sourceSha, buildA.state.sourceSha);
    assert.notEqual(buildA.state.sourceSha, buildB.state.sourceSha);
    assert.equal(buildA.state.coreSha, buildB.state.coreSha);
    assert.equal(buildA.state.version, buildB.state.version);
    assert.equal(
      buildA.workerSha256,
      buildB.workerSha256,
      'A/B worker must be byte-identical for missing-asset recovery control'
    );
    started = await startStaticServer(bundleRoot, { gzipAssets: true });
    const ownedStarted = started;
    const add = async (id: string, promise: Promise<RecoveryCheck>) => {
      diagnostics.activeCheck = id;
      const check = await promise;
      diagnostics.checks.push(check);
      await writeFile(
        join(outputRoot, 'recovery-diagnostics.json'),
        JSON.stringify(diagnostics, null, 2)
      );
      assert.equal(check.events?.overflow, false, `${id} exceeded bounded event capture`);
      assert.equal(
        ownedStarted.observedAssetOverflow,
        false,
        'Origin asset observation overflowed'
      );
      diagnostics.activeCheck = null;
    };
    await add(
      'baseline-first-error-red',
      baselineFirstError(browser, started, baseline, outputRoot)
    );
    await add(
      'baseline-first-pipeline-offline-blocked',
      firstPipelineImportFailure(browser, started, baseline, fixture, outputRoot, false, true)
    );
    await started.setDistribution(baseline.relativePath);
    diagnostics.coldTransfer.baseline = await measureColdTransfer(browser, started, baseline);
    await writeFile(
      join(outputRoot, 'recovery-diagnostics.json'),
      JSON.stringify(diagnostics, null, 2)
    );
    if (config.assertionProbe === true)
      assert.fail('Controlled recovery assertion probe after persisted baseline evidence');
    await started.setDistribution(buildB.relativePath);
    diagnostics.coldTransfer.B = await measureColdTransfer(browser, started, buildB);
    await writeFile(
      join(outputRoot, 'recovery-diagnostics.json'),
      JSON.stringify(diagnostics, null, 2)
    );
    await add('fixed-first-error-offline', fixedFirstError(browser, started, buildB, outputRoot));
    for (const controlled of [false, true])
      await add(
        `fixed-first-pipeline-network-${controlled ? 'controlled' : 'blocked'}`,
        firstPipelineImportFailure(browser, started, buildB, fixture, outputRoot, controlled, false)
      );
    await add(
      'fixed-memory-warning-offline',
      memoryWarningOffline(browser, started, buildB, fixture)
    );
    await add(
      'ordinary-result-render-fallback',
      ordinaryRenderFailure(browser, started, buildB, fixture, outputRoot)
    );
    await add(
      'busy-render-fallback-cancellation',
      busyRenderFailure(browser, started, buildB, busyFixture, outputRoot)
    );
    for (const controlled of [false, true]) {
      for (const mode of ['404', 'wrong-mime', 'network'] as const)
        await add(
          `optional-${mode}-${controlled ? 'controlled' : 'blocked'}`,
          optionalFailureCase(browser, started, buildB, fixture, outputRoot, mode, controlled)
        );
      await add(
        `optional-offline-miss-${controlled ? 'controlled' : 'blocked'}`,
        offlineOptionalMiss(browser, started, buildB, fixture, outputRoot, controlled)
      );
    }
    for (const controlled of [false, true])
      await add(
        `fixed-a-to-b-${controlled ? 'controlled' : 'blocked'}`,
        buildUpgradeMissingAsset(browser, started, buildA, buildB, fixture, outputRoot, controlled)
      );
    diagnostics.status = 'passed';
    return diagnostics;
  } catch (error) {
    diagnostics.status = 'failed';
    diagnostics.failure = String(error)
      .replaceAll(bundleRoot, '<bundle>')
      .replaceAll(outputRoot, '<evidence>')
      .slice(0, 1000);
    throw error;
  } finally {
    if (started) {
      diagnostics.server = {
        observedAssetRequests: started.observedAssetRequests,
        observedAssetOverflow: started.observedAssetOverflow,
        injectedAssetRequests: started.assetFailureRequests,
        missingAssetResponses: started.missingAssetResponses,
      };
    }
    let cleanupFailure = null;
    if (started) {
      try {
        await closeServer(started.server);
      } catch (error) {
        cleanupFailure = error;
        diagnostics.status = 'failed';
        diagnostics.cleanupFailure = String(error).slice(0, 500);
      }
    }
    await writeFile(
      join(outputRoot, 'recovery-diagnostics.json'),
      JSON.stringify(diagnostics, null, 2)
    );
    // Raise cleanup failure only when no check already failed.
    if (cleanupFailure && !diagnostics.failure) throw cleanupFailure;
  }
}

/** Select only a real prior-only JavaScript asset that no prior tab cached. */
export function selectRemovedUncachedAsset(
  oldOnly: string[],
  cachedPaths: string[]
): string | undefined {
  return oldOnly.find((name) => name.endsWith('.js') && !cachedPaths.includes(`/assets/${name}`));
}
