// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';

import type { Page } from '@playwright/test';

export async function exerciseAnalysisRecovery(page: Page, url: string, fixture: string) {
  await page.addInitScript(() => {
    const native = VideoDecoder.isConfigSupported.bind(VideoDecoder);
    let release: ((value: VideoDecoderSupport) => void) | undefined;
    let first = true;
    VideoDecoder.isConfigSupported = (config) => {
      if (!first) return native(config);
      first = false;
      Reflect.set(globalThis, '__supportPending', true);
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    Reflect.set(globalThis, '__releaseSupport', () => release?.({ supported: false }));
  });
  await page.goto(url);
  await page.locator('[data-testid="file-input"]').setInputFiles(fixture);
  await page.waitForFunction(() => Reflect.get(globalThis, '__supportPending') === true);
  await page.locator('[data-testid="dropzone-cancel-button"]').click();
  await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
  await page.evaluate(() => Reflect.get(globalThis, '__releaseSupport')());
  await page.locator('[data-testid="file-input"]').setInputFiles(fixture);
  await page.locator('[data-testid="convert-button"]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-testid="error-display"]').count(), 0);
  await page.locator('[data-testid="convert-button"]').click();
  await page
    .locator('[data-testid="result-section"]')
    .waitFor({ state: 'visible', timeout: 60000 });
  return {
    heldQueryCancelled: true,
    lateUnsupportedIgnored: true,
    reselection: true,
    recoveryConversion: true,
  };
}

export async function exerciseWorkerRecovery(page: Page, url: string, fixture: string) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 2 });
    const NativeWorker = Worker;
    const counts = { constructed: 0, errors: 0, terminated: 0 };
    Reflect.set(globalThis, '__workerCounts', counts);
    globalThis.Worker = class extends NativeWorker {
      constructor(script: string | URL, options?: WorkerOptions) {
        super(script, options);
        counts.constructed++;
        this.addEventListener('error', () => {
          counts.errors++;
        });
      }
      override terminate() {
        counts.terminated++;
        super.terminate();
      }
    };
    const nativeDecode = VideoDecoder.prototype.decode;
    const nativeFlush = VideoDecoder.prototype.flush;
    const pending: { decoder: VideoDecoder; chunk: EncodedVideoChunk }[] = [];
    let held = true;
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    VideoDecoder.prototype.decode = function (chunk) {
      if (held) pending.push({ decoder: this, chunk });
      else nativeDecode.call(this, chunk);
    };
    VideoDecoder.prototype.flush = async function () {
      await flushGate;
      return nativeFlush.call(this);
    };
    Reflect.set(globalThis, '__releaseDecode', () => {
      held = false;
      for (const { decoder, chunk } of pending.splice(0)) nativeDecode.call(decoder, chunk);
      releaseFlush();
    });
  });
  let inject = true;
  let requests = 0;
  await page.route('**/*', async (route) => {
    if (
      inject &&
      /\/webp-encoder-worker-[^/]+\.js$/.test(new URL(route.request().url()).pathname)
    ) {
      requests++;
      await route.abort('failed');
    } else await route.continue();
  });
  await page.goto(url);
  await page.locator('[data-testid="file-input"]').setInputFiles(fixture);
  await page.locator('[data-testid="convert-button"]').waitFor({ state: 'visible' });
  const webp = page.locator('[data-testid="option-format-webp"]');
  if (!(await webp.isVisible()))
    await page.locator('[data-testid="advanced-settings"] summary').click();
  await webp.click();
  await page.locator('[data-testid="convert-button"]').click();
  try {
    await page.waitForFunction(() => Reflect.get(globalThis, '__workerCounts').errors >= 2, null, {
      timeout: 30000,
    });
  } catch (error) {
    const counts = await page.evaluate(() => Reflect.get(globalThis, '__workerCounts'));
    const state = await page
      .locator('#app-state')
      .textContent()
      .catch(() => null);
    const visibleError = await page
      .locator('[data-testid="error-display"]')
      .textContent()
      .catch(() => null);
    throw new Error(
      `Worker injection timed out; counts=${JSON.stringify(counts)}; requests=${requests}; state=${state}; error=${visibleError}`,
      { cause: error }
    );
  }
  const counts = await page.evaluate(
    () =>
      Reflect.get(globalThis, '__workerCounts') as {
        constructed: number;
        errors: number;
        terminated: number;
      }
  );
  assert.equal(counts.constructed, 2);
  assert.equal(counts.errors, 2);
  assert.equal(counts.terminated, 2);
  assert.equal(requests, 2);
  await page.waitForTimeout(1000);
  assert.deepEqual(await page.evaluate(() => Reflect.get(globalThis, '__workerCounts')), counts);
  assert.equal(requests, 2);
  await page.evaluate(() => Reflect.get(globalThis, '__releaseDecode')());
  await page.locator('[data-testid="error-display"]').waitFor({ state: 'visible', timeout: 30000 });
  inject = false;
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const retry = page.locator('[data-testid="error-retry-button"]');
  if (await retry.count()) {
    await retry.click();
  } else {
    await page.locator('[data-testid="error-select-different-fallback-button"]').click();
    await page.locator('[data-testid="file-input"]').setInputFiles(fixture);
    await page.locator('[data-testid="convert-button"]').waitFor({ state: 'visible' });
    const webpOption = page.locator('[data-testid="option-format-webp"]');
    if (!(await webpOption.isVisible()))
      await page.locator('[data-testid="advanced-settings"] summary').click();
    await webpOption.click();
    await page.locator('[data-testid="convert-button"]').click();
  }
  await page
    .locator('[data-testid="result-section"]')
    .waitFor({ state: 'visible', timeout: 60000 });
  assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin);
  return { ...counts, requests, failedOutcome: true, recoveryConversion: true };
}
