// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';

import type { Page } from '@playwright/test';

import type { OutputContractCase } from './output-contract.ts';
import { verifyAnimatedOutput } from './output-contract.ts';

/** Exercise the real built UI, factory and decoder; inject only the failed load boundary. */
export async function exerciseWebpInitialization(
  page: Page,
  url: string,
  fixturePath: string,
  contract: OutputContractCase,
  markers: Record<string, number[]>,
  mode: 'factory' | 'import' | 'cancelled-factory'
) {
  let failures = 0;
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
    const nativeSetInterval = globalThis.setInterval;
    const nativeClearInterval = globalThis.clearInterval;
    const watchers = new Set<number>();
    globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const id = nativeSetInterval(handler, timeout, ...args);
      if (timeout === 10000) watchers.add(id);
      return id;
    }) as typeof setInterval;
    globalThis.clearInterval = (id) => {
      if (typeof id === 'number') watchers.delete(id);
      nativeClearInterval(id);
    };
    Reflect.set(globalThis, '__wmcInitializationWatchers', watchers);
  });
  await page.route('**/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const target =
      mode === 'import'
        ? /\/webp-wasm[.-].*\.js$/.test(path) || /wasm-webp_dist_esm_webp-wasm_+js\.js$/.test(path)
        : path.endsWith('.wasm');
    if (!target || failures > 0) return route.continue();
    failures++;
    blocked();
    if (mode === 'cancelled-factory') await released;
    if (mode === 'import') {
      await route.fulfill({
        status: 200,
        contentType: 'text/javascript',
        body: 'throw new Error("Bounded WebP module evaluation failure");',
      });
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
    const csp = response.headers()['content-security-policy'] ?? '';
    assert(
      csp.includes("'wasm-unsafe-eval'") && !csp.includes("'unsafe-eval'"),
      'Built CSP was not enforced'
    );
    assert(await page.evaluate(() => crossOriginIsolated));
    const before = await page.evaluate(() => performance.timeOrigin);
    await convert();
    if (mode === 'cancelled-factory') {
      await Promise.race([
        requestBlocked,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('WASM failure request was not intercepted within 15 seconds')),
            15000
          );
          timer.unref();
        }),
      ]);
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
      // The later explicit conversion observes the retained failed factory.
      await page.locator('[data-testid="convert-button"]').click();
    }
    const error = page.locator('[data-testid="error-display"]');
    await error.waitFor({ state: 'visible', timeout: 30000 });
    assert(
      (await error.textContent())?.includes(
        `WebP initialization failed (${mode === 'import' ? 'import' : 'factory'})`
      ),
      `Unexpected initialization UI: ${(await error.textContent())?.slice(0, 2000)}; console: ${consoleErrors.join('; ').slice(0, 2000)}`
    );
    assert.equal(await error.locator('[data-testid="error-retry-button"]').count(), 0);
    assert.equal(await error.locator('[data-testid^="error-select-different"]').count(), 0);
    const retainedWatchers = await page.evaluate(
      () => (Reflect.get(globalThis, '__wmcInitializationWatchers') as Set<number>).size
    );
    if (mode !== 'import')
      assert(
        retainedWatchers > 0,
        'Expected the locked factory to retain its dependency watcher after failed fetch'
      );
    assert.equal(await page.evaluate(() => performance.timeOrigin), before);
    const reload = page.getByRole('button', { name: 'Reload page', exact: true });
    assert(await reload.isEnabled());
    await Promise.all([page.waitForEvent('load'), reload.click()]);
    assert.notEqual(await page.evaluate(() => performance.timeOrigin), before);
    await convert();
    await page
      .locator('[data-testid="result-section"]')
      .waitFor({ state: 'visible', timeout: 60000 });
    assert.equal(await page.locator('[data-testid="error-display"]').count(), 0);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-testid="download-result-button"]').click();
    const stream = await (await downloadPromise).createReadStream();
    assert(stream);
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const decoded = await verifyAnimatedOutput(page, bytes, contract, markers);
    assert.equal(failures, 1);
    assert(
      pageErrors.every(
        (error) => mode === 'import' && error.includes('Bounded WebP module evaluation failure')
      ),
      `Unexpected page errors: ${pageErrors.join('; ')}`
    );
    assert(
      consoleErrors.every((error) =>
        /net::ERR_FAILED|WebP initialization failed|Conversion failed|Frame conversion errors detected/.test(
          error
        )
      ),
      `Unexpected console errors: ${consoleErrors.join('; ')}`
    );
    return {
      mode,
      failures,
      retainedWatchers,
      explicitReload: true,
      cancelledResultSuppressed: mode === 'cancelled-factory',
      decoded,
      bytes: bytes.length,
      pageErrors,
      consoleErrors,
    };
  } finally {
    release();
  }
}
