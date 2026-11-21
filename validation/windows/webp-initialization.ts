// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';

import type { Page } from '@playwright/test';

import type { OutputContractCase } from './output-contract.ts';
import { verifyAnimatedOutput } from './output-contract.ts';

/** Exercise the built UI and its owned VP8 asset boundary in one document. */
export async function exerciseWebpInitialization(
  page: Page,
  url: string,
  fixturePath: string,
  contract: OutputContractCase,
  markers: Record<string, number[]>,
  mode: 'http-failure' | 'invalid-module' | 'cancelled-load'
) {
  let injections = 0;
  let moduleRequests = 0;
  let blocked!: () => void;
  const requestBlocked = new Promise<void>((resolve) => {
    blocked = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.addInitScript(() => {
    Object.defineProperty(OffscreenCanvas.prototype, 'convertToBlob', {
      configurable: true,
      value: undefined,
    });
  });
  await page.route('**/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!/\/owned-vp8(?:[-.][A-Za-z0-9_-]+)?\.wasm$/.test(path)) return route.continue();
    moduleRequests++;
    if (injections > 0) return route.continue();
    injections++;
    blocked();
    if (mode === 'cancelled-load') await released;
    if (mode === 'invalid-module') {
      await route.fulfill({
        status: 200,
        contentType: 'application/wasm',
        headers: { 'cache-control': 'no-store' },
        body: Buffer.from('invalid owned VP8 module'),
      });
    } else if (mode === 'http-failure') {
      await route.fulfill({ status: 503, contentType: 'application/wasm', body: '' });
    } else await route.abort('failed');
  });
  async function convert() {
    await page.locator('[data-testid="file-input"]').setInputFiles(fixturePath);
    await page.locator('[data-testid="convert-button"]').waitFor({ state: 'visible' });
    for (const [group, value] of [
      ['format', 'webp'],
      ['quality', contract.settings.quality],
      ['scale', contract.settings.scale],
      ['smart-frame-skip', 'off'],
    ]) {
      const option = page.locator(`[data-testid="option-${group}-${value}"]`);
      if (!(await option.isVisible()))
        await page.locator('[data-testid="advanced-settings"] summary').click();
      await option.click();
    }
    await page.locator('[data-testid="convert-button"]').click();
  }
  try {
    const response = await page.goto(url);
    assert(response);
    assert(response.ok());
    const headers = await response.allHeaders();
    assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(headers['cross-origin-embedder-policy'], 'require-corp');
    const csp = headers['content-security-policy'] ?? '';
    assert(
      csp.includes("'wasm-unsafe-eval'") && !csp.includes("'unsafe-eval'"),
      'Built CSP was not enforced'
    );
    assert(await page.evaluate(() => crossOriginIsolated));
    const documentOrigin = await page.evaluate(() => performance.timeOrigin);
    await convert();
    await Promise.race([
      requestBlocked,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Owned VP8 WASM request was not intercepted within 15 seconds')),
          15000
        );
        timer.unref();
      }),
    ]);
    if (mode === 'cancelled-load') {
      await page.locator('[data-testid="dropzone-cancel-button"]').click();
      release();
      await page
        .locator('[data-testid="convert-button"]')
        .waitFor({ state: 'visible', timeout: 30000 });
      assert.equal(
        await page.locator('[data-testid="result-section"]').count(),
        0,
        'Cancelled initialization published a result'
      );
      assert.equal(
        await page.locator('[data-testid="error-display"]').count(),
        0,
        'Stale initialization published an error'
      );
      assert.equal(moduleRequests, 1, 'Cancelled load retried without a new user request');
      await page.locator('[data-testid="convert-button"]').click();
    } else {
      const error = page.locator('[data-testid="error-display"]');
      await error.waitFor({ state: 'visible', timeout: 30000 });
      assert(
        (await error.textContent())?.trim(),
        'Owned VP8 load failure did not show an error message'
      );
      assert.equal(moduleRequests, 1, 'Failed load retried without a new user request');
      assert.equal(await page.locator('[data-testid="result-section"]').count(), 0);
      // Actual owned load errors retain the file and expose the general Retry action.
      await error.locator('[data-testid="error-retry-button"]').click({ timeout: 15000 });
    }
    await page
      .locator('[data-testid="result-section"]')
      .waitFor({ state: 'visible', timeout: 60000 });
    assert.equal(await page.locator('[data-testid="error-display"]').count(), 0);
    assert.equal(await page.evaluate(() => performance.timeOrigin), documentOrigin);
    assert.equal(injections, 1, 'Owned VP8 load failure was not injected exactly once');
    assert(moduleRequests >= 2, 'A fresh user request made no new owned VP8 module request');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-testid="download-result-button"]').click();
    const stream = await (await downloadPromise).createReadStream();
    assert(stream);
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const decoded = await verifyAnimatedOutput(page, bytes, contract, markers);
    assert.equal(pageErrors.length, 0, `Unexpected page errors: ${pageErrors.join('; ')}`);
    assert(
      consoleErrors.every((error) =>
        /Failed to load resource|net::ERR_FAILED|Conversion failed|Frame conversion errors detected/.test(
          error
        )
      ),
      `Unexpected console errors: ${consoleErrors.join('; ')}`
    );
    return {
      mode,
      injections,
      moduleRequests,
      sameDocument: true,
      cancelledResultSuppressed: mode === 'cancelled-load',
      decoded,
      bytes: bytes.length,
      pageErrors,
      consoleErrors,
    };
  } catch (error) {
    const state = await page
      .locator('#app-state')
      .textContent()
      .catch(() => null);
    throw new Error(
      `Owned VP8 ${mode} recovery failed; injected=${injections}; requests=${moduleRequests}; state=${state}; pageErrors=${pageErrors.join('; ').slice(0, 2000)}; consoleErrors=${consoleErrors.join('; ').slice(0, 2000)}`,
      { cause: error }
    );
  } finally {
    release();
  }
}
