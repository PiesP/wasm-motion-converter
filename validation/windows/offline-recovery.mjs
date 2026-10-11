// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readResultDownload(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-testid="download-result-button"]').click(),
  ]);
  const stream = await download.createReadStream();
  assert(stream, 'Retained result download has no readable stream');
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function exerciseBuildUpgrade(browser, baseUrl, bundleRoot, smallFixture, activeFixture, setDistribution) {
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
      for (const name of (await caches.keys()).filter((value) => value.startsWith('dropconvert-dynamic-'))) {
        const cache = await caches.open(name);
        for (const key of await cache.keys()) {
          if (!new URL(key.url).pathname.endsWith('.js')) continue;
          const response = await cache.match(key);
          if (response) return { cacheName: name, url: key.url, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
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
    await page.locator('[data-testid="result-section"]').waitFor({ state: 'visible', timeout: 120_000 });
    const oldDocumentTimeOrigin = await page.evaluate(() => performance.timeOrigin);
    const oldDownloadHref = await page.locator('[data-testid="download-result-button"]').getAttribute('href');
    assert(oldDownloadHref?.startsWith('blob:'), 'Prior build result has no downloadable Blob');
    const priorResultBytes = Buffer.from(await page.evaluate(async (url) =>
      Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())), oldDownloadHref));
    assert(priorResultBytes.length > 100, 'Prior result Blob is unexpectedly small');
    const priorResultSha256 = sha256(priorResultBytes);
    const cachedPaths = await page.evaluate(async () => {
      const paths = [];
      for (const name of (await caches.keys()).filter((value) => value.startsWith('dropconvert-'))) {
        for (const key of await (await caches.open(name)).keys()) paths.push(new URL(key.url).pathname);
      }
      return paths;
    });
    const neverFetched = oldOnly.find((name) =>
      /^(?:ar|es|ja|ko|zh-CN)\./.test(name) && !cachedPaths.includes(`/assets/${name}`));
    assert(neverFetched, 'Prior build has no removed, never-fetched locale chunk for upgrade acceptance');
    const locale = neverFetched.split('.')[0];
    assert.equal(await page.evaluate((path) => performance.getEntriesByType('resource')
      .some((entry) => new URL(entry.name).pathname === path), `/assets/${neverFetched}`), false,
    'Supposed never-fetched locale chunk was already requested');

    // A second old-build tab runs an actual conversion while the completed
    // result remains available in the first tab. The high-motion fixture is
    // also used by the maintained cancellation acceptance.
    activePage = await context.newPage();
    await activePage.goto(baseUrl);
    await activePage.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    await activePage.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    await activePage.locator('[data-testid="file-input"]').setInputFiles(activeFixture);
    for (const [group, value] of [
      ['format', 'gif'], ['quality', 'high'], ['scale', '1'], ['smart-frame-skip', 'adaptive'],
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
    if (await activeProceed.isVisible({ timeout: 1500 }).catch(() => false)) await activeProceed.click();
    await activePage.waitForFunction(() => {
      const progress = document.querySelector('[data-testid="dropzone"] [role="progressbar"]');
      const result = document.querySelector('[data-testid="result-section"]');
      const error = document.querySelector('[data-testid="error-display"]');
      return Number(progress?.getAttribute('data-progress')) > 0 || result || error;
    }, undefined, { timeout: 180_000 });
    const activeProgressAtSwitch = await activePage.evaluate(() =>
      Number(document.querySelector('[data-testid="dropzone"] [role="progressbar"]')?.getAttribute('data-progress')));
    assert(activeProgressAtSwitch > 0 &&
      !(await activePage.locator('[data-testid="result-section"]').isVisible()) &&
      !(await activePage.locator('[data-testid="error-display"]').isVisible()),
    'High-motion conversion completed or failed before the upgrade could begin');
    const activeDocumentTimeOrigin = await activePage.evaluate(() => performance.timeOrigin);
    // Capture DOM state synchronously at controllerchange. A later completed
    // result cannot prove that conversion was still active when the new worker
    // actually took control of this old-build tab.
    await activePage.evaluate(() => {
      globalThis.__wmcUpgradeControllerObservation = null;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        const visible = (selector) => {
          const element = document.querySelector(selector);
          return element instanceof HTMLElement && element.getClientRects().length > 0;
        };
        globalThis.__wmcUpgradeControllerObservation = {
          timeOrigin: performance.timeOrigin,
          progress: Number(document.querySelector('[data-testid="dropzone"] [role="progressbar"]')
            ?.getAttribute('data-progress')),
          stopVisible: visible('[data-testid="stop-conversion-button"]'),
          resultVisible: visible('[data-testid="result-section"]'),
          errorVisible: visible('[data-testid="error-display"]'),
        };
      }, { once: true });
    });

    await setDistribution('dist');
    assert(await activePage.locator('[data-testid="stop-conversion-button"]').isVisible(),
      'High-motion conversion ended before the new worker was requested');
    await page.evaluate(async () => {
      const old = navigator.serviceWorker.controller;
      const registration = await navigator.serviceWorker.getRegistration();
      assertRegistration(registration);
      await registration.update();
      if (navigator.serviceWorker.controller !== old) return;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('New worker did not claim retained tab')), 15_000);
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          clearTimeout(timeout);
          resolve(undefined);
        }, { once: true });
      });
      function assertRegistration(value) {
        if (!value) throw new Error('Prior service worker registration disappeared');
      }
    });
    await activePage.waitForFunction(() => Boolean(globalThis.__wmcUpgradeControllerObservation),
      undefined, { timeout: 15_000 });
    const atControllerChange = await activePage.evaluate(() =>
      globalThis.__wmcUpgradeControllerObservation);
    assert.equal(atControllerChange.timeOrigin, activeDocumentTimeOrigin,
      'The active tab reloaded before controllerchange was observed');
    assert(atControllerChange.progress > 0 && atControllerChange.progress < 100 &&
      atControllerChange.stopVisible && !atControllerChange.resultVisible &&
      !atControllerChange.errorVisible,
    `Conversion was not active at controllerchange: ${JSON.stringify(atControllerChange)}`);
    assert.equal(await page.evaluate(() => performance.timeOrigin), oldDocumentTimeOrigin,
      'Service worker upgrade reloaded the retained result tab');
    assert.equal(await page.locator('[data-testid="download-result-button"]').getAttribute('href'), oldDownloadHref,
      'Service worker upgrade discarded the prior result');
    assert.equal(await activePage.evaluate(() => performance.timeOrigin), activeDocumentTimeOrigin,
      'Service worker upgrade reloaded an actively converting old tab');
    await activePage.locator('[data-testid="result-section"]').waitFor({ state: 'visible', timeout: 180_000 });
    assert.equal(await activePage.evaluate(() => performance.timeOrigin), activeDocumentTimeOrigin,
      'Active old-build conversion reloaded before completion');
    assert.equal(await activePage.locator('[data-testid="error-display"]').isVisible(), false,
      'Active old-build conversion failed after worker update');
    const retainedDownload = await readResultDownload(page);
    assert.equal(sha256(retainedDownload), priorResultSha256,
      'Prior result download bytes changed after worker update');

    await context.setOffline(true);
    const oldAsset = await page.evaluate(async (url) => {
      const response = await fetch(url);
      return { status: response.status, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
    }, cached.url);
    assert.equal(oldAsset.status, 200);
    assert.equal(sha256(Buffer.from(oldAsset.bytes)), sha256(Buffer.from(cached.bytes)),
      'Cached prior JS changed after upgrade');
    await context.setOffline(false);

    const missingPath = `/assets/${neverFetched}`;
    const missingUrl = `${baseUrl}${missingPath}`;
    // The updated worker intentionally turns an invalid 404 asset response
    // into Response.error(). The browser sees requestfailed, not a 404 response.
    const missingAtOrigin = await context.request.get(missingUrl);
    assert.equal(missingAtOrigin.status(), 404, 'Removed locale chunk still exists in the candidate distribution');
    assert(!/\bimmutable\b/i.test(missingAtOrigin.headers()['cache-control'] ?? ''),
      'Removed locale chunk received immutable caching at the origin');
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
    await page.waitForFunction((path) => globalThis.__wmcUpgradeAssetMessages?.some(
      (message) => message.path === path && message.status === 404 &&
        message.reason === 'invalid-response'
    ), missingPath, { timeout: 15_000 });
    const workerMessage = await page.evaluate((path) =>
      globalThis.__wmcUpgradeAssetMessages.find((message) => message.path === path), missingPath);
    assert.equal(workerMessage.status, 404);
    assert.equal(workerMessage.reason, 'invalid-response');
    assert.equal(await page.evaluate(() => performance.timeOrigin), oldDocumentTimeOrigin,
      'Missing old locale chunk reloaded the retained result tab');
    assert.equal(await page.locator('[data-testid="download-result-button"]').getAttribute('href'), oldDownloadHref,
      'Missing old locale chunk discarded the prior result');
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="result-section"] h2')?.textContent?.trim() === 'Result',
    undefined, { timeout: 15_000 });
    const retainedAfterMissing = await readResultDownload(page);
    assert.equal(sha256(retainedAfterMissing), priorResultSha256,
      'Prior result download bytes changed after a missing lazy locale chunk');

    const currentJs = [...nextAssets].find((name) => name.endsWith('.js'));
    assert(currentJs, 'Candidate build has no JS assets');
    const polluted = await page.evaluate(async (url) => {
      const names = (await caches.keys()).filter((name) => name.startsWith('dropconvert-dynamic-'));
      const cache = await caches.open(names.at(-1));
      await cache.put(url, new Response('<!doctype html><title>poison</title>', {
        headers: { 'content-type': 'text/javascript' },
      }));
      const response = await fetch(url);
      const body = await response.text();
      return { status: response.status, contentType: response.headers.get('content-type'), html: /^\s*<!doctype html/i.test(body) };
    }, `${baseUrl}/assets/${currentJs}`);
    assert.equal(polluted.status, 200);
    assert.match(polluted.contentType, /^(?:text|application)\/javascript\b/i);
    assert.equal(polluted.html, false, 'Polluted JS cache entry was served as executable content');
    assert.equal(await page.evaluate(() => performance.timeOrigin), oldDocumentTimeOrigin);

    // The user has downloaded the retained result and explicitly reloads the
    // browser tab. The new document must load the current build and remain usable.
    await page.reload();
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    assert.notEqual(await page.evaluate(() => performance.timeOrigin), oldDocumentTimeOrigin,
      'Explicit browser reload did not replace the old document');
    const currentScripts = await page.evaluate(() => [...document.scripts]
      .map((script) => script.src && new URL(script.src).pathname)
      .filter(Boolean));
    const candidateHtml = await readFile(join(bundleRoot, 'dist/index.html'), 'utf8');
    const candidateEntry = candidateHtml.match(/<script[^>]+type="module"[^>]+src="(\/assets\/[^"]+\.js)"/i)?.[1];
    assert(candidateEntry, 'Candidate distribution has no module entry script');
    assert(currentScripts.includes(candidateEntry),
      'Explicit reload did not load the current document entry script');
    assert(currentScripts.some((path) => nextAssets.has(path.split('/').at(-1))),
      'Explicit reload did not load a current-build entry script');
    assert(currentScripts.every((path) => !oldOnly.includes(path.split('/').at(-1))),
      'Explicit reload retained a removed old-build entry script');
    await page.locator('[data-testid="option-format-webp"]').click();
    assert.equal(await page.locator('[data-testid="option-format-webp"] input').isChecked(), true,
      'Current application did not accept a settings interaction after explicit reload');
    return {
      id: 'real-build-upgrade', status: 'passed', priorOnlyNeverFetchedChunk: neverFetched,
      missingChunkTriggeredBy: `language-selector=${locale}`,
      cachedPriorAsset: new URL(cached.url).pathname, cachedPriorSha256: sha256(Buffer.from(cached.bytes)),
      retainedResultDownload: true, retainedResultSha256: priorResultSha256,
      retainedResultBytes: priorResultBytes.length, retainedDownloadAfterMissing: true,
      retainedDocument: true, activeConversionProgressAtSwitch: activeProgressAtSwitch,
      activeConversionAtControllerChange: atControllerChange,
      activeConversionCompletedWithoutReload: true,
      missingChunkStatus: missingAtOrigin.status(), missingChunkRequestFailure: requestFailure,
      missingChunkWorkerMessage: workerMessage, messageObservedByHarnessOnly: true,
      oldLocaleFallback: 'English', pollutedAssetRejected: true,
      explicitReloadLoadedCurrentBuild: true, currentAppSettingsInteraction: true,
    };
  } finally {
    await context.setOffline(false).catch(() => {});
    await context.close();
    await setDistribution('dist');
  }
}

export async function exerciseOfflineRecovery(browser, baseUrl, outputRoot, setDistribution, bundleRoot, smallFixture, activeFixture) {
  const upgrade = await exerciseBuildUpgrade(browser, baseUrl, bundleRoot, smallFixture, activeFixture, setDistribution);
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    // Seed the old poisoned entry before the production worker activates.
    await page.goto(`${baseUrl}/robots.txt`);
    await page.evaluate(async () => {
      const old = await caches.open('dropconvert-dynamic-v20260714');
      await old.put('/', new Response('old polluted recovery document', { headers: { 'content-type': 'text/plain' } }));
      const unrelated = await caches.open('acceptance-unrelated');
      await unrelated.put('/unrelated', new Response('preserved'));
    });
    await page.goto(baseUrl);
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    const identity = await page.evaluate(async () => ({
      controller: navigator.serviceWorker.controller.scriptURL,
      caches: await caches.keys(),
      unrelated: await (await (await caches.open('acceptance-unrelated')).match('/unrelated')).text(),
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
      return Boolean(await cache.match('/')) && (await cache.keys()).some((request) => new URL(request.url).pathname.endsWith('.js'));
    });
    const inspect = () => page.evaluate(async () => {
      const names = await caches.keys();
      const cacheName = names.find((name) => name.startsWith('dropconvert-dynamic-'));
      const response = await (await caches.open(cacheName)).match('/');
      return { cacheName, url: response.url, status: response.status,
        contentType: response.headers.get('content-type'), body: await response.text() };
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
    assert.deepEqual(after, before, 'Non-application navigation changed the canonical recovery entry');

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
      await cache.put('/', new Response('current polluted recovery document', { headers: { 'content-type': 'text/plain' } }));
    }, before.cacheName);
    const staticFallback = await page.reload();
    assert.equal(staticFallback.status(), 200);
    assert.equal(staticFallback.fromServiceWorker(), true);
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-testid="choose-file-button"]').isEnabled(), true);
    assert.equal(await page.evaluate(async (cacheName) => Boolean(
      await (await caches.open(cacheName)).match('/'),
    ), before.cacheName), false, 'Current polluted dynamic entry was retained');
    await page.screenshot({ path: join(outputRoot, 'offline-static-recovery.png'), fullPage: true });
    await context.setOffline(false);
    await page.locator('[data-testid="offline-banner"]').waitFor({ state: 'hidden' });
    assert.deepEqual(pageErrors, []);
    const digest = (body) => createHash('sha256').update(body).digest('hex');
    return { id: 'offline-app-recovery', status: 'passed', upgrade, controller: identity.controller,
      cacheName: before.cacheName, priorPollutedCacheRemoved: true, unrelatedCachePreserved: true,
      before: { url: before.url, status: before.status, contentType: before.contentType, bodySha256: digest(before.body) },
      after: { url: after.url, status: after.status, contentType: after.contentType, bodySha256: digest(after.body) },
      offlineResponseFromServiceWorker: true, offlineSettingsInteraction: true, onlineRestored: true,
      nonAppNavigationFromServiceWorker: true, currentPollutedEntryRemoved: true, staticFallbackFromServiceWorker: true,
      pageErrors: pageErrors.length };
  } catch (error) {
    await page.screenshot({ path: join(outputRoot, 'offline-recovery-error.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context.setOffline(false);
    await context.close();
  }
}
