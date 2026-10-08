// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export async function exerciseOfflineRecovery(browser, baseUrl, outputRoot) {
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
    return { id: 'offline-app-recovery', status: 'passed', controller: identity.controller,
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
