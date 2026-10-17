// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type {
  Browser,
  BrowserContext,
  Page,
  Response as PlaywrightResponse,
} from '@playwright/test';

type CleanupError = Error & { cleanupErrors?: string[] };
type ValidateBundleFile = (root: string, relativePath: string) => Promise<string>;
type Artifact = { kind: string; file: string; bytes: number; sha256: string };
type InventoryFile = { path: string; size: number; sha256: string };
type BuildState = {
  schemaVersion: number;
  sourceSha: string;
  treeSha: string;
  coreSha: string;
  headersSha256: string;
  sourceDirty: boolean;
  version: string;
  files: InventoryFile[];
};
type Build = {
  relativePath: string;
  state: BuildState;
  main: InventoryFile;
  manifestSha256: string;
  indexSha256: string;
  workerSha256: string;
};
type StartedServer = {
  server: Server;
  url: string;
  setDistribution: (relativePath: string) => Promise<void>;
};
type StaticServerOptions = {
  gzipAssets?: boolean;
  metadataHandler?: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
};
type StartStaticServer = (root: string, options?: StaticServerOptions) => Promise<StartedServer>;
type MetadataBody = { bytes: Buffer; error?: never } | { error: string; bytes?: never };
type MetadataResponse = {
  status: number;
  path: string;
  body: Promise<MetadataBody>;
  atMs: number;
};
type RuntimeRecord = {
  origin: string;
  pageErrors: string[];
  consoleErrors: string[];
  failedRequests: { path: string; error: string; atMs: number }[];
  failedResponses: { path: string; status: number }[];
  uploads: string[];
  external: string[];
  metadataRequests: { atMs: number; method: string }[];
  metadataResponses: MetadataResponse[];
  metadataOverflow: boolean;
  offlineMetadataFailures: { path: string; error: string; atMs: number }[];
  offline: boolean;
  transportGates?: MetadataGateState[];
  failurePageState?: {
    lifecycle: string[];
    visibility: DocumentVisibilityState;
    online: boolean;
    timeOrigin: number;
  };
  failurePageStateError?: string;
};
type MetadataGateState = {
  active: boolean;
  queued: number;
  queuedAtMs: number | null;
  releasedAtMs: number | null;
  nativeStartedAtMs: number | null;
};
type AppUpdateConfig = {
  buildA: string;
  baseline: string;
  baselineSourceSha: string;
  baselineTreeSha: string;
  cleanupBaseline: string;
  cleanupBaselineSourceSha: string;
  cleanupBaselineTreeSha: string;
};
type CleanupCaseSpec = {
  id: string;
  status: number;
  contentType: string;
  contentLength?: number;
  prefix: string;
};
type CleanupResponseRecord = {
  status: number;
  kind: string;
  startedAtMs: number;
  closedAtMs: number | null;
  finishedAtMs: number | null;
  response: ServerResponse;
  closed: Promise<void>;
};
type ResponseWaitOutcome =
  | { record: CleanupResponseRecord; error?: never }
  | { error: string; record?: never };
type ResponseWaiter = {
  number: number;
  resolve: (outcome: ResponseWaitOutcome) => void;
  timer?: ReturnType<typeof setTimeout>;
};
type ResponseSnapshot = ReturnType<typeof responseSnapshot>;
type CleanupCaseResult = {
  build: string;
  case: string;
  responseBodies: ResponseSnapshot[];
  signalEvents: { startedAtMs: number; abortedAtMs: number | null }[];
  pageErrors: string[];
  consoleErrors: { text: string; location: string }[];
  failedRequests: { path: string; error: string }[];
  failedResponses: { path: string; status: number }[];
  cleanupErrors: string[];
  firstMIMEObservedAfterMs?: number;
  firstMIMEStillOpenAfterDeadline?: boolean;
  rejectedCleanup?: {
    observedAtMs: number;
    responseBodies: ResponseSnapshot[];
    unfinishedResponseWork: number;
    signalEvents: CleanupCaseResult['signalEvents'];
  };
  validDetection?: {
    sourceSha: string;
    response: ResponseSnapshot;
    notice: boolean;
    automaticNavigation: boolean;
    thirdSignalAborted: boolean;
  };
  status?: string;
  error?: string;
  observedAtMs?: number;
  unfinishedBeforeTeardown?: number;
  signalCaptureError?: string;
};
declare global {
  var __appUpdateCspViolations: string[];
  var __appUpdateLifecycle: string[];
  var __appUpdateWorkerEvents: string[];
  var __appUpdateMetadataTransportGate: {
    state: MetadataGateState;
    release: () => MetadataGateState;
  };
  var __cleanupCspViolations: string[];
  var __cleanupFetchOverflow: boolean;
  var __cleanupFetchSignals: { startedAtMs: number; abortedAtMs: number | null }[];
}

const SMALL_FIXTURE = 'public/test-video-ci-h264.mp4';
const HIGH_MOTION_FIXTURE = 'validation/windows/inputs/cancel-high-motion.mp4';
const METADATA_PATH = '/deployment-state.json';
const NOTICE_TEXT = 'The app has changed. Reload when you are ready.';
const MAX_METADATA_BYTES = 64 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CLEANUP_RELEASE_MS = 3_000;
const CLEANUP_SECOND_ATTEMPT_MS = 61_000;
const BASELINE_MIME_OBSERVATION_MS = 11_000;

const CLEANUP_CASES = [
  { id: 'mime', status: 200, contentType: 'text/html', prefix: '<html>' },
  {
    id: 'length',
    status: 200,
    contentType: 'application/json',
    contentLength: 65_537,
    prefix: '{"partial":',
  },
  { id: 'status', status: 503, contentType: 'application/json', prefix: '{"unavailable":' },
];

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceShaFromJson(value: unknown): string {
  assert(value && typeof value === 'object' && 'sourceSha' in value, 'Missing source SHA');
  assert(typeof value.sourceSha === 'string' && SHA.test(value.sourceSha), 'Invalid source SHA');
  return value.sourceSha;
}

function assertBuildState(value: unknown): asserts value is BuildState {
  assert(value && typeof value === 'object', 'Invalid deployment metadata');
  assert('schemaVersion' in value && value.schemaVersion === 1);
  assert('sourceSha' in value && typeof value.sourceSha === 'string' && SHA.test(value.sourceSha));
  assert('treeSha' in value && typeof value.treeSha === 'string' && SHA.test(value.treeSha));
  assert('coreSha' in value && typeof value.coreSha === 'string' && SHA.test(value.coreSha));
  assert(
    'headersSha256' in value &&
      typeof value.headersSha256 === 'string' &&
      DIGEST.test(value.headersSha256)
  );
  assert('sourceDirty' in value && value.sourceDirty === false);
  assert(
    'version' in value && typeof value.version === 'string' && /^\d+\.\d+\.\d+/.test(value.version)
  );
  assert('files' in value && Array.isArray(value.files));
  assert(value.files.length > 0 && value.files.length <= 100);
  for (const file of value.files) {
    assert(file && typeof file === 'object');
    assert('path' in file && typeof file.path === 'string');
    assert('size' in file && typeof file.size === 'number');
    assert('sha256' in file && typeof file.sha256 === 'string');
  }
}

export async function readBuild(
  bundleRoot: string,
  relativePath: string,
  validateBundleFile: ValidateBundleFile,
  { requireCompiledSource = true, verifyInventory = false, exactInventory = false } = {}
) {
  const path = await validateBundleFile(bundleRoot, `${relativePath}/deployment-state.json`);
  const bytes = await readFile(path);
  assert(bytes.length > 0 && bytes.length <= MAX_METADATA_BYTES, `${relativePath} metadata size`);
  const state: unknown = JSON.parse(bytes.toString('utf8'));
  assertBuildState(state);
  assert.equal(state.sourceDirty, false, `${relativePath} must be built from clean source`);
  if (verifyInventory) {
    const seen = new Set<string>();
    for (const file of state.files) {
      assert(
        typeof file.path === 'string' &&
          file.path.length > 0 &&
          !file.path.startsWith('/') &&
          !file.path.includes('\\') &&
          file.path.split('/').every((part) => part && part !== '.' && part !== '..'),
        `${relativePath} has unsafe inventory path`
      );
      assert(!seen.has(file.path), `${relativePath} has duplicate inventory path ${file.path}`);
      seen.add(file.path);
      assert(
        Number.isSafeInteger(file.size) && file.size >= 0 && DIGEST.test(file.sha256),
        `${relativePath} invalid inventory entry ${file.path}`
      );
      const fileBytes = await readFile(
        await validateBundleFile(bundleRoot, `${relativePath}/${file.path}`)
      );
      assert.equal(fileBytes.length, file.size, `${relativePath}/${file.path} size differs`);
      assert.equal(sha256(fileBytes), file.sha256, `${relativePath}/${file.path} hash differs`);
    }
    const headers = await readFile(
      await validateBundleFile(bundleRoot, `${relativePath}/_headers`)
    );
    assert.equal(sha256(headers), state.headersSha256, `${relativePath} _headers hash differs`);
    if (exactInventory) {
      const actual: string[] = [];
      let visited = 0;
      const visit = async (directory: string, prefix = ''): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const child = prefix ? `${prefix}/${entry.name}` : entry.name;
          visited += 1;
          assert(visited <= 128, `${relativePath} distribution has too many entries`);
          if (entry.isDirectory()) await visit(join(directory, entry.name), child);
          else {
            assert(entry.isFile(), `${relativePath} contains a non-file inventory entry ${child}`);
            actual.push(child);
          }
        }
      };
      await visit(join(bundleRoot, relativePath));
      assert.deepEqual(
        actual.sort(),
        [...seen, '_headers', 'deployment-state.json'].sort(),
        `${relativePath} emitted file inventory differs from its manifest`
      );
    }
  }
  const main = state.files.find((file) => /^assets\/index\.[\w-]{8}\.js$/.test(file.path));
  assert(main && DIGEST.test(main.sha256), `${relativePath} has no source-bound app entry`);
  const mainBytes = await readFile(
    await validateBundleFile(bundleRoot, `${relativePath}/${main.path}`)
  );
  assert.equal(sha256(mainBytes), main.sha256, `${relativePath} app entry differs from inventory`);
  if (requireCompiledSource)
    assert(
      mainBytes.includes(state.sourceSha),
      `${relativePath} app entry has no compiled source identity`
    );
  const index = await readFile(await validateBundleFile(bundleRoot, `${relativePath}/index.html`));
  const worker = await readFile(
    await validateBundleFile(bundleRoot, `${relativePath}/service-worker.js`)
  );
  assert(
    index.toString('utf8').includes(`/${main.path}`),
    `${relativePath} HTML does not load its app entry`
  );
  return {
    relativePath,
    state,
    main,
    manifestSha256: sha256(bytes),
    indexSha256: sha256(index),
    workerSha256: sha256(worker),
  };
}

function updateNotice(page: Page) {
  return page.getByRole('status').filter({ hasText: NOTICE_TEXT });
}

function anyUpdateNotice(page: Page) {
  return page.getByRole('status').filter({
    has: page.getByRole('button', { name: 'Reload page' }),
  });
}

// Attach both outcomes immediately: an earlier assertion may close the page
// before the awaited response arrives.
export function captureResponseWait(
  page: Page,
  predicate: (response: PlaywrightResponse) => boolean,
  timeout: number
) {
  return page.waitForResponse(predicate, { timeout }).then(
    (response) => ({ response }),
    (error) => ({ error })
  );
}

async function requireResponse(waiter: ReturnType<typeof captureResponseWait>) {
  const outcome = await waiter;
  if ('error' in outcome) throw outcome.error;
  return outcome.response;
}

async function startGif(page: Page, fixture: string, { highMotion = false } = {}) {
  await page.locator('#file-upload').setInputFiles(fixture);
  await page
    .getByRole('radiogroup', { name: 'Output Format' })
    .getByRole('radio', { name: /^GIF/ })
    .check();
  await page
    .getByRole('radiogroup', { name: 'Quality Preset' })
    .getByRole('radio', { name: highMotion ? /^High/ : /^Low/ })
    .check();
  await page
    .getByRole('radiogroup', { name: 'Output Scale' })
    .getByRole('radio', { name: highMotion ? /^100%/ : /^50%/ })
    .check();
  const convert = page.getByRole('button', { name: 'Convert', exact: true });
  await convert.waitFor({ state: 'visible' });
  await convert.click();
  const proceed = page.getByRole('button', { name: 'Proceed with conversion despite warnings' });
  if (await proceed.isVisible({ timeout: 1_500 }).catch(() => false)) await proceed.click();
}

async function downloadGif(page: Page) {
  const link = page.getByRole('link', { name: /^Download GIF file —/ });
  await link.waitFor({ state: 'visible', timeout: 120_000 });
  const href = await link.getAttribute('href');
  assert(href?.startsWith('blob:'), 'GIF result has no Blob download');
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  const bytes = await readFile(await download.path());
  assert.match(bytes.subarray(0, 6).toString('ascii'), /^GIF8[79]a$/);
  return { bytes, href, filename: download.suggestedFilename() };
}

async function instrument(page: Page, record: RuntimeRecord) {
  page.on('pageerror', (error) => record.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') record.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    const error = request.failure()?.errorText ?? 'unknown';
    if (url.protocol === 'blob:' && error === 'net::ERR_ABORTED') return;
    const entry = { path: url.pathname, error, atMs: performance.now() };
    if (record.offline && url.pathname === METADATA_PATH)
      record.offlineMetadataFailures.push(entry);
    else record.failedRequests.push(entry);
  });
  page.on('request', (request) => {
    if (!['GET', 'HEAD'].includes(request.method()))
      record.uploads.push(`${request.method()} ${request.url()}`);
    if (!request.url().startsWith('blob:') && new URL(request.url()).origin !== record.origin)
      record.external.push(request.url());
    if (new URL(request.url()).pathname !== METADATA_PATH) return;
    if (record.metadataRequests.length === 128) {
      record.metadataOverflow = true;
      return;
    }
    record.metadataRequests.push({ atMs: performance.now(), method: request.method() });
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname === METADATA_PATH) {
      if (record.metadataResponses.length === 128) {
        record.metadataOverflow = true;
        return;
      }
      record.metadataResponses.push({
        status: response.status(),
        path: url.pathname,
        body: response.body().then(
          (bytes) => ({ bytes }),
          (error) => ({ error: String(error) })
        ),
        atMs: performance.now(),
      });
    } else if (response.status() >= 400) {
      record.failedResponses.push({ path: url.pathname, status: response.status() });
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem('dropconvert.locale', 'en');
    globalThis.__appUpdateCspViolations = [];
    globalThis.__appUpdateLifecycle = [];
    window.addEventListener('pageshow', () => globalThis.__appUpdateLifecycle.push('pageshow'));
    window.addEventListener('offline', () => globalThis.__appUpdateLifecycle.push('offline'));
    window.addEventListener('online', () => globalThis.__appUpdateLifecycle.push('online'));
    document.addEventListener('visibilitychange', () => {
      globalThis.__appUpdateLifecycle.push(`visibility:${document.visibilityState}`);
    });
    document.addEventListener('securitypolicyviolation', (event) => {
      globalThis.__appUpdateCspViolations.push(`${event.effectiveDirective}: ${event.blockedURI}`);
    });
  });
}

async function waitForConnectivityEvent(
  page: Page,
  fromIndex: number,
  event: string,
  online: boolean
) {
  await page.waitForFunction(
    ({ fromIndex, event, online }) =>
      navigator.onLine === online &&
      globalThis.__appUpdateLifecycle.slice(fromIndex).includes(event),
    { fromIndex, event, online },
    { polling: 100, timeout: 10_000 }
  );
}

async function installOnlineMetadataTransportGate(page: Page) {
  await page.evaluate(() => {
    if (globalThis.__appUpdateMetadataTransportGate?.state.active)
      throw new Error('Metadata transport gate was already active');
    const nativeFetch = globalThis.fetch;
    let open: () => void = () => {};
    const restored = new Promise<void>((resolveOpen) => {
      open = resolveOpen;
    });
    const state: MetadataGateState = {
      active: true,
      queued: 0,
      queuedAtMs: null,
      releasedAtMs: null,
      nativeStartedAtMs: null,
    };
    globalThis.__appUpdateMetadataTransportGate = {
      state,
      release() {
        if (state.active) {
          globalThis.fetch = nativeFetch;
          state.active = false;
          state.releasedAtMs = performance.now();
          open();
        }
        return { ...state };
      },
    };
    globalThis.fetch = function (...args: Parameters<typeof fetch>) {
      const input = args[0];
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.origin !== location.origin || url.pathname !== '/deployment-state.json')
        return Reflect.apply(nativeFetch, this, args);
      state.queued++;
      state.queuedAtMs = performance.now();
      // Retain the fetch receiver across the asynchronous transport gate.
      const receiver = this;
      // Retain the original request and signal; only native transport waits for
      // Playwright to finish restoring the controlling service-worker session.
      return restored.then(() => {
        state.nativeStartedAtMs = performance.now();
        return Reflect.apply(nativeFetch, receiver, args);
      });
    };
  });
}

async function releaseOnlineMetadataTransportGate(page: Page) {
  return page.evaluate(() => {
    const gate = globalThis.__appUpdateMetadataTransportGate;
    return gate?.state.active ? gate.release() : null;
  });
}

async function assertOnlineMetadataTransportStarted(page: Page, record: RuntimeRecord) {
  const gate = await page.evaluate(() => ({
    ...globalThis.__appUpdateMetadataTransportGate?.state,
  }));
  assert(record.transportGates);
  assert.equal(record.transportGates.length, 1);
  assert.equal(gate.queued, 1);
  assert(
    gate.nativeStartedAtMs !== null &&
      gate.releasedAtMs !== null &&
      gate.nativeStartedAtMs >= gate.releasedAtMs,
    'Native metadata Fetch started before transport restoration completed'
  );
  assert(record.transportGates);
  record.transportGates[0] = gate;
}

async function restoreOnlineWithMetadataGate(
  page: Page,
  context: BrowserContext,
  record: RuntimeRecord,
  lifecycleStart: number
) {
  await installOnlineMetadataTransportGate(page);
  let released = false;
  let primaryError: CleanupError | undefined;
  try {
    await context.setOffline(false);
    record.offline = false;
    await waitForConnectivityEvent(page, lifecycleStart, 'online', true);
    const queued = await page.evaluate(
      () => globalThis.__appUpdateMetadataTransportGate.state.queued
    );
    assert.equal(queued, 1, 'Online event did not queue exactly one metadata Fetch');
    const gate = await releaseOnlineMetadataTransportGate(page);
    released = true;
    assert(gate, 'Metadata transport gate disappeared before release');
    assert(record.transportGates);
    record.transportGates.push(gate);
    assert.equal(gate.queued, 1);
    assert(
      gate.queuedAtMs !== null && gate.releasedAtMs !== null,
      'Metadata transport gate has no request/release timestamps'
    );
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    if (!released) {
      try {
        const gate = await releaseOnlineMetadataTransportGate(page);
        assert(record.transportGates);
        if (gate) record.transportGates.push(gate);
      } catch (error) {
        if (primaryError)
          primaryError.cleanupErrors = [
            ...(primaryError.cleanupErrors ?? []),
            `metadata transport gate release: ${String(error)}`,
          ];
        // Cleanup failure is raised only when no primary failure exists.
        else throw error;
      }
    }
  }
}

async function assertRuntimeHealth(page: Page, record: RuntimeRecord) {
  assert.deepEqual(record.pageErrors, []);
  assert.deepEqual(record.consoleErrors, []);
  assert.deepEqual(record.failedRequests, []);
  assert.deepEqual(record.failedResponses, []);
  assert.deepEqual(record.uploads, []);
  assert.deepEqual(record.external, []);
  assert.equal(record.metadataOverflow, false);
  assert.deepEqual(await page.evaluate(() => globalThis.__appUpdateCspViolations ?? []), []);
}

async function metadataObservation(record: RuntimeRecord) {
  return Promise.all(
    record.metadataResponses.map(async ({ status, path, body, atMs }) => {
      const captured = await body;
      assert(
        'bytes' in captured,
        `Metadata response body capture failed for ${path}: ${captured.error}`
      );
      const { bytes } = captured;
      assert(bytes.length <= MAX_METADATA_BYTES, 'Observed metadata exceeds 64KiB');
      let sourceSha = null;
      if (status === 200) sourceSha = sourceShaFromJson(JSON.parse(bytes.toString('utf8')));
      return { atMs, status, bytes: bytes.length, sourceSha };
    })
  );
}

async function writeArtifact(
  outputRoot: string,
  name: string,
  bytes: Buffer,
  artifacts: Artifact[],
  kind: string
) {
  await writeFile(join(outputRoot, name), bytes);
  artifacts.push({ kind, file: name, bytes: bytes.length, sha256: sha256(bytes) });
}

async function screenshot(page: Page, outputRoot: string, name: string, artifacts: Artifact[]) {
  await writeArtifact(outputRoot, name, await page.screenshot(), artifacts, 'screenshot');
}

async function watchRegistration(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    globalThis.__appUpdateWorkerEvents = [];
    registration.addEventListener('updatefound', () => {
      globalThis.__appUpdateWorkerEvents.push('updatefound');
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      globalThis.__appUpdateWorkerEvents.push('controllerchange');
    });
    return {
      controller: navigator.serviceWorker.controller?.scriptURL ?? null,
      active: registration.active?.scriptURL ?? null,
    };
  });
}

async function workerEvents(page: Page) {
  return page.evaluate(() => globalThis.__appUpdateWorkerEvents ?? []);
}

export async function measureColdTransfer(browser: Browser, started: StartedServer, build: Build) {
  let context: BrowserContext | undefined;
  let primaryError: CleanupError | undefined;
  try {
    context = await browser.newContext({ serviceWorkers: 'block', locale: 'en-US' });
    const page = await context.newPage();
    const metadataResponse = captureResponseWait(
      page,
      (response) => new URL(response.url()).pathname === METADATA_PATH,
      20_000
    );
    const document = await page.goto(started.url);
    assert.equal(document?.status(), 200);
    assert.equal(
      sha256(await document.body()),
      build.indexSha256,
      'Cold tab did not load expected HTML'
    );
    const metadata = await requireResponse(metadataResponse);
    assert.equal(metadata.status(), 200, 'Cold metadata request failed');
    const metadataBytes = await metadata.body();
    assert.equal(
      sourceShaFromJson(JSON.parse(metadataBytes.toString('utf8'))),
      build.state.sourceSha,
      'Cold metadata differs from served build'
    );
    await page.waitForLoadState('networkidle');
    const resources = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .filter((entry) => entry instanceof PerformanceResourceTiming)
        .map((entry) => ({
          path: new URL(entry.name).pathname,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
        }))
    );
    const js = resources.filter((entry) => entry.path.endsWith('.js'));
    const positive = js.filter((entry) => entry.transferSize > 0);
    const positiveBytes = positive.reduce((sum, entry) => sum + entry.transferSize, 0);
    const positiveEncodedBytes = positive.reduce((sum, entry) => sum + entry.encodedBodySize, 0);
    const positiveDecodedBytes = positive.reduce((sum, entry) => sum + entry.decodedBodySize, 0);
    assert(
      positive.length > 0 && positiveBytes > 0 && positiveBytes < 150_000,
      `Cold initial JS transfer ${positiveBytes} must be positive and below 150000 bytes`
    );
    assert(
      positiveEncodedBytes > 0 && positiveDecodedBytes >= positiveEncodedBytes,
      'Cold initial JS has no coherent encoded and decoded body sizes'
    );
    const metadataTimings = resources.filter((entry) => entry.path === METADATA_PATH);
    assert.equal(metadataTimings.length, 1, 'Cold context must request metadata exactly once');
    const metadataTiming = metadataTimings[0];
    assert(metadataTiming);
    assert(
      metadataTiming.transferSize > 0 && metadataTiming.encodedBodySize > 0,
      'Cold metadata has no positive network transfer'
    );
    assert.equal(
      metadataTiming.decodedBodySize,
      metadataBytes.length,
      'Cold metadata decoded transfer differs from response body'
    );
    return {
      sourceSha: build.state.sourceSha,
      js,
      positiveBytes,
      positiveEncodedBytes,
      positiveDecodedBytes,
      metadata: {
        count: metadataTimings.length,
        ...metadataTiming,
        responseBytes: metadataBytes.length,
      },
    };
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    if (context) {
      try {
        await context.close();
      } catch (error) {
        if (primaryError)
          primaryError.cleanupErrors = [
            ...(primaryError.cleanupErrors ?? []),
            `cold context close: ${String(error)}`,
          ];
        // Cleanup failure is raised only when no primary failure exists.
        else throw error;
      }
    }
  }
}

async function baselineBeforeFix(
  browser: Browser,
  started: StartedServer,
  bundleRoot: string,
  config: AppUpdateConfig,
  validateBundleFile: ValidateBundleFile,
  outputRoot: string,
  artifacts: Artifact[]
) {
  const baselineBuild = await readBuild(bundleRoot, config.baseline, validateBundleFile, {
    requireCompiledSource: false,
    verifyInventory: true,
  });
  assert.equal(
    baselineBuild.state.sourceSha,
    config.baselineSourceSha,
    'Before-fix baseline source differs from selected baseline commit'
  );
  assert.equal(
    baselineBuild.state.treeSha,
    config.baselineTreeSha,
    'Before-fix baseline tree differs from selected baseline commit'
  );
  const baselineIndex = await readFile(
    await validateBundleFile(bundleRoot, `${config.baseline}/index.html`)
  );
  const baselineWorker = await readFile(
    await validateBundleFile(bundleRoot, `${config.baseline}/service-worker.js`)
  );
  let context: BrowserContext | undefined;
  let primaryError: CleanupError | undefined;
  const record = {
    origin: new URL(started.url).origin,
    pageErrors: [],
    consoleErrors: [],
    failedRequests: [],
    failedResponses: [],
    uploads: [],
    external: [],
    metadataRequests: [],
    metadataResponses: [],
    metadataOverflow: false,
    offlineMetadataFailures: [],
    offline: false,
  };
  try {
    context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    await instrument(page, record);
    await started.setDistribution(config.baseline);
    const document = await page.goto(started.url);
    assert.equal(document?.status(), 200);
    assert.equal(sha256(await document.body()), sha256(baselineIndex), 'Before-fix HTML identity');
    await page.locator('#file-upload').waitFor({ state: 'attached' });
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    const initialWorker = await watchRegistration(page);
    const beforeTimeOrigin = await page.evaluate(() => performance.timeOrigin);
    await started.setDistribution(config.buildA);
    await context.setOffline(true);
    await context.setOffline(false);
    await page.bringToFront();
    await page.waitForTimeout(1_500);
    assert.equal(
      await anyUpdateNotice(page).isVisible(),
      false,
      'Before-fix app unexpectedly announced an unchanged-worker deployment'
    );
    assert.equal(
      await page.evaluate(() => performance.timeOrigin),
      beforeTimeOrigin,
      'Before-fix tab navigated without an explicit reload'
    );
    assert.equal(
      record.metadataResponses.length,
      0,
      'Before-fix app unexpectedly requested deployment metadata'
    );
    assert.equal(
      record.metadataRequests.length,
      0,
      'Before-fix app unexpectedly started deployment metadata checks'
    );
    const workerUpdates = await workerEvents(page);
    assert.deepEqual(workerUpdates, [], 'Before-fix unchanged worker unexpectedly updated');
    assert.equal(
      await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null),
      initialWorker.controller,
      'Before-fix worker controller changed'
    );
    await assertRuntimeHealth(page, record);
    await screenshot(page, outputRoot, 'app-update-before-fix.png', artifacts);
    return {
      source: 'prior-dist',
      sourceSha: baselineBuild.state.sourceSha,
      treeSha: baselineBuild.state.treeSha,
      inventoryFiles: baselineBuild.state.files.length,
      headersSha256: baselineBuild.state.headersSha256,
      indexSha256: sha256(baselineIndex),
      workerSha256: sha256(baselineWorker),
      initialWorker,
      workerUpdates,
      notice: false,
      metadataRequests: 0,
      documentRetained: true,
    };
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    const cleanupErrors = [];
    if (context) {
      try {
        await context.setOffline(false);
      } catch (error) {
        cleanupErrors.push(`baseline offline reset: ${String(error)}`);
      }
      try {
        await context.close();
      } catch (error) {
        cleanupErrors.push(`baseline context close: ${String(error)}`);
      }
    }
    if (primaryError && cleanupErrors.length)
      primaryError.cleanupErrors = [...(primaryError.cleanupErrors ?? []), ...cleanupErrors];
    // Cleanup failure is raised only when no primary failure exists.
    if (!primaryError && cleanupErrors.length) throw new Error(cleanupErrors.join('; '));
  }
}

function waitForResponseNumber(
  records: CleanupResponseRecord[],
  waiters: ResponseWaiter[],
  number: number
): Promise<ResponseWaitOutcome> {
  if (records.length >= number) {
    const record = records[number - 1];
    assert(record);
    return Promise.resolve({ record });
  }
  return new Promise<ResponseWaitOutcome>((resolveWait) => {
    const waiter: ResponseWaiter = { number, resolve: resolveWait };
    waiter.timer = setTimeout(() => {
      waiters.splice(waiters.indexOf(waiter), 1);
      resolveWait({ error: `Metadata response ${number} did not start within 20 seconds` });
    }, 20_000);
    waiters.push(waiter);
  });
}

async function requireRecord(waiter: Promise<ResponseWaitOutcome>) {
  const outcome = await waiter;
  if (outcome.error !== undefined) throw new Error(outcome.error);
  assert(outcome.record);
  return outcome.record;
}

async function waitForClosedResponse(record: CleanupResponseRecord) {
  if (record.closedAtMs !== null) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    record.closed.then(() => true),
    new Promise<boolean>((resolveWait) => {
      timer = setTimeout(() => resolveWait(false), CLEANUP_RELEASE_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return closed;
}

function responseSnapshot(record: CleanupResponseRecord) {
  return {
    kind: record.kind,
    status: record.status,
    startedAtMs: record.startedAtMs,
    closedAtMs: record.closedAtMs,
    finishedAtMs: record.finishedAtMs,
    releaseMs: record.closedAtMs === null ? null : record.closedAtMs - record.startedAtMs,
  };
}

async function observeCleanupCase({
  browser,
  bundleRoot,
  build,
  caseSpec,
  fixed,
  validMetadata,
  startStaticServer,
  closeServer,
  diagnostics,
}: {
  browser: Browser;
  bundleRoot: string;
  build: Build;
  caseSpec: CleanupCaseSpec;
  fixed: boolean;
  validMetadata: Buffer;
  startStaticServer: StartStaticServer;
  closeServer: (server: Server) => Promise<void>;
  diagnostics: CleanupCaseResult[];
}) {
  const records: CleanupResponseRecord[] = [];
  const waiters: ResponseWaiter[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: CleanupCaseResult['consoleErrors'] = [];
  const failedRequests: CleanupCaseResult['failedRequests'] = [];
  const failedResponses: CleanupCaseResult['failedResponses'] = [];
  let started: StartedServer | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let primaryError: CleanupError | undefined;
  const result: CleanupCaseResult = {
    build: fixed ? 'fixed' : 'original',
    case: caseSpec.id,
    responseBodies: [],
    signalEvents: [],
    pageErrors,
    consoleErrors,
    failedRequests,
    failedResponses,
    cleanupErrors: [],
  };
  diagnostics.push(result);
  try {
    started = await startStaticServer(bundleRoot, {
      metadataHandler(request, response) {
        assert.equal(request.method, 'GET', 'Metadata check changed HTTP method');
        assert(records.length < (fixed ? 3 : 2), 'Unexpected extra metadata request');
        const valid = fixed && records.length === 2;
        const record: CleanupResponseRecord = {
          status: valid ? 200 : caseSpec.status,
          kind: valid ? 'valid' : 'rejected',
          startedAtMs: performance.now(),
          closedAtMs: null,
          finishedAtMs: null,
          response,
          closed: Promise.resolve(),
        };
        record.closed = new Promise<void>((resolveClose) => {
          response.once('close', () => {
            record.closedAtMs = performance.now();
            resolveClose();
          });
        });
        response.once('finish', () => {
          record.finishedAtMs = performance.now();
        });
        records.push(record);
        response.writeHead(record.status, {
          'Content-Type': valid ? 'application/json' : caseSpec.contentType,
          'Cache-Control': 'no-store',
          ...(valid
            ? { 'Content-Length': String(validMetadata.length) }
            : caseSpec.contentLength
              ? { 'Content-Length': String(caseSpec.contentLength) }
              : {}),
        });
        if (valid) response.end(validMetadata);
        else response.write(caseSpec.prefix);
        for (const waiter of [...waiters]) {
          if (records.length < waiter.number) continue;
          if (waiter.timer) clearTimeout(waiter.timer);
          waiters.splice(waiters.indexOf(waiter), 1);
          const record = records[waiter.number - 1];
          assert(record);
          waiter.resolve({ record });
        }
      },
    });
    await started.setDistribution(build.relativePath);
    context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' });
    page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const location = message.location().url;
      if (
        caseSpec.id === 'status' &&
        message.text().includes('503') &&
        (!location || new URL(location).pathname === METADATA_PATH)
      )
        return;
      consoleErrors.push({ text: message.text(), location });
    });
    page.on('requestfailed', (request) => {
      const path = new URL(request.url()).pathname;
      const error = request.failure()?.errorText ?? 'unknown';
      if (path === METADATA_PATH && error === 'net::ERR_ABORTED') return;
      failedRequests.push({ path, error });
    });
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      if (path === METADATA_PATH && response.status() === caseSpec.status) return;
      if (response.status() >= 400) failedResponses.push({ path, status: response.status() });
    });
    await page.addInitScript(() => {
      localStorage.setItem('dropconvert.locale', 'en');
      globalThis.__cleanupFetchSignals = [];
      globalThis.__cleanupFetchOverflow = false;
      globalThis.__cleanupCspViolations = [];
      globalThis.document.addEventListener('securitypolicyviolation', (event) => {
        globalThis.__cleanupCspViolations.push(`${event.effectiveDirective}: ${event.blockedURI}`);
      });
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = function (...args) {
        const input = args[0];
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (url.pathname === '/deployment-state.json') {
          const signal = args[1]?.signal ?? (input instanceof Request ? input.signal : null);
          const entry: { startedAtMs: number; abortedAtMs: number | null } = {
            startedAtMs: performance.now(),
            abortedAtMs: null,
          };
          if (globalThis.__cleanupFetchSignals.length < 8)
            globalThis.__cleanupFetchSignals.push(entry);
          else globalThis.__cleanupFetchOverflow = true;
          signal?.addEventListener(
            'abort',
            () => {
              entry.abortedAtMs = performance.now();
            },
            { once: true }
          );
        }
        return Reflect.apply(nativeFetch, this, args);
      };
    });
    const firstWait = waitForResponseNumber(records, waiters, 1);
    const document = await page.goto(started.url, { waitUntil: 'domcontentloaded' });
    assert.equal(document?.status(), 200);
    assert.equal(
      sha256(await document.body()),
      build.indexSha256,
      'Cleanup scenario loaded the wrong application artifact'
    );
    const documentTimeOrigin = await page.evaluate(() => performance.timeOrigin);
    const first = await requireRecord(firstWait);
    assert.equal(
      await anyUpdateNotice(page).isVisible(),
      false,
      'Rejected metadata announced an update'
    );
    if (fixed) {
      assert(
        await waitForClosedResponse(first),
        `${caseSpec.id} first rejected metadata body stayed open beyond ${CLEANUP_RELEASE_MS} ms`
      );
      assert(first.closedAtMs !== null);
      assert(
        first.closedAtMs - first.startedAtMs <= CLEANUP_RELEASE_MS,
        `${caseSpec.id} first rejected metadata release exceeded ${CLEANUP_RELEASE_MS} ms`
      );
      assert.equal(first.finishedAtMs, null, 'Rejected metadata response finished normally');
    } else if (caseSpec.id === 'mime') {
      await page.waitForTimeout(
        Math.max(0, BASELINE_MIME_OBSERVATION_MS - (performance.now() - first.startedAtMs))
      );
      result.firstMIMEObservedAfterMs = performance.now() - first.startedAtMs;
      result.firstMIMEStillOpenAfterDeadline = first.closedAtMs === null;
    }
    await page.waitForTimeout(
      Math.max(0, CLEANUP_SECOND_ATTEMPT_MS - (performance.now() - first.startedAtMs))
    );
    assert.equal(records.length, 1, 'Metadata polling occurred without a lifecycle event');
    const secondWait = waitForResponseNumber(records, waiters, 2);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    const second = await requireRecord(secondWait);
    if (fixed) {
      assert(
        await waitForClosedResponse(second),
        `${caseSpec.id} second rejected metadata body stayed open beyond ${CLEANUP_RELEASE_MS} ms`
      );
      assert(second.closedAtMs !== null);
      assert(
        second.closedAtMs - second.startedAtMs <= CLEANUP_RELEASE_MS,
        `${caseSpec.id} second rejected metadata release exceeded ${CLEANUP_RELEASE_MS} ms`
      );
      assert.equal(second.finishedAtMs, null, 'Rejected metadata response finished normally');
    } else {
      await page.waitForTimeout(300);
    }
    assert.equal(records.length, 2, 'Lifecycle event did not produce exactly one second request');
    assert.equal(
      await anyUpdateNotice(page).isVisible(),
      false,
      'Rejected metadata produced an update notice'
    );
    result.signalEvents = await page.evaluate(() => globalThis.__cleanupFetchSignals);
    assert.equal(await page.evaluate(() => globalThis.__cleanupFetchOverflow), false);
    assert.equal(result.signalEvents.length, 2, 'Observed metadata Fetch count differs');
    if (fixed) {
      assert(
        result.signalEvents.every((entry) => entry.abortedAtMs !== null),
        'Fixed app did not abort both rejected metadata Fetch signals'
      );
      result.rejectedCleanup = {
        observedAtMs: performance.now(),
        responseBodies: records.map(responseSnapshot),
        unfinishedResponseWork: records.filter((record) => record.closedAtMs === null).length,
        signalEvents: result.signalEvents,
      };
      assert.equal(
        result.rejectedCleanup.unfinishedResponseWork,
        0,
        'Rejected metadata response work remained before the valid check'
      );
      await page.waitForTimeout(
        Math.max(0, CLEANUP_SECOND_ATTEMPT_MS - (performance.now() - second.startedAtMs))
      );
      assert.equal(records.length, 2, 'Metadata polling occurred before the valid check event');
      const thirdWait = waitForResponseNumber(records, waiters, 3);
      const validResponse = captureResponseWait(
        page,
        (response) =>
          new URL(response.url()).pathname === METADATA_PATH && response.status() === 200,
        20_000
      );
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      const third = await requireRecord(thirdWait);
      const response = await requireResponse(validResponse);
      const observedMetadata = await response.body();
      assert.equal(observedMetadata.length, validMetadata.length);
      assert.equal(
        sha256(observedMetadata),
        sha256(validMetadata),
        'Valid metadata response bytes differ from the original source artifact'
      );
      assert(await waitForClosedResponse(third), 'Valid metadata response did not finish');
      assert.notEqual(third.finishedAtMs, null, 'Valid metadata response did not finish normally');
      await updateNotice(page).waitFor({ state: 'visible', timeout: 10_000 });
      assert.equal(
        await page.evaluate(() => performance.timeOrigin),
        documentTimeOrigin,
        'Valid metadata notice automatically navigated the built app'
      );
      assert.equal(records.length, 3, 'Valid event did not produce exactly one third request');
      result.signalEvents = await page.evaluate(() => globalThis.__cleanupFetchSignals);
      assert.equal(await page.evaluate(() => globalThis.__cleanupFetchOverflow), false);
      assert.equal(result.signalEvents.length, 3, 'Valid metadata Fetch count differs');
      assert(
        result.signalEvents.slice(0, 2).every((entry) => entry.abortedAtMs !== null),
        'Rejected metadata Fetch signals lost their abort evidence'
      );
      const thirdSignal = result.signalEvents[2];
      assert(thirdSignal);
      assert.equal(thirdSignal.abortedAtMs, null, 'Successful valid metadata Fetch was aborted');
      result.validDetection = {
        sourceSha: sourceShaFromJson(JSON.parse(validMetadata.toString('utf8'))),
        response: responseSnapshot(third),
        notice: true,
        automaticNavigation: false,
        thirdSignalAborted: false,
      };
      assert.equal(
        records.filter((record) => record.closedAtMs === null).length,
        0,
        'Valid detection left response work unfinished'
      );
    }
    assert.deepEqual(await page.evaluate(() => globalThis.__cleanupCspViolations), []);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(failedRequests, []);
    assert.deepEqual(failedResponses, []);
    result.status = 'passed';
    return result;
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    result.error = String(error);
    throw error;
  } finally {
    // The evidence snapshot precedes all cleanup that could close an abandoned body.
    result.observedAtMs = performance.now();
    result.responseBodies = records.map(responseSnapshot);
    result.unfinishedBeforeTeardown = records.filter((record) => record.closedAtMs === null).length;
    if (page && !result.signalEvents.length) {
      try {
        result.signalEvents = await page.evaluate(() => globalThis.__cleanupFetchSignals ?? []);
      } catch (error) {
        result.signalCaptureError = String(error);
      }
    }
    if (context) {
      try {
        await context.close();
      } catch (error) {
        result.cleanupErrors.push(`context close: ${String(error)}`);
      }
    }
    for (const record of records) {
      if (!record.response.destroyed) record.response.destroy();
    }
    if (started) {
      try {
        await closeServer(started.server);
      } catch (error) {
        result.cleanupErrors.push(`server close: ${String(error)}`);
      }
    }
    for (const waiter of waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve({ error: 'Cleanup scenario ended before response arrived' });
    }
    if (primaryError && result.cleanupErrors.length)
      primaryError.cleanupErrors = [...(primaryError.cleanupErrors ?? []), ...result.cleanupErrors];
    if (!primaryError && result.cleanupErrors.length)
      // Cleanup failure is raised only when no primary failure exists.
      throw new Error(result.cleanupErrors.join('; '));
  }
}

async function observeMetadataCleanup({
  browser,
  bundleRoot,
  config,
  buildB,
  startStaticServer,
  closeServer,
  validateBundleFile,
  diagnostics,
}: {
  browser: Browser;
  bundleRoot: string;
  config: AppUpdateConfig;
  buildB: Build;
  startStaticServer: StartStaticServer;
  closeServer: (server: Server) => Promise<void>;
  validateBundleFile: ValidateBundleFile;
  diagnostics: { cleanupResponses?: CleanupCaseResult[] };
}) {
  const original = await readBuild(bundleRoot, config.cleanupBaseline, validateBundleFile, {
    verifyInventory: true,
  });
  assert.equal(
    original.state.sourceSha,
    config.cleanupBaselineSourceSha,
    'Cleanup baseline source differs from issue #295 original'
  );
  assert.equal(
    original.state.treeSha,
    config.cleanupBaselineTreeSha,
    'Cleanup baseline tree differs from issue #295 original'
  );
  assert.notEqual(
    original.state.sourceSha,
    buildB.state.sourceSha,
    'Cleanup comparison must use distinct original and fixed sources'
  );
  assert.equal(original.state.version, buildB.state.version);
  assert.equal(
    original.workerSha256,
    buildB.workerSha256,
    'Cleanup comparison changed service-worker bytes'
  );
  const validMetadata = await readFile(
    await validateBundleFile(bundleRoot, `${config.cleanupBaseline}/deployment-state.json`)
  );
  assert(
    validMetadata.length > 0 && validMetadata.length <= MAX_METADATA_BYTES,
    'Valid metadata response exceeds the application size limit'
  );
  assert.equal(
    sourceShaFromJson(JSON.parse(validMetadata.toString('utf8'))),
    original.state.sourceSha
  );
  const observations: CleanupCaseResult[] = [];
  diagnostics.cleanupResponses = observations;
  for (const [build, fixed] of [
    [original, false],
    [buildB, true],
  ] as const) {
    const cases = await Promise.allSettled(
      CLEANUP_CASES.map((caseSpec) =>
        observeCleanupCase({
          browser,
          bundleRoot,
          build,
          caseSpec,
          fixed,
          validMetadata,
          startStaticServer,
          closeServer,
          diagnostics: observations,
        })
      )
    );
    const failure = cases.find((outcome) => outcome.status === 'rejected');
    if (failure) throw failure.reason;
  }
  return {
    originalSourceSha: original.state.sourceSha,
    originalTreeSha: original.state.treeSha,
    fixedSourceSha: buildB.state.sourceSha,
    releaseLimitMs: CLEANUP_RELEASE_MS,
    secondAttemptAfterMs: CLEANUP_SECOND_ATTEMPT_MS,
    originalMIMEObservationAfterMs: BASELINE_MIME_OBSERVATION_MS,
    cases: observations,
  };
}

async function heldFirstMetadata(
  browser: Browser,
  started: StartedServer,
  buildA: Build,
  buildB: Build,
  outputRoot: string,
  artifacts: Artifact[]
) {
  await started.setDistribution(buildA.relativePath);
  let context: BrowserContext | undefined;
  let primaryError: CleanupError | undefined;
  const record = {
    origin: new URL(started.url).origin,
    pageErrors: [],
    consoleErrors: [],
    failedRequests: [],
    failedResponses: [],
    uploads: [],
    external: [],
    metadataRequests: [],
    metadataResponses: [],
    metadataOverflow: false,
    offlineMetadataFailures: [],
    offline: false,
  };
  const gate = { release: () => {} };
  const releaseGate = new Promise<void>((resolveRelease) => {
    gate.release = resolveRelease;
  });
  let markHeld: () => void = () => {};
  const held = new Promise<void>((resolveHeld) => {
    markHeld = resolveHeld;
  });
  let interceptions = 0;
  try {
    context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await instrument(page, record);
    await page.route(`**${METADATA_PATH}`, async (route) => {
      interceptions++;
      if (interceptions === 1) {
        markHeld();
        await releaseGate;
      }
      await route.continue();
    });
    const document = await page.goto(started.url);
    assert.equal(document?.status(), 200);
    assert.equal(
      sha256(await document.body()),
      buildA.indexSha256,
      'Held-first tab did not load A HTML'
    );
    await Promise.race([
      held,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('First metadata request was not intercepted')), 5_000)
      ),
    ]);
    assert.equal(interceptions, 1);
    assert.equal(
      await updateNotice(page).isVisible(),
      false,
      'A first install announced an update before receiving metadata'
    );
    const before = await page.evaluate(() => performance.timeOrigin);
    await started.setDistribution('dist');
    const metadata = captureResponseWait(
      page,
      (response) => new URL(response.url()).pathname === METADATA_PATH && response.status() === 200,
      10_000
    );
    gate.release();
    gate.release = () => {};
    assert.equal(
      sourceShaFromJson(await (await requireResponse(metadata)).json()),
      buildB.state.sourceSha,
      'Held first request did not receive B metadata'
    );
    await updateNotice(page).waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(
      await page.evaluate(() => performance.timeOrigin),
      before,
      'Held-first notice automatically reloaded the A document'
    );
    assert.equal(interceptions, 1, 'First request overlapped another metadata check');
    assert.equal(record.metadataRequests.length, 1);
    await assertRuntimeHealth(page, record);
    await screenshot(page, outputRoot, 'app-update-held-first-request.png', artifacts);
    return {
      sourceA: buildA.state.sourceSha,
      observedB: buildB.state.sourceSha,
      firstRequestCompletedAfterDeploymentB: true,
      noAutomaticReload: true,
      metadata: await metadataObservation(record),
    };
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    gate.release();
    if (context) {
      try {
        await context.close();
      } catch (error) {
        if (primaryError)
          primaryError.cleanupErrors = [
            ...(primaryError.cleanupErrors ?? []),
            `held-first context close: ${String(error)}`,
          ];
        // Cleanup failure is raised only when no primary failure exists.
        else throw error;
      }
    }
  }
}

/** Focused, source-bound application update acceptance without the codec corpus. */
export async function runAppUpdate({
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
  config: AppUpdateConfig;
  startStaticServer: StartStaticServer;
  closeServer: (server: Server) => Promise<void>;
  validateBundleFile: ValidateBundleFile;
}) {
  const artifacts: Artifact[] = [];
  const diagnostics: {
    phase: string;
    sourceA: string | null;
    sourceB: string | null;
    records: { result?: RuntimeRecord; busy?: RuntimeRecord };
    cleanupResponses?: CleanupCaseResult[];
  } = { phase: 'inputs', sourceA: null, sourceB: null, records: {} };
  let started: StartedServer | undefined;
  let resultContext: BrowserContext | undefined;
  let busyContext: BrowserContext | undefined;
  let resultPage: Page | undefined;
  let busyPage: Page | undefined;
  let primaryError: CleanupError | undefined;
  try {
    const [buildA, buildB, smallFixture, highMotionFixture] = await Promise.all([
      readBuild(bundleRoot, config.buildA, validateBundleFile),
      readBuild(bundleRoot, 'dist', validateBundleFile),
      validateBundleFile(bundleRoot, SMALL_FIXTURE),
      validateBundleFile(bundleRoot, HIGH_MOTION_FIXTURE),
    ]);
    diagnostics.sourceA = buildA.state.sourceSha;
    diagnostics.sourceB = buildB.state.sourceSha;
    assert.notEqual(
      buildA.state.sourceSha,
      buildB.state.sourceSha,
      'A and B must be distinct source builds'
    );
    assert.equal(buildA.state.version, buildB.state.version, 'A and B changed package version');
    assert.equal(
      buildA.workerSha256,
      buildB.workerSha256,
      'A and B service workers differ; this would exercise a worker update instead'
    );
    assert.notEqual(
      buildA.main.sha256,
      buildB.main.sha256,
      'A and B app entry bytes must encode distinct running source identities'
    );
    assert.notEqual(
      buildA.indexSha256,
      buildB.indexSha256,
      'A and B HTML must identify distinct application entries'
    );

    started = await startStaticServer(bundleRoot, { gzipAssets: true });
    diagnostics.phase = 'before-fix';
    const baseline = await baselineBeforeFix(
      browser,
      started,
      bundleRoot,
      config,
      validateBundleFile,
      outputRoot,
      artifacts
    );
    assert.equal(
      baseline.workerSha256,
      buildA.workerSha256,
      'Before-fix baseline must share the unchanged worker for causal comparison'
    );

    diagnostics.phase = 'held-first-metadata';
    const heldFirst = await heldFirstMetadata(
      browser,
      started,
      buildA,
      buildB,
      outputRoot,
      artifacts
    );

    diagnostics.phase = 'metadata-cleanup';
    const metadataCleanup = await observeMetadataCleanup({
      browser,
      bundleRoot,
      config,
      buildB,
      startStaticServer,
      closeServer,
      validateBundleFile,
      diagnostics,
    });

    diagnostics.phase = 'equal-identity';
    await started.setDistribution(config.buildA);
    const coldA = await measureColdTransfer(browser, started, buildA);
    resultContext = await browser.newContext({
      acceptDownloads: true,
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
    });
    resultPage = await resultContext.newPage();
    const resultRecord: RuntimeRecord = {
      origin: new URL(started.url).origin,
      pageErrors: [],
      consoleErrors: [],
      failedRequests: [],
      failedResponses: [],
      uploads: [],
      external: [],
      metadataRequests: [],
      metadataResponses: [],
      metadataOverflow: false,
      offlineMetadataFailures: [],
      transportGates: [],
      offline: false,
    };
    diagnostics.records.result = resultRecord;
    await instrument(resultPage, resultRecord);
    const firstMetadata = captureResponseWait(
      resultPage,
      (response) => new URL(response.url()).pathname === METADATA_PATH,
      20_000
    );
    const firstDocument = await resultPage.goto(started.url);
    assert.equal(firstDocument?.status(), 200);
    assert.equal(
      sha256(await firstDocument.body()),
      buildA.indexSha256,
      'Initial tab did not load A HTML'
    );
    await resultPage.locator('#file-upload').waitFor({ state: 'attached' });
    assert.equal(
      (await requireResponse(firstMetadata)).status(),
      200,
      'A initial metadata request failed'
    );
    await resultPage.waitForLoadState('networkidle');
    await resultPage.waitForFunction(
      () => navigator.serviceWorker.controller?.state === 'activated'
    );
    const initialWorker = await watchRegistration(resultPage);
    assert.equal(
      await updateNotice(resultPage).isVisible(),
      false,
      'First install or equal deployment identity produced a false notice'
    );
    await resultPage.evaluate(async () => {
      const cache = await caches.open('acceptance-unrelated-app-update');
      await cache.put('/unrelated', new Response('preserved'));
    });
    await screenshot(resultPage, outputRoot, 'app-update-equal-identity.png', artifacts);

    diagnostics.phase = 'retained-result';
    await startGif(resultPage, smallFixture);
    await resultPage
      .getByRole('heading', { name: 'Result', exact: true })
      .waitFor({ state: 'visible', timeout: 120_000 });
    const firstGif = await downloadGif(resultPage);
    await writeArtifact(
      outputRoot,
      'app-update-result-a.gif',
      firstGif.bytes,
      artifacts,
      'download'
    );
    const resultTimeOrigin = await resultPage.evaluate(() => performance.timeOrigin);

    diagnostics.phase = 'busy-a-initial';
    busyContext = await browser.newContext({
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
    });
    busyPage = await busyContext.newPage();
    const busyRecord: RuntimeRecord = {
      origin: new URL(started.url).origin,
      pageErrors: [],
      consoleErrors: [],
      failedRequests: [],
      failedResponses: [],
      uploads: [],
      external: [],
      metadataRequests: [],
      metadataResponses: [],
      metadataOverflow: false,
      offlineMetadataFailures: [],
      transportGates: [],
      offline: false,
    };
    diagnostics.records.busy = busyRecord;
    await instrument(busyPage, busyRecord);
    const busyInitialMetadata = captureResponseWait(
      busyPage,
      (response) => new URL(response.url()).pathname === METADATA_PATH,
      20_000
    );
    const busyDocument = await busyPage.goto(started.url);
    assert.equal(busyDocument?.status(), 200);
    assert.equal(
      sha256(await busyDocument.body()),
      buildA.indexSha256,
      'Busy tab did not load A HTML'
    );
    assert.equal(
      (await requireResponse(busyInitialMetadata)).status(),
      200,
      'Busy A initial metadata failed'
    );
    await busyPage.waitForLoadState('networkidle');
    await busyPage.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    const busyWorker = await watchRegistration(busyPage);
    assert.equal(
      await updateNotice(busyPage).isVisible(),
      false,
      'A notice appeared before B was served'
    );

    diagnostics.phase = 'quiet-cadence';
    assert.equal(resultRecord.metadataRequests.length, 1, 'Result A initial request count');
    assert.equal(busyRecord.metadataRequests.length, 1, 'Busy A initial request count');
    const resultInitialRequest = resultRecord.metadataRequests[0];
    const busyInitialRequest = busyRecord.metadataRequests[0];
    assert(resultInitialRequest && busyInitialRequest);
    const quietUntil = Math.max(resultInitialRequest.atMs, busyInitialRequest.atMs) + 61_000;
    await busyPage.waitForTimeout(Math.max(0, quietUntil - performance.now()));
    assert.equal(
      resultRecord.metadataRequests.length,
      1,
      'Result page made a metadata request without a lifecycle event'
    );
    assert.equal(
      busyRecord.metadataRequests.length,
      1,
      'Busy page made a metadata request without a lifecycle event'
    );

    diagnostics.phase = 'busy-b-notice';
    await startGif(busyPage, highMotionFixture, { highMotion: true });
    const stop = busyPage.getByRole('button', { name: 'Stop video conversion' });
    await stop.waitFor({ state: 'visible', timeout: 120_000 });
    await busyPage.waitForFunction(
      () =>
        [...document.querySelectorAll('[role="progressbar"]')].some(
          (element) => Number(element.getAttribute('aria-valuenow')) > 0
        ),
      undefined,
      { timeout: 120_000 }
    );
    const busyTimeOrigin = await busyPage.evaluate(() => performance.timeOrigin);
    const busyLifecycleStart = await busyPage.evaluate(
      () => globalThis.__appUpdateLifecycle.length
    );
    busyRecord.offline = true;
    await busyContext.setOffline(true);
    await waitForConnectivityEvent(busyPage, busyLifecycleStart, 'offline', false);
    assert(await stop.isVisible(), 'Conversion stopped before connectivity recovery');
    await started.setDistribution('dist');
    const bMetadata = captureResponseWait(
      busyPage,
      (response) => new URL(response.url()).pathname === METADATA_PATH && response.status() === 200,
      20_000
    );
    await restoreOnlineWithMetadataGate(busyPage, busyContext, busyRecord, busyLifecycleStart);
    assert.deepEqual(
      busyRecord.offlineMetadataFailures,
      [],
      'Busy tab fetched deployment metadata while offline'
    );
    assert(await stop.isVisible(), 'Conversion stopped during connectivity recovery');
    assert.equal(
      sourceShaFromJson(await (await requireResponse(bMetadata)).json()),
      buildB.state.sourceSha,
      'Busy online event did not observe B metadata'
    );
    await assertOnlineMetadataTransportStarted(busyPage, busyRecord);
    await updateNotice(busyPage).waitFor({ state: 'visible', timeout: 20_000 });
    const busyReload = updateNotice(busyPage).getByRole('button', { name: 'Reload page' });
    assert.equal(await busyReload.isEnabled(), false, 'Reload must be disabled during conversion');
    assert.equal(
      await busyPage.evaluate(() => performance.timeOrigin),
      busyTimeOrigin,
      'Update notice automatically navigated an active conversion'
    );
    await screenshot(busyPage, outputRoot, 'app-update-busy-notice.png', artifacts);
    const cancel = busyPage.getByTestId('dropzone-cancel-button');
    assert.equal(await cancel.getAttribute('aria-label'), 'Cancel conversion');
    assert(await cancel.isEnabled(), 'In-viewport conversion cancel control is disabled');
    assert(
      await busyPage.evaluate(() =>
        [...document.querySelectorAll('[role="progressbar"]')].some(
          (element) => Number(element.getAttribute('aria-valuenow')) > 0
        )
      ),
      'Conversion completed before cancellation could be exercised'
    );
    await cancel.click({ timeout: 5_000 });
    await busyPage
      .getByRole('button', { name: 'Convert', exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(
      await busyPage.getByTestId('result-section').count(),
      0,
      'A completed conversion was mistaken for cancellation'
    );
    assert(await busyReload.isEnabled(), 'Reload did not enable after cancellation completed');
    await busyPage.getByRole('button', { name: 'Change', exact: true }).click();
    await busyPage.locator('#file-upload').setInputFiles(smallFixture);
    await busyPage.getByRole('button', { name: 'Convert', exact: true }).click({ trial: true });
    assert.equal(
      await busyPage.evaluate(() => performance.timeOrigin),
      busyTimeOrigin,
      'Cancellation and reselection navigated the document'
    );

    diagnostics.phase = 'result-notice';
    const resultLifecycleStart = await resultPage.evaluate(
      () => globalThis.__appUpdateLifecycle.length
    );
    resultRecord.offline = true;
    await resultContext.setOffline(true);
    await waitForConnectivityEvent(resultPage, resultLifecycleStart, 'offline', false);
    await resultPage.bringToFront();
    await resultPage.waitForFunction(() => document.visibilityState === 'visible');
    const resultBMetadata = captureResponseWait(
      resultPage,
      (response) => new URL(response.url()).pathname === METADATA_PATH && response.status() === 200,
      20_000
    );
    await restoreOnlineWithMetadataGate(
      resultPage,
      resultContext,
      resultRecord,
      resultLifecycleStart
    );
    assert.deepEqual(
      resultRecord.offlineMetadataFailures,
      [],
      'Result tab fetched deployment metadata while offline'
    );
    assert.equal(
      sourceShaFromJson(await (await requireResponse(resultBMetadata)).json()),
      buildB.state.sourceSha,
      'Result online event did not observe B metadata'
    );
    await assertOnlineMetadataTransportStarted(resultPage, resultRecord);
    await updateNotice(resultPage).waitFor({ state: 'visible', timeout: 20_000 });
    const resultReload = updateNotice(resultPage).getByRole('button', { name: 'Reload page' });
    assert.equal(
      await resultReload.isEnabled(),
      false,
      'Reload must be disabled with an existing result'
    );
    assert.equal(
      await resultPage.evaluate(() => performance.timeOrigin),
      resultTimeOrigin,
      'Update notice automatically navigated the retained result'
    );
    const secondGif = await downloadGif(resultPage);
    assert.equal(
      sha256(secondGif.bytes),
      sha256(firstGif.bytes),
      'Retained GIF download changed after B deployment'
    );
    assert.equal(
      secondGif.href,
      firstGif.href,
      'Retained result Blob URL changed after B deployment'
    );
    assert.equal(
      await resultPage.evaluate(async () =>
        (await (await caches.open('acceptance-unrelated-app-update')).match('/unrelated'))?.text()
      ),
      'preserved',
      'Unrelated cache entry was removed'
    );
    await screenshot(resultPage, outputRoot, 'app-update-result-notice.png', artifacts);

    const resultEvents = await workerEvents(resultPage);
    const busyEvents = await workerEvents(busyPage);
    const resultLifecycle = await resultPage.evaluate(() => globalThis.__appUpdateLifecycle ?? []);
    const busyLifecycle = await busyPage.evaluate(() => globalThis.__appUpdateLifecycle ?? []);
    assert.deepEqual(resultEvents, [], 'Unchanged worker unexpectedly updated on the result tab');
    assert.deepEqual(busyEvents, [], 'Unchanged worker unexpectedly updated on the active tab');
    assert.equal(
      await resultPage.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null),
      initialWorker.controller,
      'Result tab changed its service-worker controller'
    );
    assert.equal(
      await busyPage.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null),
      busyWorker.controller,
      'Busy tab changed its service-worker controller'
    );
    assert.equal(
      resultRecord.metadataRequests.length,
      2,
      'Result tab did not make exactly one lifecycle-triggered B check'
    );
    assert.equal(
      busyRecord.metadataRequests.length,
      2,
      'Busy tab did not make exactly one lifecycle-triggered B check'
    );
    const resultSecondRequest = resultRecord.metadataRequests[1];
    const busySecondRequest = busyRecord.metadataRequests[1];
    assert(resultSecondRequest && busySecondRequest);
    const equalCadenceMs = resultSecondRequest.atMs - resultInitialRequest.atMs;
    const busyCadenceMs = busySecondRequest.atMs - busyInitialRequest.atMs;
    assert(equalCadenceMs >= 60_000, 'Result metadata checks violated 60s minimum cadence');
    assert(busyCadenceMs >= 60_000, 'Busy metadata checks violated 60s minimum cadence');
    await assertRuntimeHealth(resultPage, resultRecord);
    await assertRuntimeHealth(busyPage, busyRecord);

    diagnostics.phase = 'explicit-reload';
    const clearResult = updateNotice(resultPage).getByRole('button', {
      name: 'Clear result',
      exact: true,
    });
    assert(await clearResult.isEnabled(), 'Result clear action is disabled');
    await clearResult.click();
    await resultPage.getByTestId('result-section').waitFor({ state: 'detached' });
    await resultReload.waitFor({ state: 'visible' });
    assert(await resultReload.isEnabled(), 'Reload did not enable after result was cleared');
    assert.equal(
      await resultPage.evaluate(() => performance.timeOrigin),
      resultTimeOrigin,
      'Clearing the retained result navigated the document'
    );
    const reloadedScripts: PlaywrightResponse[] = [];
    resultPage.on('response', (response) => {
      if (new URL(response.url()).pathname === `/${buildB.main.path}`)
        reloadedScripts.push(response);
    });
    const [reloadedDocument] = await Promise.all([
      resultPage.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      resultReload.click(),
    ]);
    assert.equal(reloadedDocument?.status(), 200);
    assert.equal(
      sha256(await reloadedDocument.body()),
      buildB.indexSha256,
      'Explicit reload did not load B HTML'
    );
    await resultPage.waitForLoadState('networkidle');
    assert(reloadedScripts.length > 0, 'Explicit reload did not request B app entry');
    const reloadedScript = reloadedScripts[0];
    assert(reloadedScript);
    const servedMainSha = sha256(await reloadedScript.body());
    assert.equal(
      servedMainSha,
      buildB.main.sha256,
      'Explicit reload app entry differs from B inventory'
    );
    assert.equal(
      await updateNotice(resultPage).isVisible(),
      false,
      'B falsely announced an update against its own metadata'
    );
    await screenshot(resultPage, outputRoot, 'app-update-reloaded-b.png', artifacts);
    const coldB = await measureColdTransfer(browser, started, buildB);

    const resultMetadata = await metadataObservation(resultRecord);
    const busyMetadata = await metadataObservation(busyRecord);
    assert(
      resultMetadata.some((entry) => entry.sourceSha === buildA.state.sourceSha),
      'A page did not observe equal initial metadata'
    );
    assert(
      resultMetadata.some((entry) => entry.sourceSha === buildB.state.sourceSha),
      'Retained result page did not observe B metadata'
    );
    assert.equal(
      busyMetadata[0]?.sourceSha,
      buildA.state.sourceSha,
      'Busy first metadata did not observe A'
    );
    assert.equal(
      busyMetadata[1]?.sourceSha,
      buildB.state.sourceSha,
      'Busy lifecycle check did not observe B'
    );
    assert.equal(resultRecord.metadataOverflow, false);
    assert.equal(busyRecord.metadataOverflow, false);
    await assertRuntimeHealth(resultPage, resultRecord);
    await assertRuntimeHealth(busyPage, busyRecord);
    diagnostics.phase = 'passed';
    return {
      profile: 'wmc-media',
      status: 'passed',
      checks: [
        {
          id: 'application-update',
          status: 'passed',
          sourceA: buildA.state.sourceSha,
          sourceB: buildB.state.sourceSha,
          version: buildA.state.version,
          workerSha256: buildA.workerSha256,
          baseline,
          firstInstallNotice: false,
          equalIdentityNotice: false,
          metadataCleanup,
          cold: { buildA: coldA, buildB: coldB },
          quietWindowMs: 61_000,
          equalCadenceMs,
          busyCadenceMs,
          heldFirst,
          busyTrigger: 'observed-offline-online',
          busyNotice: true,
          busyReloadDisabled: true,
          busyDocumentRetained: true,
          cancellationReselection: true,
          resultDownload: {
            filename: firstGif.filename,
            bytes: firstGif.bytes.length,
            sha256: sha256(firstGif.bytes),
          },
          resultRetained: true,
          resultTrigger: 'observed-offline-online',
          resultReloadDisabled: true,
          explicitReloadB: {
            htmlSha256: buildB.indexSha256,
            mainJsSha256: servedMainSha,
            metadataSourceSha: buildB.state.sourceSha,
          },
          initialWorker,
          busyWorker,
          resultWorkerEvents: resultEvents,
          busyWorkerEvents: busyEvents,
          metadata: {
            result: { requests: resultRecord.metadataRequests, responses: resultMetadata },
            busy: { requests: busyRecord.metadataRequests, responses: busyMetadata },
          },
          metadataTotals: {
            resultCount: resultRecord.metadataRequests.length,
            resultResponseBytes: resultMetadata.reduce((sum, entry) => sum + entry.bytes, 0),
            busyCount: busyRecord.metadataRequests.length,
            busyResponseBytes: busyMetadata.reduce((sum, entry) => sum + entry.bytes, 0),
          },
          lifecycle: { result: resultLifecycle, busy: busyLifecycle },
          transportGates: { result: resultRecord.transportGates, busy: busyRecord.transportGates },
          expectedOfflineMetadataFailures: resultRecord.offlineMetadataFailures,
        },
      ],
      artifacts,
    };
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    for (const [name, page] of [
      ['result', resultPage],
      ['busy', busyPage],
    ] as const) {
      const record = diagnostics.records[name];
      if (!page || !record) continue;
      try {
        record.failurePageState = await page.evaluate(() => ({
          lifecycle: globalThis.__appUpdateLifecycle ?? [],
          visibility: document.visibilityState,
          online: navigator.onLine,
          timeOrigin: performance.timeOrigin,
        }));
      } catch (captureError) {
        record.failurePageStateError = String(captureError);
      }
    }
    throw error;
  } finally {
    const cleanupErrors: string[] = [];
    const cleanup = async (name: string, action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(`${name}: ${String(error)}`);
      }
    };
    const finalResultPage = resultPage;
    const finalBusyPage = busyPage;
    const finalResultContext = resultContext;
    const finalBusyContext = busyContext;
    const finalStarted = started;
    if (finalResultPage)
      await cleanup('result metadata gate release', () =>
        releaseOnlineMetadataTransportGate(finalResultPage)
      );
    if (finalBusyPage)
      await cleanup('busy metadata gate release', () =>
        releaseOnlineMetadataTransportGate(finalBusyPage)
      );
    if (finalResultContext)
      await cleanup('result offline reset', () => finalResultContext.setOffline(false));
    if (finalResultContext) await cleanup('result context close', () => finalResultContext.close());
    if (finalBusyContext) await cleanup('busy context close', () => finalBusyContext.close());
    if (finalStarted) await cleanup('server close', () => closeServer(finalStarted.server));
    const safeRecords: Record<string, object> = {};
    for (const [name, record] of Object.entries(diagnostics.records)) {
      safeRecords[name] = {
        pageErrors: record.pageErrors,
        consoleErrors: record.consoleErrors,
        failedRequests: record.failedRequests,
        failedResponses: record.failedResponses,
        uploads: record.uploads,
        external: record.external,
        offlineMetadataFailures: record.offlineMetadataFailures,
        transportGates: record.transportGates ?? [],
        failurePageState: record.failurePageState ?? null,
        failurePageStateError: record.failurePageStateError ?? null,
        metadataRequests: record.metadataRequests,
        metadataOverflow: record.metadataOverflow,
        metadataResponses: await Promise.all(
          record.metadataResponses.map(async ({ status, path, body, atMs }) => {
            const captured = await body;
            return {
              atMs,
              status,
              path,
              bodyBytes: captured.bytes?.length ?? null,
              bodyError: captured.error ?? null,
            };
          })
        ),
      };
    }
    await cleanup('diagnostics write', () =>
      writeFile(
        join(outputRoot, 'app-update-diagnostics.json'),
        JSON.stringify(
          {
            ...diagnostics,
            primaryError: primaryError && String(primaryError),
            helperCleanupErrors: primaryError?.cleanupErrors ?? [],
            cleanupErrors,
            records: safeRecords,
          },
          null,
          2
        )
      )
    );
    // Cleanup failure is raised only when no primary failure exists.
    if (!primaryError && cleanupErrors.length) throw new Error(cleanupErrors.join('; '));
  }
}
