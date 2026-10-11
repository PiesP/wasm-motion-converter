// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const SMALL_FIXTURE = 'public/test-video-ci-h264.mp4';
const HIGH_MOTION_FIXTURE = 'public/test-video-ci-high-motion-120fps.mp4';
const METADATA_PATH = '/deployment-state.json';
const NOTICE_TEXT = 'The app has changed. Reload when you are ready.';
const MAX_METADATA_BYTES = 64 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readBuild(bundleRoot, relativePath, validateBundleFile) {
  const path = await validateBundleFile(bundleRoot, `${relativePath}/deployment-state.json`);
  const bytes = await readFile(path);
  assert(bytes.length > 0 && bytes.length <= MAX_METADATA_BYTES, `${relativePath} metadata size`);
  const state = JSON.parse(bytes.toString('utf8'));
  assert.equal(state.schemaVersion, 1);
  assert.match(state.sourceSha, SHA);
  assert.match(state.treeSha, SHA);
  assert.match(state.coreSha, SHA);
  assert.match(state.headersSha256, DIGEST);
  assert.equal(state.sourceDirty, false, `${relativePath} must be built from clean source`);
  assert.match(state.version, /^\d+\.\d+\.\d+/);
  assert(Array.isArray(state.files) && state.files.length > 0 && state.files.length <= 100);
  const main = state.files.find((file) => /^assets\/index\.[\w-]{8}\.js$/.test(file.path));
  assert(main && DIGEST.test(main.sha256), `${relativePath} has no source-bound app entry`);
  const mainBytes = await readFile(await validateBundleFile(bundleRoot, `${relativePath}/${main.path}`));
  assert.equal(sha256(mainBytes), main.sha256, `${relativePath} app entry differs from inventory`);
  assert(mainBytes.includes(state.sourceSha), `${relativePath} app entry has no compiled source identity`);
  const index = await readFile(await validateBundleFile(bundleRoot, `${relativePath}/index.html`));
  const worker = await readFile(await validateBundleFile(bundleRoot, `${relativePath}/service-worker.js`));
  assert(index.toString('utf8').includes(`/${main.path}`), `${relativePath} HTML does not load its app entry`);
  return { relativePath, state, main, indexSha256: sha256(index), workerSha256: sha256(worker) };
}

function updateNotice(page) {
  return page.getByRole('status').filter({ hasText: NOTICE_TEXT });
}

function anyUpdateNotice(page) {
  return page.getByRole('status').filter({
    has: page.getByRole('button', { name: 'Reload page' }),
  });
}

async function startGif(page, fixture, { highMotion = false } = {}) {
  await page.locator('#file-upload').setInputFiles(fixture);
  await page.getByRole('radiogroup', { name: 'Output Format' })
    .getByRole('radio', { name: /^GIF/ }).check();
  await page.getByRole('radiogroup', { name: 'Quality Preset' })
    .getByRole('radio', { name: highMotion ? /^High/ : /^Low/ }).check();
  await page.getByRole('radiogroup', { name: 'Output Scale' })
    .getByRole('radio', { name: highMotion ? /^100%/ : /^50%/ }).check();
  const convert = page.getByRole('button', { name: 'Convert', exact: true });
  await convert.waitFor({ state: 'visible' });
  await convert.click();
  const proceed = page.getByRole('button', { name: 'Proceed with conversion despite warnings' });
  if (await proceed.isVisible({ timeout: 1_500 }).catch(() => false)) await proceed.click();
}

async function downloadGif(page) {
  const link = page.getByRole('link', { name: /^Download GIF file —/ });
  await link.waitFor({ state: 'visible', timeout: 120_000 });
  const href = await link.getAttribute('href');
  assert(href?.startsWith('blob:'), 'GIF result has no Blob download');
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  const bytes = await readFile(await download.path());
  assert.match(bytes.subarray(0, 6).toString('ascii'), /^GIF8[79]a$/);
  return { bytes, href, filename: download.suggestedFilename() };
}

async function instrument(page, record) {
  page.on('pageerror', (error) => record.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') record.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    const error = request.failure()?.errorText ?? 'unknown';
    if (url.protocol === 'blob:' && error === 'net::ERR_ABORTED') return;
    const entry = { path: url.pathname, error, atMs: performance.now() };
    if (record.offline && url.pathname === METADATA_PATH) record.offlineMetadataFailures.push(entry);
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
      record.metadataResponses.push({ status: response.status(), path: url.pathname,
        body: response.body().then((bytes) => ({ bytes }), (error) => ({ error: String(error) })),
        atMs: performance.now() });
    } else if (response.status() >= 400) {
      record.failedResponses.push({ path: url.pathname, status: response.status() });
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem('dropconvert.locale', 'en');
    globalThis.__appUpdateCspViolations = [];
    globalThis.__appUpdateLifecycle = [];
    window.addEventListener('pageshow', () => globalThis.__appUpdateLifecycle.push('pageshow'));
    window.addEventListener('online', () => globalThis.__appUpdateLifecycle.push('online'));
    document.addEventListener('visibilitychange', () => {
      globalThis.__appUpdateLifecycle.push(`visibility:${document.visibilityState}`);
    });
    document.addEventListener('securitypolicyviolation', (event) => {
      globalThis.__appUpdateCspViolations.push(
        `${event.effectiveDirective}: ${event.blockedURI}`);
    });
  });
}

async function assertRuntimeHealth(page, record) {
  assert.deepEqual(record.pageErrors, []);
  assert.deepEqual(record.consoleErrors, []);
  assert.deepEqual(record.failedRequests, []);
  assert.deepEqual(record.failedResponses, []);
  assert.deepEqual(record.uploads, []);
  assert.deepEqual(record.external, []);
  assert.equal(record.metadataOverflow, false);
  assert.deepEqual(await page.evaluate(() => globalThis.__appUpdateCspViolations ?? []), []);
}

async function metadataObservation(record) {
  return Promise.all(record.metadataResponses.map(async ({ status, path, body, atMs }) => {
    const captured = await body;
    assert(!captured.error, `Metadata response body capture failed for ${path}: ${captured.error}`);
    const { bytes } = captured;
    assert(bytes.length <= MAX_METADATA_BYTES, 'Observed metadata exceeds 64KiB');
    let sourceSha = null;
    if (status === 200) sourceSha = JSON.parse(bytes.toString('utf8')).sourceSha;
    return { atMs, status, bytes: bytes.length, sourceSha };
  }));
}

async function writeArtifact(outputRoot, name, bytes, artifacts, kind) {
  await writeFile(join(outputRoot, name), bytes);
  artifacts.push({ kind, file: name, bytes: bytes.length, sha256: sha256(bytes) });
}

async function screenshot(page, outputRoot, name, artifacts) {
  await writeArtifact(outputRoot, name, await page.screenshot(), artifacts, 'screenshot');
}

async function watchRegistration(page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    globalThis.__appUpdateWorkerEvents = [];
    registration.addEventListener('updatefound', () => {
      globalThis.__appUpdateWorkerEvents.push('updatefound');
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      globalThis.__appUpdateWorkerEvents.push('controllerchange');
    });
    return { controller: navigator.serviceWorker.controller?.scriptURL ?? null,
      active: registration.active?.scriptURL ?? null };
  });
}

async function workerEvents(page) {
  return page.evaluate(() => globalThis.__appUpdateWorkerEvents ?? []);
}

async function measureColdTransfer(browser, started, build) {
  const context = await browser.newContext({ serviceWorkers: 'block', locale: 'en-US' });
  try {
    const page = await context.newPage();
    const metadataResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === METADATA_PATH, { timeout: 20_000 });
    const document = await page.goto(started.url);
    assert.equal(document?.status(), 200);
    assert.equal(sha256(await document.body()), build.indexSha256,
      'Cold tab did not load expected HTML');
    const metadata = await metadataResponse;
    assert.equal(metadata.status(), 200, 'Cold metadata request failed');
    const metadataBytes = await metadata.body();
    assert.equal(JSON.parse(metadataBytes.toString('utf8')).sourceSha, build.state.sourceSha,
      'Cold metadata differs from served build');
    await page.waitForLoadState('networkidle');
    const resources = await page.evaluate(() => performance.getEntriesByType('resource')
      .filter((entry) => entry instanceof PerformanceResourceTiming)
      .map((entry) => ({ path: new URL(entry.name).pathname,
        transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize })));
    const js = resources.filter((entry) => entry.path.endsWith('.js'));
    const positive = js.filter((entry) => entry.transferSize > 0);
    const positiveBytes = positive.reduce((sum, entry) => sum + entry.transferSize, 0);
    assert(positive.length > 0 && positiveBytes > 0 && positiveBytes < 150_000,
      `Cold initial JS transfer ${positiveBytes} must be positive and below 150000 bytes`);
    const metadataTimings = resources.filter((entry) => entry.path === METADATA_PATH);
    assert.equal(metadataTimings.length, 1, 'Cold context must request metadata exactly once');
    assert(metadataTimings[0].transferSize > 0 && metadataTimings[0].encodedBodySize > 0,
      'Cold metadata has no positive network transfer');
    assert.equal(metadataTimings[0].decodedBodySize, metadataBytes.length,
      'Cold metadata decoded transfer differs from response body');
    return { sourceSha: build.state.sourceSha, js, positiveBytes,
      metadata: { count: metadataTimings.length, ...metadataTimings[0],
        responseBytes: metadataBytes.length } };
  } finally {
    await context.close();
  }
}

async function baselineBeforeFix(browser, started, bundleRoot, config, validateBundleFile,
  outputRoot, artifacts) {
  const baselineIndex = await readFile(await validateBundleFile(bundleRoot, `${config.baseline}/index.html`));
  const baselineWorker = await readFile(await validateBundleFile(bundleRoot, `${config.baseline}/service-worker.js`));
  const baselineMetadata = JSON.parse(await readFile(await validateBundleFile(bundleRoot,
    `${config.baseline}/deployment-state.json`), 'utf8'));
  assert.match(baselineMetadata.sourceSha, SHA);
  assert.match(baselineMetadata.treeSha, SHA);
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  const record = { origin: new URL(started.url).origin,
    pageErrors: [], consoleErrors: [], failedRequests: [], failedResponses: [], uploads: [], external: [],
    metadataRequests: [], metadataResponses: [], metadataOverflow: false,
    offlineMetadataFailures: [], offline: false };
  await instrument(page, record);
  try {
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
    assert.equal(await anyUpdateNotice(page).isVisible(), false,
      'Before-fix app unexpectedly announced an unchanged-worker deployment');
    assert.equal(await page.evaluate(() => performance.timeOrigin), beforeTimeOrigin,
      'Before-fix tab navigated without an explicit reload');
    assert.equal(record.metadataResponses.length, 0,
      'Before-fix app unexpectedly requested deployment metadata');
    assert.equal(record.metadataRequests.length, 0,
      'Before-fix app unexpectedly started deployment metadata checks');
    const workerUpdates = await workerEvents(page);
    assert.deepEqual(workerUpdates, [], 'Before-fix unchanged worker unexpectedly updated');
    assert.equal(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null),
      initialWorker.controller, 'Before-fix worker controller changed');
    await assertRuntimeHealth(page, record);
    await screenshot(page, outputRoot, 'app-update-before-fix.png', artifacts);
    return { source: 'prior-dist', sourceSha: baselineMetadata.sourceSha,
      treeSha: baselineMetadata.treeSha, indexSha256: sha256(baselineIndex),
      workerSha256: sha256(baselineWorker), initialWorker, workerUpdates,
      notice: false, metadataRequests: 0, documentRetained: true };
  } finally {
    await context.setOffline(false);
    await context.close();
  }
}

async function heldFirstMetadata(browser, started, buildA, buildB, outputRoot, artifacts) {
  await started.setDistribution(buildA.relativePath);
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const record = { origin: new URL(started.url).origin,
    pageErrors: [], consoleErrors: [], failedRequests: [], failedResponses: [], uploads: [], external: [],
    metadataRequests: [], metadataResponses: [], metadataOverflow: false,
    offlineMetadataFailures: [], offline: false };
  await instrument(page, record);
  let release;
  const releaseGate = new Promise((resolveRelease) => { release = resolveRelease; });
  let markHeld;
  const held = new Promise((resolveHeld) => { markHeld = resolveHeld; });
  let interceptions = 0;
  try {
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
    assert.equal(sha256(await document.body()), buildA.indexSha256,
      'Held-first tab did not load A HTML');
    await Promise.race([held, new Promise((_, reject) =>
      setTimeout(() => reject(new Error('First metadata request was not intercepted')), 5_000))]);
    assert.equal(interceptions, 1);
    assert.equal(await updateNotice(page).isVisible(), false,
      'A first install announced an update before receiving metadata');
    const before = await page.evaluate(() => performance.timeOrigin);
    await started.setDistribution('dist');
    const metadata = page.waitForResponse((response) =>
      new URL(response.url()).pathname === METADATA_PATH && response.status() === 200,
    { timeout: 10_000 });
    release();
    release = undefined;
    assert.equal((await (await metadata).json()).sourceSha, buildB.state.sourceSha,
      'Held first request did not receive B metadata');
    await updateNotice(page).waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await page.evaluate(() => performance.timeOrigin), before,
      'Held-first notice automatically reloaded the A document');
    assert.equal(interceptions, 1, 'First request overlapped another metadata check');
    assert.equal(record.metadataRequests.length, 1);
    await assertRuntimeHealth(page, record);
    await screenshot(page, outputRoot, 'app-update-held-first-request.png', artifacts);
    return { sourceA: buildA.state.sourceSha, observedB: buildB.state.sourceSha,
      firstRequestCompletedAfterDeploymentB: true, noAutomaticReload: true,
      metadata: await metadataObservation(record) };
  } finally {
    release?.();
    await context.close();
  }
}

/** Focused, source-bound application update acceptance without the codec corpus. */
export async function runAppUpdate({ browser, bundleRoot, outputRoot, config,
  startStaticServer, closeServer, validateBundleFile }) {
  const artifacts = [];
  const diagnostics = { phase: 'inputs', sourceA: null, sourceB: null, records: {} };
  let started;
  let resultContext;
  let busyContext;
  let primaryError;
  try {
    const [buildA, buildB, smallFixture, highMotionFixture] = await Promise.all([
      readBuild(bundleRoot, config.buildA, validateBundleFile),
      readBuild(bundleRoot, 'dist', validateBundleFile),
      validateBundleFile(bundleRoot, SMALL_FIXTURE),
      validateBundleFile(bundleRoot, HIGH_MOTION_FIXTURE),
    ]);
    diagnostics.sourceA = buildA.state.sourceSha;
    diagnostics.sourceB = buildB.state.sourceSha;
    assert.notEqual(buildA.state.sourceSha, buildB.state.sourceSha, 'A and B must be distinct source builds');
    assert.equal(buildA.state.version, buildB.state.version, 'A and B changed package version');
    assert.equal(buildA.workerSha256, buildB.workerSha256,
      'A and B service workers differ; this would exercise a worker update instead');
    assert.notEqual(buildA.main.sha256, buildB.main.sha256,
      'A and B app entry bytes must encode distinct running source identities');
    assert.notEqual(buildA.indexSha256, buildB.indexSha256,
      'A and B HTML must identify distinct application entries');

    started = await startStaticServer(bundleRoot, { gzipAssets: true });
    diagnostics.phase = 'before-fix';
    const baseline = await baselineBeforeFix(browser, started, bundleRoot, config,
      validateBundleFile, outputRoot, artifacts);
    assert.equal(baseline.workerSha256, buildA.workerSha256,
      'Before-fix baseline must share the unchanged worker for causal comparison');

    diagnostics.phase = 'held-first-metadata';
    const heldFirst = await heldFirstMetadata(browser, started, buildA, buildB,
      outputRoot, artifacts);

    diagnostics.phase = 'equal-identity';
    await started.setDistribution(config.buildA);
    const coldA = await measureColdTransfer(browser, started, buildA);
    resultContext = await browser.newContext({ acceptDownloads: true, locale: 'en-US',
      viewport: { width: 1280, height: 800 } });
    const resultPage = await resultContext.newPage();
    const resultRecord = { origin: new URL(started.url).origin,
      pageErrors: [], consoleErrors: [], failedRequests: [], failedResponses: [], uploads: [], external: [],
      metadataRequests: [], metadataResponses: [], metadataOverflow: false,
      offlineMetadataFailures: [], offline: false };
    diagnostics.records.result = resultRecord;
    await instrument(resultPage, resultRecord);
    const firstMetadata = resultPage.waitForResponse((response) =>
      new URL(response.url()).pathname === METADATA_PATH, { timeout: 20_000 });
    const firstDocument = await resultPage.goto(started.url);
    assert.equal(firstDocument?.status(), 200);
    assert.equal(sha256(await firstDocument.body()), buildA.indexSha256, 'Initial tab did not load A HTML');
    await resultPage.locator('#file-upload').waitFor({ state: 'attached' });
    assert.equal((await firstMetadata).status(), 200, 'A initial metadata request failed');
    await resultPage.waitForLoadState('networkidle');
    await resultPage.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    const initialWorker = await watchRegistration(resultPage);
    assert.equal(await updateNotice(resultPage).isVisible(), false,
      'First install or equal deployment identity produced a false notice');
    await resultPage.evaluate(async () => {
      const cache = await caches.open('acceptance-unrelated-app-update');
      await cache.put('/unrelated', new Response('preserved'));
    });
    await screenshot(resultPage, outputRoot, 'app-update-equal-identity.png', artifacts);

    diagnostics.phase = 'retained-result';
    await startGif(resultPage, smallFixture);
    await resultPage.getByRole('heading', { name: 'Result', exact: true })
      .waitFor({ state: 'visible', timeout: 120_000 });
    const firstGif = await downloadGif(resultPage);
    await writeArtifact(outputRoot, 'app-update-result-a.gif', firstGif.bytes, artifacts, 'download');
    const resultTimeOrigin = await resultPage.evaluate(() => performance.timeOrigin);

    diagnostics.phase = 'busy-a-initial';
    busyContext = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } });
    const busyPage = await busyContext.newPage();
    const busyRecord = { origin: new URL(started.url).origin,
      pageErrors: [], consoleErrors: [], failedRequests: [], failedResponses: [], uploads: [], external: [],
      metadataRequests: [], metadataResponses: [], metadataOverflow: false,
      offlineMetadataFailures: [], offline: false };
    diagnostics.records.busy = busyRecord;
    await instrument(busyPage, busyRecord);
    const busyInitialMetadata = busyPage.waitForResponse((response) =>
      new URL(response.url()).pathname === METADATA_PATH, { timeout: 20_000 });
    const busyDocument = await busyPage.goto(started.url);
    assert.equal(busyDocument?.status(), 200);
    assert.equal(sha256(await busyDocument.body()), buildA.indexSha256,
      'Busy tab did not load A HTML');
    assert.equal((await busyInitialMetadata).status(), 200, 'Busy A initial metadata failed');
    await busyPage.waitForLoadState('networkidle');
    await busyPage.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    const busyWorker = await watchRegistration(busyPage);
    assert.equal(await updateNotice(busyPage).isVisible(), false,
      'A notice appeared before B was served');

    diagnostics.phase = 'quiet-cadence';
    assert.equal(resultRecord.metadataRequests.length, 1, 'Result A initial request count');
    assert.equal(busyRecord.metadataRequests.length, 1, 'Busy A initial request count');
    const quietUntil = Math.max(resultRecord.metadataRequests[0].atMs,
      busyRecord.metadataRequests[0].atMs) + 61_000;
    await busyPage.waitForTimeout(Math.max(0, quietUntil - performance.now()));
    assert.equal(resultRecord.metadataRequests.length, 1,
      'Result page made a metadata request without a lifecycle event');
    assert.equal(busyRecord.metadataRequests.length, 1,
      'Busy page made a metadata request without a lifecycle event');

    diagnostics.phase = 'busy-b-notice';
    await startGif(busyPage, highMotionFixture, { highMotion: true });
    const stop = busyPage.getByRole('button', { name: 'Stop video conversion' });
    await stop.waitFor({ state: 'visible', timeout: 120_000 });
    await busyPage.waitForFunction(() => [...document.querySelectorAll('[role="progressbar"]')]
      .some((element) => Number(element.getAttribute('aria-valuenow')) > 0),
    undefined, { timeout: 120_000 });
    const busyTimeOrigin = await busyPage.evaluate(() => performance.timeOrigin);
    await started.setDistribution('dist');
    const bMetadata = busyPage.waitForResponse((response) =>
      new URL(response.url()).pathname === METADATA_PATH && response.status() === 200,
    { timeout: 20_000 });
    const coverPage = await busyContext.newPage();
    try {
      await coverPage.goto('about:blank');
      await coverPage.bringToFront();
      await busyPage.bringToFront();
    } finally {
      await coverPage.close();
    }
    assert((await busyPage.evaluate(() => globalThis.__appUpdateLifecycle))
      .includes('visibility:visible'), 'Busy tab did not exercise a visible-page event');
    assert.equal((await (await bMetadata).json()).sourceSha, buildB.state.sourceSha,
      'Busy visible event did not observe B metadata');
    await updateNotice(busyPage).waitFor({ state: 'visible', timeout: 20_000 });
    const busyReload = updateNotice(busyPage).getByRole('button', { name: 'Reload page' });
    assert.equal(await busyReload.isEnabled(), false, 'Reload must be disabled during conversion');
    assert.equal(await busyPage.evaluate(() => performance.timeOrigin), busyTimeOrigin,
      'Update notice automatically navigated an active conversion');
    await screenshot(busyPage, outputRoot, 'app-update-busy-notice.png', artifacts);
    await stop.click();
    await busyPage.getByRole('button', { name: 'Convert', exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 });
    await busyPage.getByRole('button', { name: 'Change', exact: true }).click();
    await busyPage.locator('#file-upload').setInputFiles(smallFixture);
    await busyPage.getByRole('button', { name: 'Convert', exact: true }).click({ trial: true });
    assert.equal(await busyPage.evaluate(() => performance.timeOrigin), busyTimeOrigin,
      'Cancellation and reselection navigated the document');

    diagnostics.phase = 'result-notice';
    const resultBMetadata = resultPage.waitForResponse((response) =>
      new URL(response.url()).pathname === METADATA_PATH && response.status() === 200,
    { timeout: 20_000 });
    resultRecord.offline = true;
    await resultContext.setOffline(true);
    await resultContext.setOffline(false);
    resultRecord.offline = false;
    await resultPage.bringToFront();
    assert.equal((await (await resultBMetadata).json()).sourceSha, buildB.state.sourceSha,
      'Result online event did not observe B metadata');
    await updateNotice(resultPage).waitFor({ state: 'visible', timeout: 20_000 });
    const resultReload = updateNotice(resultPage).getByRole('button', { name: 'Reload page' });
    assert.equal(await resultReload.isEnabled(), false, 'Reload must be disabled with an existing result');
    assert.equal(await resultPage.evaluate(() => performance.timeOrigin), resultTimeOrigin,
      'Update notice automatically navigated the retained result');
    const secondGif = await downloadGif(resultPage);
    assert.equal(sha256(secondGif.bytes), sha256(firstGif.bytes),
      'Retained GIF download changed after B deployment');
    assert.equal(secondGif.href, firstGif.href, 'Retained result Blob URL changed after B deployment');
    assert.equal(await resultPage.evaluate(async () =>
      (await (await caches.open('acceptance-unrelated-app-update')).match('/unrelated'))?.text()),
    'preserved', 'Unrelated cache entry was removed');
    await screenshot(resultPage, outputRoot, 'app-update-result-notice.png', artifacts);

    const resultEvents = await workerEvents(resultPage);
    const busyEvents = await workerEvents(busyPage);
    const resultLifecycle = await resultPage.evaluate(() => globalThis.__appUpdateLifecycle ?? []);
    const busyLifecycle = await busyPage.evaluate(() => globalThis.__appUpdateLifecycle ?? []);
    assert.deepEqual(resultEvents, [], 'Unchanged worker unexpectedly updated on the result tab');
    assert.deepEqual(busyEvents, [], 'Unchanged worker unexpectedly updated on the active tab');
    assert.equal(await resultPage.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null),
      initialWorker.controller, 'Result tab changed its service-worker controller');
    assert.equal(await busyPage.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null),
      busyWorker.controller, 'Busy tab changed its service-worker controller');
    assert.equal(resultRecord.metadataRequests.length, 2,
      'Result tab did not make exactly one lifecycle-triggered B check');
    assert.equal(busyRecord.metadataRequests.length, 2,
      'Busy tab did not make exactly one lifecycle-triggered B check');
    const equalCadenceMs = resultRecord.metadataRequests[1].atMs -
      resultRecord.metadataRequests[0].atMs;
    const busyCadenceMs = busyRecord.metadataRequests[1].atMs -
      busyRecord.metadataRequests[0].atMs;
    assert(equalCadenceMs >= 60_000, 'Result metadata checks violated 60s minimum cadence');
    assert(busyCadenceMs >= 60_000, 'Busy metadata checks violated 60s minimum cadence');
    await assertRuntimeHealth(resultPage, resultRecord);
    await assertRuntimeHealth(busyPage, busyRecord);

    diagnostics.phase = 'explicit-reload';
    await resultPage.getByRole('button', { name: 'Change', exact: true }).click();
    await resultReload.waitFor({ state: 'visible' });
    assert(await resultReload.isEnabled(), 'Reload did not enable after result was cleared');
    const reloadedScripts = [];
    resultPage.on('response', (response) => {
      if (new URL(response.url()).pathname === `/${buildB.main.path}`) reloadedScripts.push(response);
    });
    const [reloadedDocument] = await Promise.all([
      resultPage.waitForNavigation({ waitUntil: 'domcontentloaded' }), resultReload.click(),
    ]);
    assert.equal(reloadedDocument?.status(), 200);
    assert.equal(sha256(await reloadedDocument.body()), buildB.indexSha256,
      'Explicit reload did not load B HTML');
    await resultPage.waitForLoadState('networkidle');
    assert(reloadedScripts.length > 0, 'Explicit reload did not request B app entry');
    const servedMainSha = sha256(await reloadedScripts[0].body());
    assert.equal(servedMainSha, buildB.main.sha256, 'Explicit reload app entry differs from B inventory');
    assert.equal(await updateNotice(resultPage).isVisible(), false,
      'B falsely announced an update against its own metadata');
    await screenshot(resultPage, outputRoot, 'app-update-reloaded-b.png', artifacts);
    const coldB = await measureColdTransfer(browser, started, buildB);

    const resultMetadata = await metadataObservation(resultRecord);
    const busyMetadata = await metadataObservation(busyRecord);
    assert(resultMetadata.some((entry) => entry.sourceSha === buildA.state.sourceSha),
      'A page did not observe equal initial metadata');
    assert(resultMetadata.some((entry) => entry.sourceSha === buildB.state.sourceSha),
      'Retained result page did not observe B metadata');
    assert.equal(busyMetadata[0]?.sourceSha, buildA.state.sourceSha,
      'Busy first metadata did not observe A');
    assert.equal(busyMetadata[1]?.sourceSha, buildB.state.sourceSha,
      'Busy lifecycle check did not observe B');
    assert.equal(resultRecord.metadataOverflow, false);
    assert.equal(busyRecord.metadataOverflow, false);
    await assertRuntimeHealth(resultPage, resultRecord);
    await assertRuntimeHealth(busyPage, busyRecord);
    diagnostics.phase = 'passed';
    return { profile: 'wmc-media', status: 'passed', checks: [{
      id: 'application-update', status: 'passed',
      sourceA: buildA.state.sourceSha, sourceB: buildB.state.sourceSha,
      version: buildA.state.version, workerSha256: buildA.workerSha256,
      baseline, firstInstallNotice: false, equalIdentityNotice: false,
      cold: { buildA: coldA, buildB: coldB },
      quietWindowMs: 61_000, equalCadenceMs, busyCadenceMs,
      heldFirst, busyNotice: true, busyReloadDisabled: true,
      busyDocumentRetained: true, cancellationReselection: true,
      resultDownload: { filename: firstGif.filename, bytes: firstGif.bytes.length,
        sha256: sha256(firstGif.bytes) }, resultRetained: true,
      resultReloadDisabled: true, explicitReloadB: {
        htmlSha256: buildB.indexSha256, mainJsSha256: servedMainSha,
        metadataSourceSha: buildB.state.sourceSha },
      initialWorker, busyWorker, resultWorkerEvents: resultEvents, busyWorkerEvents: busyEvents,
      metadata: { result: { requests: resultRecord.metadataRequests,
        responses: resultMetadata }, busy: { requests: busyRecord.metadataRequests,
        responses: busyMetadata } },
      metadataTotals: { resultCount: resultRecord.metadataRequests.length,
        resultResponseBytes: resultMetadata.reduce((sum, entry) => sum + entry.bytes, 0),
        busyCount: busyRecord.metadataRequests.length,
        busyResponseBytes: busyMetadata.reduce((sum, entry) => sum + entry.bytes, 0) },
      lifecycle: { result: resultLifecycle, busy: busyLifecycle },
      expectedOfflineMetadataFailures: resultRecord.offlineMetadataFailures,
    }], artifacts };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    const cleanup = async (name, action) => {
      try { await action(); }
      catch (error) { cleanupErrors.push(`${name}: ${String(error)}`); }
    };
    if (resultContext) await cleanup('result offline reset', () => resultContext.setOffline(false));
    if (resultContext) await cleanup('result context close', () => resultContext.close());
    if (busyContext) await cleanup('busy context close', () => busyContext.close());
    if (started) await cleanup('server close', () => closeServer(started.server));
    const safeRecords = {};
    for (const [name, record] of Object.entries(diagnostics.records)) {
      safeRecords[name] = {
        pageErrors: record.pageErrors, consoleErrors: record.consoleErrors,
        failedRequests: record.failedRequests, failedResponses: record.failedResponses,
        uploads: record.uploads, external: record.external,
        offlineMetadataFailures: record.offlineMetadataFailures,
        metadataRequests: record.metadataRequests, metadataOverflow: record.metadataOverflow,
        metadataResponses: await Promise.all(record.metadataResponses.map(async ({
          status, path, body, atMs,
        }) => {
          const captured = await body;
          return { atMs, status, path,
            bodyBytes: captured.bytes?.length ?? null, bodyError: captured.error ?? null };
        })),
      };
    }
    await cleanup('diagnostics write', () => writeFile(join(outputRoot, 'app-update-diagnostics.json'),
      JSON.stringify({ ...diagnostics, primaryError: primaryError && String(primaryError),
        cleanupErrors, records: safeRecords }, null, 2)));
    if (!primaryError && cleanupErrors.length) throw new Error(cleanupErrors.join('; '));
  }
}
