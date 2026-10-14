// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { measureColdTransfer, readBuild } from './app-update.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readResultDownload(page, selector = '[data-testid="download-result-button"]') {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator(selector).click(),
  ]);
  const stream = await download.createReadStream();
  assert(stream, 'Retained result download has no readable stream');
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function exerciseBuildUpgrade(
  browser,
  baseUrl,
  bundleRoot,
  smallFixture,
  activeFixture,
  setDistribution
) {
  const context = await browser.newContext({ locale: 'en-US', acceptDownloads: true });
  const page = await context.newPage();
  let activePage;
  try {
    await setDistribution('validation/windows/prior-dist');
    await page.goto(baseUrl);
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    await page.reload();
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
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
    const priorAssets = await readdir(join(bundleRoot, 'validation/windows/prior-dist/assets'));
    const nextAssets = new Set(await readdir(join(bundleRoot, 'dist/assets')));
    const oldOnly = priorAssets.filter((name) => name.endsWith('.js') && !nextAssets.has(name));
    await page.locator('[data-testid="file-input"]').setInputFiles(smallFixture);
    await page.locator('[data-testid="convert-button"]').click();
    const proceed = page.locator('[data-testid="modal-confirm-button"]');
    if (await proceed.isVisible({ timeout: 1500 }).catch(() => false)) await proceed.click();
    await page
      .locator('[data-testid="result-section"]')
      .waitFor({ state: 'visible', timeout: 120_000 });
    const oldDocumentTimeOrigin = await page.evaluate(() => performance.timeOrigin);
    const oldDownloadHref = await page
      .locator('[data-testid="download-result-button"]')
      .getAttribute('href');
    assert(oldDownloadHref?.startsWith('blob:'), 'Prior build result has no downloadable Blob');
    const priorResultBytes = Buffer.from(
      await page.evaluate(
        async (url) => Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())),
        oldDownloadHref
      )
    );
    assert(priorResultBytes.length > 100, 'Prior result Blob is unexpectedly small');
    const priorResultSha256 = sha256(priorResultBytes);
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
    const neverFetched = oldOnly.find(
      (name) => /^(?:ar|es|ja|ko|zh-CN)\./.test(name) && !cachedPaths.includes(`/assets/${name}`)
    );
    assert(
      neverFetched,
      'Prior build has no removed, never-fetched locale chunk for upgrade acceptance'
    );
    const locale = neverFetched.split('.')[0];
    assert.equal(
      await page.evaluate(
        (path) =>
          performance
            .getEntriesByType('resource')
            .some((entry) => new URL(entry.name).pathname === path),
        `/assets/${neverFetched}`
      ),
      false,
      'Supposed never-fetched locale chunk was already requested'
    );

    // A second old-build tab runs an actual conversion while the completed
    // result remains available in the first tab. The high-motion fixture is
    // also used by the maintained cancellation acceptance.
    activePage = await context.newPage();
    await activePage.goto(baseUrl);
    await activePage.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    await activePage.waitForFunction(
      () => navigator.serviceWorker.controller?.state === 'activated'
    );
    await activePage.locator('[data-testid="file-input"]').setInputFiles(activeFixture);
    for (const [group, value] of [
      ['format', 'gif'],
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
    // Capture DOM state synchronously at controllerchange. A later completed
    // result cannot prove that conversion was still active when the new worker
    // actually took control of this old-build tab.
    await activePage.evaluate(() => {
      globalThis.__wmcUpgradeControllerObservation = null;
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => {
          const visible = (selector) => {
            const element = document.querySelector(selector);
            return element instanceof HTMLElement && element.getClientRects().length > 0;
          };
          globalThis.__wmcUpgradeControllerObservation = {
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
        },
        { once: true }
      );
    });

    await setDistribution('dist');
    assert(
      await activePage.locator('[data-testid="stop-conversion-button"]').isVisible(),
      'High-motion conversion ended before the new worker was requested'
    );
    await page.evaluate(async () => {
      const old = navigator.serviceWorker.controller;
      const registration = await navigator.serviceWorker.getRegistration();
      assertRegistration(registration);
      await registration.update();
      if (navigator.serviceWorker.controller !== old) return;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('New worker did not claim retained tab')),
          15_000
        );
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => {
            clearTimeout(timeout);
            resolve(undefined);
          },
          { once: true }
        );
      });
      function assertRegistration(value) {
        if (!value) throw new Error('Prior service worker registration disappeared');
      }
    });
    await activePage.waitForFunction(
      () => Boolean(globalThis.__wmcUpgradeControllerObservation),
      undefined,
      { timeout: 15_000 }
    );
    const atControllerChange = await activePage.evaluate(
      () => globalThis.__wmcUpgradeControllerObservation
    );
    assert.equal(
      atControllerChange.timeOrigin,
      activeDocumentTimeOrigin,
      'The active tab reloaded before controllerchange was observed'
    );
    assert(
      atControllerChange.progress > 0 &&
        atControllerChange.progress < 100 &&
        atControllerChange.stopVisible &&
        !atControllerChange.resultVisible &&
        !atControllerChange.errorVisible,
      `Conversion was not active at controllerchange: ${JSON.stringify(atControllerChange)}`
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
    await context.setOffline(false);

    const missingPath = `/assets/${neverFetched}`;
    const missingUrl = `${baseUrl}${missingPath}`;
    // The updated worker intentionally turns an invalid 404 asset response
    // into Response.error(). The browser sees requestfailed, not a 404 response.
    const missingAtOrigin = await context.request.get(missingUrl);
    assert.equal(
      missingAtOrigin.status(),
      404,
      'Removed locale chunk still exists in the candidate distribution'
    );
    assert(
      !/\bimmutable\b/i.test(missingAtOrigin.headers()['cache-control'] ?? ''),
      'Removed locale chunk received immutable caching at the origin'
    );
    // This listener belongs only to the acceptance harness. The old app cannot
    // display a notice introduced by the new bundle while its document stays open.
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
      page.locator('[data-testid="language-selector"]').selectOption(locale),
    ]);
    const requestFailure = blockedRequest.failure()?.errorText;
    assert(requestFailure, 'Removed locale chunk failed without browser failure detail');
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
    assert.equal(workerMessage.status, 404);
    assert.equal(workerMessage.reason, 'invalid-response');
    assert.equal(
      await page.evaluate(() => performance.timeOrigin),
      oldDocumentTimeOrigin,
      'Missing old locale chunk reloaded the retained result tab'
    );
    assert.equal(
      await page.locator('[data-testid="download-result-button"]').getAttribute('href'),
      oldDownloadHref,
      'Missing old locale chunk discarded the prior result'
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
      'Prior result download bytes changed after a missing lazy locale chunk'
    );

    const currentJs = [...nextAssets].find((name) => name.endsWith('.js'));
    assert(currentJs, 'Candidate build has no JS assets');
    const polluted = await page.evaluate(async (url) => {
      const names = (await caches.keys()).filter((name) => name.startsWith('dropconvert-dynamic-'));
      const cache = await caches.open(names.at(-1));
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
    assert.match(polluted.contentType, /^(?:text|application)\/javascript\b/i);
    assert.equal(polluted.html, false, 'Polluted JS cache entry was served as executable content');
    assert.equal(await page.evaluate(() => performance.timeOrigin), oldDocumentTimeOrigin);

    // The user has downloaded the retained result and explicitly reloads the
    // browser tab. The new document must load the current build and remain usable.
    await page.reload();
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
      currentScripts.some((path) => nextAssets.has(path.split('/').at(-1))),
      'Explicit reload did not load a current-build entry script'
    );
    assert(
      currentScripts.every((path) => !oldOnly.includes(path.split('/').at(-1))),
      'Explicit reload retained a removed old-build entry script'
    );
    await page.locator('[data-testid="option-format-webp"]').click();
    assert.equal(
      await page.locator('[data-testid="option-format-webp"] input').isChecked(),
      true,
      'Current application did not accept a settings interaction after explicit reload'
    );
    return {
      id: 'real-build-upgrade',
      status: 'passed',
      priorOnlyNeverFetchedChunk: neverFetched,
      missingChunkTriggeredBy: `language-selector=${locale}`,
      cachedPriorAsset: new URL(cached.url).pathname,
      cachedPriorSha256: sha256(Buffer.from(cached.bytes)),
      retainedResultDownload: true,
      retainedResultSha256: priorResultSha256,
      retainedResultBytes: priorResultBytes.length,
      retainedDownloadAfterMissing: true,
      retainedDocument: true,
      activeConversionProgressAtSwitch: activeProgressAtSwitch,
      activeConversionAtControllerChange: atControllerChange,
      activeConversionCompletedWithoutReload: true,
      missingChunkStatus: missingAtOrigin.status(),
      missingChunkRequestFailure: requestFailure,
      missingChunkWorkerMessage: workerMessage,
      messageObservedByHarnessOnly: true,
      oldLocaleFallback: 'English',
      pollutedAssetRejected: true,
      explicitReloadLoadedCurrentBuild: true,
      currentAppSettingsInteraction: true,
    };
  } finally {
    await context.setOffline(false).catch(() => {});
    await context.close();
    await setDistribution('dist');
  }
}

export async function exerciseOfflineRecovery(
  browser,
  baseUrl,
  outputRoot,
  setDistribution,
  bundleRoot,
  smallFixture,
  activeFixture
) {
  const upgrade = await exerciseBuildUpgrade(
    browser,
    baseUrl,
    bundleRoot,
    smallFixture,
    activeFixture,
    setDistribution
  );
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const pageErrors = [];
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
      controller: navigator.serviceWorker.controller.scriptURL,
      caches: await caches.keys(),
      unrelated: await (
        await (await caches.open('acceptance-unrelated')).match('/unrelated')
      ).text(),
    }));
    assert.equal(identity.controller, `${baseUrl}/service-worker.js`);
    assert(!identity.caches.includes('dropconvert-dynamic-v20260714'));
    assert.equal(identity.unrelated, 'preserved');

    // Reload under the controller so application assets and the root response
    // reach the real worker before the browser's network is disabled.
    await page.goto(`${baseUrl}/?offline-acceptance=online`);
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
        const response = await (await caches.open(cacheName)).match('/');
        return {
          cacheName,
          url: response.url,
          status: response.status,
          contentType: response.headers.get('content-type'),
          body: await response.text(),
        };
      });
    const before = await inspect();
    assert.match(before.contentType, /^text\/html\b/);
    assert.equal(before.status, 200);

    const textResponse = await page.goto(`${baseUrl}/robots.txt`);
    assert.equal(textResponse.status(), 200);
    assert.equal(textResponse.fromServiceWorker(), true);
    assert.match(textResponse.headers()['content-type'], /^text\/plain\b/);
    assert((await page.locator('body').textContent()).includes('User-agent:'));
    const after = await inspect();
    assert.deepEqual(
      after,
      before,
      'Non-application navigation changed the canonical recovery entry'
    );

    await context.setOffline(true);
    const offlineResponse = await page.goto(`${baseUrl}/?offline-acceptance=recovery`);
    assert.equal(offlineResponse.status(), 200);
    assert.equal(offlineResponse.fromServiceWorker(), true);
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    await page.locator('[data-testid="offline-banner"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-testid="choose-file-button"]').isEnabled(), true);
    await page.locator('[data-testid="option-format-webp"]').click();
    assert.equal(await page.locator('[data-testid="option-format-webp"] input').isChecked(), true);
    await page.screenshot({ path: join(outputRoot, 'offline-app-recovery.png'), fullPage: true });
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
    await context.setOffline(false);
    await page.locator('[data-testid="offline-banner"]').waitFor({ state: 'hidden' });
    assert.deepEqual(pageErrors, []);
    const digest = (body) => createHash('sha256').update(body).digest('hex');
    return {
      id: 'offline-app-recovery',
      status: 'passed',
      upgrade,
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
function requireRecoverySelector(config) {
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
  const expected = config.assertionProbe === undefined ? keys : [...keys, 'assertionProbe'];
  assert.deepEqual(Object.keys(config).sort(), expected.sort(), 'Invalid recovery selector keys');
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.mode, 'recovery');
  assert.equal(config.baseline, RECOVERY_BASELINE);
  assert.equal(config.buildA, RECOVERY_A);
  assert.equal(config.busyFixture, RECOVERY_BUSY_FIXTURE);
  assert.match(config.busyFixtureSha256, FILE_SHA);
  if (config.assertionProbe !== undefined) assert.equal(typeof config.assertionProbe, 'boolean');
  for (const key of [
    'baselineSourceSha',
    'baselineTreeSha',
    'sourceA',
    'treeA',
    'sourceB',
    'treeB',
  ])
    assert.match(config[key], SOURCE_SHA, `Invalid ${key}`);
}

function emittedAsset(build, pattern) {
  const matches = build.state.files.filter((file) => pattern.test(file.path));
  assert.equal(matches.length, 1, `${build.relativePath} needs exactly one emitted ${pattern}`);
  return matches[0];
}

function assetPath(asset) {
  return `/${asset.path}`;
}

async function assertNeverFetched(page, path) {
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

function observePage(page) {
  const events = {
    pageErrors: [],
    consoleErrors: [],
    consoleWarnings: [],
    requestedAssets: [],
    failedRequests: [],
    failedResponses: [],
    overflow: false,
  };
  const append = (array, value) => {
    if (array.length >= 128) events.overflow = true;
    else array.push(value);
  };
  const safePath = (url) => {
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

function assertExpectedNetwork(events, expectedPath) {
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

async function readLogExport(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-testid="export-logs-button"]').click(),
  ]);
  const bytes = await readFile(await download.path());
  assert(bytes.length > 0 && bytes.length < 1024 * 1024, 'Log export is empty or unbounded');
  return { sha256: sha256(bytes), bytes: bytes.length, text: bytes.toString('utf8') };
}

async function observeLogExportInteraction(page) {
  await page.evaluate(() => {
    const observation = { buttonClicks: 0, downloadAnchors: [] };
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

async function persistOfflineExportFailure(page, outputRoot, controlled, details, events, error) {
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

async function waitForOriginAsset(started, path, priorCount) {
  // SW-originated requests can bypass Playwright page.route; observe the owned
  // loopback server itself and keep the wait bounded.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (started.observedAssetRequests.slice(priorCount).includes(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`The owned origin never received ${path}`);
}

async function requireApp(page, baseUrl) {
  const response = await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  assert.equal(response?.status(), 200, 'Built app did not boot');
  await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => globalThis.crossOriginIsolated), true);
  return await page.evaluate(() => performance.timeOrigin);
}

async function validationError(page) {
  await page.locator('[data-testid="file-input"]').setInputFiles({
    name: 'unsupported.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('This is not a video.'),
  });
}

async function baselineFirstError(browser, started, baseline, outputRoot) {
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
    assert(primary?.includes('Unsupported'), 'Primary validation error was not separately logged');
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

async function fixedFirstError(browser, started, build, outputRoot) {
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
    assert.match(await display.textContent(), /Unsupported/i);
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

async function memoryWarningOffline(browser, started, build, smallFixture) {
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

async function createSmallGif(page, fixture) {
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

async function triggerLocaleFailure(page, started, chunk, mode) {
  const path = assetPath(chunk);
  await assertNeverFetched(page, path);
  const before = started.observedAssetRequests.length;
  if (mode !== 'missing-after-update') started.setAssetFailure({ path, mode });
  await page.locator('[data-testid="language-selector"]').selectOption('es');
  await waitForOriginAsset(started, path, before);
  if (mode !== 'missing-after-update') {
    assert(
      started.assetFailureRequests.length >= 1 && started.assetFailureRequests.length <= 2,
      'Injected asset request count is outside the Vite preload/import pair'
    );
  }
  await page
    .getByRole('status')
    .filter({
      has: page.getByRole('button', { name: 'Reload page' }),
    })
    .waitFor({ state: 'visible', timeout: 15_000 });
  return path;
}

async function captureWorkerAssetMessages(page) {
  await page.evaluate(() => {
    globalThis.__wmcRecoveryWorkerMessages = [];
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.source !== navigator.serviceWorker.controller) return;
      if (event.data?.type === 'dropconvert:asset-unavailable')
        globalThis.__wmcRecoveryWorkerMessages.push(event.data);
    });
  });
}

async function requireWorkerAssetMessage(page, path, status, reason) {
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

async function optionalFailureCase(browser, started, build, fixture, outputRoot, mode, controlled) {
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
    const path = await triggerLocaleFailure(page, started, chunk, mode);
    const workerMessage = controlled
      ? await requireWorkerAssetMessage(
          page,
          path,
          mode === 'network' ? 0 : mode === '404' ? 404 : 200,
          mode === 'network' ? 'network-error' : 'invalid-response'
        )
      : null;
    const retained = result ? await readResultDownload(page) : null;
    if (result)
      assert.equal(
        sha256(retained),
        result.sha256,
        'Optional import failure changed result download'
      );
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
      screenshotSha256: sha256(await readFile(screenshot)),
      events,
    };
  } finally {
    started.setAssetFailure(null);
    await context.close();
  }
}

async function offlineOptionalMiss(browser, started, build, fixture, outputRoot, controlled) {
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
    let log;
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

async function loadSpanishThenEnglish(page) {
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

async function installControlledFormatterFault(page, target) {
  await page.evaluate((target) => {
    const original = Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype, 'format');
    if (!original?.get || !original.configurable)
      throw new Error('Intl.NumberFormat formatter fault seam is unavailable');
    globalThis.__wmcRestoreNumberFormat = () =>
      Object.defineProperty(Intl.NumberFormat.prototype, 'format', original);
    Object.defineProperty(Intl.NumberFormat.prototype, 'format', {
      configurable: true,
      get() {
        const options = this.resolvedOptions();
        const formatter = original.get.call(this);
        return (value) => {
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

function resultSizeFormatterTarget(bytes) {
  const unitIndex = bytes >= 1024 ** 3 ? 3 : bytes >= 1024 ** 2 ? 2 : bytes >= 1024 ? 1 : 0;
  return {
    kind: 'result-size',
    maximumFractionDigits: unitIndex === 0 ? 0 : 2,
    value: bytes / 1024 ** unitIndex,
  };
}

async function ordinaryRenderFailure(browser, started, build, fixture, outputRoot) {
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

async function busyRenderFailure(browser, started, build, busyFixture, outputRoot) {
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

async function observeFreshBWhileARetained(browser, started, buildB, retainedPage, oldDocument) {
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
    if (entryOutcome.error) throw entryOutcome.error;
    const entry = entryOutcome.response;
    assert.equal(entry.status(), 200, 'Fresh B entry did not load');
    assert.equal(sha256(await entry.body()), buildB.main.sha256, 'Fresh tab did not receive B JS');
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    const scripts = await page.evaluate(() =>
      [...document.scripts]
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
  browser,
  started,
  buildA,
  buildB,
  fixture,
  outputRoot,
  controlled
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
}) {
  const diagnostics = {
    profile: 'wmc-media-recovery',
    status: 'incomplete',
    checks: [],
    builds: {},
    coldTransfer: { encoding: 'gzip', budgetBytesExclusive: 150_000, baseline: null, B: null },
    activeCheck: null,
    failure: null,
    assertionProbe: false,
  };
  let started;
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
    ]) {
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
    const add = async (id, promise) => {
      diagnostics.activeCheck = id;
      const check = await promise;
      diagnostics.checks.push(check);
      await writeFile(
        join(outputRoot, 'recovery-diagnostics.json'),
        JSON.stringify(diagnostics, null, 2)
      );
      assert.equal(check.events?.overflow, false, `${id} exceeded bounded event capture`);
      assert.equal(started.observedAssetOverflow, false, 'Origin asset observation overflowed');
      diagnostics.activeCheck = null;
    };
    await add(
      'baseline-first-error-red',
      baselineFirstError(browser, started, baseline, outputRoot)
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
      for (const mode of ['404', 'wrong-mime', 'network'])
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
    // biome-ignore lint/correctness/noUnsafeFinally: Raise cleanup failure only when no check already failed.
    if (cleanupFailure && !diagnostics.failure) throw cleanupFailure;
  }
}
