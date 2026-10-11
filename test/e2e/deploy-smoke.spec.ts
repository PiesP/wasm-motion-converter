// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP
//
// Deployment smoke test — runs against the deployed production URL.
// Verifies core functionality works in the deployed environment.
//
// Run with:
//   pnpm exec playwright test test/e2e/deploy-smoke.spec.ts --reporter=list
//
// Environment variables:
//   DEPLOY_URL — the deployed URL to test (default: https://wasm-motion-converter.pages.dev)

import { test, expect, type APIResponse, type Page, type Response } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { assertExecutableBody, assertExecutableResponse } from './lib/deployment-responses';

const DEPLOY_URL = process.env.DEPLOY_URL || 'https://wasm-motion-converter.pages.dev';
const TEST_VIDEO_PATH =
  process.env.DEPLOY_TEST_VIDEO || resolve(process.cwd(), 'public/test-video-ci-h264.mp4');
const REVALIDATION = 'public, max-age=0, must-revalidate';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const FINGERPRINTED_ASSET = /^assets\/[\w.-]+[.-][\w-]{8}\.(js|css|wasm)$/;

test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dropconvert.locale', 'en'));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getConsoleErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  return errors;
}

async function collectRuntimeFailures(page: Page): Promise<() => Promise<Record<string, string[]>>> {
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const consoleErrors = await getConsoleErrors(page);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    if (request.url().startsWith('blob:') && request.failure()?.errorText === 'net::ERR_ABORTED') return;
    requestFailures.push(`${request.failure()?.errorText ?? 'unknown'} ${request.url()}`);
  });
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.defineProperty(globalThis, '__deployCspViolations', { value: violations });
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(`${event.effectiveDirective}: ${event.blockedURI}`);
    });
  });
  return async () => ({
    pageErrors,
    requestFailures,
    consoleErrors,
    cspViolations: await page.evaluate(() => (
      (globalThis as typeof globalThis & { __deployCspViolations?: string[] }).__deployCspViolations ?? []
    )),
  });
}

async function getFailedResources(page: Page): Promise<string[]> {
  const failed: string[] = [];
  page.on('response', (response) => {
    if (!response.ok() && response.request().resourceType() !== 'document') {
      failed.push(`${response.status()} ${response.url()}`);
    }
  });
  return failed;
}

/**
 * Capture a screenshot and save it to the test-results directory.
 * Used for visual inspection of the deployed UI.
 */
async function captureScreenshot(page: Page, name: string): Promise<void> {
  const screenshotDir = resolve(process.cwd(), 'test-results/screenshots');
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: resolve(screenshotDir, `${name}.png`), fullPage: false });
}

async function uploadTestVideo(page: Page): Promise<void> {
  await page.locator('#file-upload').setInputFiles(TEST_VIDEO_PATH);
  await expect(page.getByRole('button', { name: 'Convert', exact: true })).toBeEnabled();
  await expect(page.getByText('Input Video', { exact: true }).locator('..')).toContainText(
    basename(TEST_VIDEO_PATH)
  );
}

async function startConversion(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Convert', exact: true }).click();
  const modalProceed = page.getByRole('button', { name: 'Proceed with conversion despite warnings' });
  if (await modalProceed.isVisible({ timeout: 5000 }).catch(() => false)) {
    await modalProceed.click();
  }
}

function resultSection(page: Page) {
  return page.getByRole('heading', { name: 'Result', exact: true }).locator('..');
}

function downloadLink(page: Page) {
  return page.getByRole('link', { name: /^Download (?:GIF|WEBP) file —/ });
}

function expectSingleHeader(response: APIResponse, name: string, value: string): void {
  const values = response.headersArray()
    .filter((header) => header.name.toLowerCase() === name)
    .map((header) => header.value);
  expect(values, `${response.url()} ${name} values`).toEqual([value]);
}

function expectSecurityHeaders(response: APIResponse, csp: string): void {
  expectSingleHeader(response, 'content-security-policy', csp);
  expectSingleHeader(response, 'cross-origin-opener-policy', 'same-origin');
  expectSingleHeader(response, 'cross-origin-embedder-policy', 'require-corp');
  expectSingleHeader(response, 'x-content-type-options', 'nosniff');
}

async function expectedCsp(): Promise<string> {
  const headers = await readFile(resolve(process.cwd(), 'public/_headers'), 'utf8');
  const policy = /^  Content-Security-Policy: (.+)$/m.exec(headers)?.[1];
  expect(policy, 'Source _headers must define a CSP').toBeTruthy();
  return policy!;
}

// ---------------------------------------------------------------------------
// 1. Page Load & Health
// ---------------------------------------------------------------------------

test.describe('Deployment: Page Load', () => {
  test('page loads without application runtime failures', async ({ page }, testInfo) => {
    const runtimeFailures = await collectRuntimeFailures(page);
    const response = await page.goto(DEPLOY_URL);
    await page.waitForLoadState('networkidle');

    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-type']).toMatch(/^text\/html\b/i);
    expect(response?.headers()['cross-origin-opener-policy']).toBe('same-origin');
    expect(response?.headers()['cross-origin-embedder-policy']).toBe('require-corp');
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    const failures = await runtimeFailures();
    await testInfo.attach('runtime-failures', { body: JSON.stringify(failures, null, 2), contentType: 'application/json' });
    expect(failures).toEqual({ pageErrors: [], requestFailures: [], consoleErrors: [], cspViolations: [] });
  });

  test('no failed static resource loads', async ({ page }) => {
    const failed = await getFailedResources(page);
    await page.goto(DEPLOY_URL);
    await page.waitForLoadState('networkidle');

    expect(failed).toEqual([]);
  });

  test('loaded JS and CSS have successful executable responses', async ({ page }) => {
    const responses: Response[] = [];
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.startsWith('/assets/')) {
        responses.push(response);
      }
    });
    await page.goto(DEPLOY_URL);
    await page.waitForLoadState('networkidle');

    const kinds = new Set<string>();
    for (const response of responses) {
      const path = new URL(response.url()).pathname;
      const kind = path.endsWith('.js') ? 'js' : path.endsWith('.css') ? 'css' : null;
      if (!kind) continue;
      await assertExecutableResponse(response, kind, new URL(DEPLOY_URL).origin);
      kinds.add(kind);
    }
    expect(kinds).toEqual(new Set(['js', 'css']));
  });

  test('missing assets are 404 and cannot become immutable HTML', async ({ request }) => {
    for (const extension of ['js', 'css', 'wasm']) {
      const response = await request.get(new URL(`/assets/deploy-missing-289.${extension}`, DEPLOY_URL).href);
      expect(response.status(), extension).toBe(404);
      expect(response.headers()['cache-control'] ?? '', extension).not.toMatch(/immutable/i);
      expect(response.headers()['cross-origin-opener-policy'], extension).toBe('same-origin');
      expect(response.headers()['cross-origin-embedder-policy'], extension).toBe('require-corp');
    }
  });

  test('Pages serves one security and cache policy per document, metadata, and fingerprinted asset',
    async ({ request }) => {
      const csp = await expectedCsp();
      const metadataUrl = new URL('/deployment-state.json', DEPLOY_URL).href;
      const metadataResponse = await request.get(metadataUrl, { maxRedirects: 0, failOnStatusCode: false });
      expect(metadataResponse.status()).toBe(200);
      expect(metadataResponse.headers()['content-type']).toMatch(/^application\/json(?:\s*;|$)/i);
      expectSecurityHeaders(metadataResponse, csp);
      expectSingleHeader(metadataResponse, 'cache-control', REVALIDATION);
      const metadata: unknown = await metadataResponse.json();
      expect(metadata).toEqual(expect.objectContaining({
        schemaVersion: 1,
        sourceSha: expect.stringMatching(SHA),
        treeSha: expect.stringMatching(SHA),
        coreSha: expect.stringMatching(SHA),
        version: expect.any(String),
        branch: expect.any(String),
        sourceDirty: expect.any(Boolean),
        headersSha256: expect.stringMatching(DIGEST),
        files: expect.any(Array),
      }));
      const files = (metadata as { files: { path: string; size: number; sha256: string }[] }).files;
      expect(files.length).toBeGreaterThan(0);
      expect(files.length).toBeLessThanOrEqual(100);
      for (const file of files) {
        expect(file).toEqual({ path: expect.stringMatching(/^[\w.-]+(?:\/[\w.-]+)*$/),
          size: expect.any(Number), sha256: expect.stringMatching(DIGEST) });
        expect(Number.isSafeInteger(file.size) && file.size > 0, file.path).toBe(true);
      }
      const assetFiles = files.filter((file) => FINGERPRINTED_ASSET.test(file.path));
      expect(assetFiles.length).toBeGreaterThan(0);
      expect(new Set(assetFiles.map((file) => file.path)).size).toBe(assetFiles.length);
      const kinds = new Set(assetFiles.map((file) => file.path.split('.').at(-1)));
      expect(kinds).toEqual(new Set(['js', 'css', 'wasm']));
      expect(assetFiles.some((file) => /(?:^|[-.])worker[-.]/.test(basename(file.path))),
        'Deployment inventory has no fingerprinted Worker script').toBe(true);

      for (const path of ['/', '/service-worker.js']) {
        const response = await request.get(new URL(path, DEPLOY_URL).href,
          { maxRedirects: 0, failOnStatusCode: false });
        expect(response.status(), path).toBe(200);
        expect(response.headers()['content-type'], path).toMatch(
          path === '/' ? /^text\/html(?:\s*;|$)/i : /^(?:text|application)\/javascript(?:\s*;|$)/i,
        );
        expectSecurityHeaders(response, csp);
        expectSingleHeader(response, 'cache-control', REVALIDATION);
      }

      for (const file of assetFiles) {
        const url = new URL(`/${file.path}`, DEPLOY_URL).href;
        const response = await request.get(url, { maxRedirects: 0, failOnStatusCode: false });
        const kind = file.path.endsWith('.wasm') ? 'wasm' : file.path.endsWith('.css') ? 'css' : 'js';
        assertExecutableBody(kind, response.status(), response.headers()['content-type'] ?? null,
          await response.body());
        expectSecurityHeaders(response, csp);
        expectSingleHeader(response, 'cache-control', IMMUTABLE);
        const etag = response.headers().etag;
        if (!etag) throw new Error(`${file.path} has no ETag`);
        expect(etag, `${file.path} ETag`).toMatch(/^(?:W\/)?"[^\"]+"$/);
        const revalidated = await request.get(url, {
          headers: { 'If-None-Match': etag }, maxRedirects: 0, failOnStatusCode: false,
        });
        expect(revalidated.status(), `${file.path} conditional status`).toBe(304);
        expect(revalidated.headers().etag, `${file.path} conditional ETag`).toBe(etag);
        expect(await revalidated.body(), `${file.path} conditional body`).toHaveLength(0);
        expectSecurityHeaders(revalidated, csp);
        expectSingleHeader(revalidated, 'cache-control', IMMUTABLE);
      }
    });

  test('validator rejects mislabeled HTML and invalid WASM bytes', () => {
    const html = new TextEncoder().encode('<!doctype html><title>fallback</title>');
    expect(() => assertExecutableBody('js', 200, 'text/javascript', html)).toThrow();
    expect(() => assertExecutableBody('wasm', 200, 'application/wasm', html)).toThrow();
    expect(() => assertExecutableBody('js', 404, 'text/javascript', new TextEncoder().encode('export {}'))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Visual: Initial State
// ---------------------------------------------------------------------------

test.describe('Deployment: Visual — Initial State', () => {
  test('initial page renders correctly', async ({ page }) => {
    await page.goto(DEPLOY_URL);
    await page.waitForLoadState('domcontentloaded');

    // Capture initial state screenshot
    await captureScreenshot(page, 'deploy-initial-state');

    // Verify key elements are visible
    await expect(page.locator('#root')).toBeVisible();
    await expect(page.locator('#main-content')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Select video file for conversion' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select a video to start conversion' })).toBeDisabled();
    await expect(page.locator('h1')).toHaveText('dropconvert');
  });

  test('format selector options are visible', async ({ page }) => {
    await page.goto(DEPLOY_URL);

    // Verify format options
    const format = page.getByRole('radiogroup', { name: 'Output Format' });
    await expect(format.getByRole('radio', { name: /^GIF/ })).toBeVisible();
    await expect(format.getByRole('radio', { name: /^WebP/ })).toBeVisible();

    // Verify quality options
    const quality = page.getByRole('radiogroup', { name: 'Quality Preset' });
    await expect(quality.getByRole('radio', { name: /^Low/ })).toBeVisible();
    await expect(quality.getByRole('radio', { name: /^Medium/ })).toBeVisible();
    await expect(quality.getByRole('radio', { name: /^High/ })).toBeVisible();

    // Verify scale options
    const scale = page.getByRole('radiogroup', { name: 'Output Scale' });
    await expect(scale.getByRole('radio', { name: /^50%/ })).toBeVisible();
    await expect(scale.getByRole('radio', { name: /^75%/ })).toBeVisible();
    await expect(scale.getByRole('radio', { name: /^100%/ })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 3. Visual: File Upload State
// ---------------------------------------------------------------------------

test.describe('Deployment: Visual — File Upload', () => {
  test('convert button enables after file upload', async ({ page }) => {
    await page.goto(DEPLOY_URL);

    await uploadTestVideo(page);

    // Capture file uploaded state
    await captureScreenshot(page, 'deploy-file-uploaded');

    // Verify convert button is enabled
    const convertBtn = page.getByRole('button', { name: 'Convert', exact: true });
    await expect(convertBtn).toBeEnabled();

    // Verify metadata is displayed
    await expect(page.getByText('Input Video', { exact: true }).locator('..')).toContainText(
      basename(TEST_VIDEO_PATH)
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Visual: Progress UI During Conversion
// ---------------------------------------------------------------------------

test.describe('Deployment: Visual — Progress UI', () => {
  test('GIF conversion starts a module worker and downloads valid bytes', async ({ page }, testInfo) => {
    const runtimeFailures = await collectRuntimeFailures(page);
    const workers: string[] = [];
    page.on('worker', (worker) => workers.push(worker.url()));
    await page.goto(DEPLOY_URL);
    await uploadTestVideo(page);
    await startConversion(page);

    const progressBar = page.getByRole('progressbar').first();
    const result = resultSection(page);
    await expect
      .poll(
        async () =>
          (await progressBar.isVisible()) || (await result.isVisible()),
        { timeout: 30_000 },
      )
      .toBe(true);

    // Capture progress UI during conversion
    await captureScreenshot(page, 'deploy-progress-active');

    if (await progressBar.isVisible()) {
      // Verify progress bar has valid value
      const progressValue = await progressBar.getAttribute('aria-valuenow');
      if (progressValue !== null) {
        const progressNum = Number(progressValue);
        expect(progressNum).toBeGreaterThanOrEqual(0);
        expect(progressNum).toBeLessThanOrEqual(100);
      }
    }

    await expect(result).toBeVisible({ timeout: 120_000 });
    await captureScreenshot(page, 'deploy-conversion-complete');
    await expect(downloadLink(page)).toBeVisible();
    expect(workers.length, 'No module worker was started').toBeGreaterThan(0);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadLink(page).click(),
    ]);
    const bytes = await readFile(await download.path());
    expect(bytes.subarray(0, 6).toString('ascii')).toMatch(/^GIF8[79]a$/);
    await testInfo.attach('first-gif-traffic', {
      body: JSON.stringify(await page.evaluate(() => performance.getEntriesByType('resource')
        .filter((entry) => entry instanceof PerformanceResourceTiming)
        .map((entry) => ({ name: new URL(entry.name).pathname, transferSize: entry.transferSize }))), null, 2),
      contentType: 'application/json',
    });
    expect(await runtimeFailures()).toEqual({ pageErrors: [], requestFailures: [], consoleErrors: [], cspViolations: [] });
  });

  test('WebP conversion uses real WASM fallback and downloads valid bytes', async ({ page }, testInfo) => {
    const runtimeFailures = await collectRuntimeFailures(page);
    await page.addInitScript(() => {
      Object.defineProperty(OffscreenCanvas.prototype, 'convertToBlob', {
        configurable: true, value: undefined,
      });
      Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        value: class UnavailableWorker {
          constructor() { throw new DOMException('Force WASM fallback', 'NotSupportedError'); }
        },
      });
    });
    const wasmResponses: Response[] = [];
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.endsWith('.wasm')) wasmResponses.push(response);
    });
    await page.goto(DEPLOY_URL);
    await uploadTestVideo(page);
    await page.getByRole('radiogroup', { name: 'Output Format' })
      .getByRole('radio', { name: /^WebP/ }).check();
    await startConversion(page);
    await expect(resultSection(page)).toBeVisible({ timeout: 120_000 });
    expect(wasmResponses.length, 'WebP fallback loaded no WASM response').toBeGreaterThan(0);
    for (const response of wasmResponses) {
      await assertExecutableResponse(response, 'wasm', new URL(DEPLOY_URL).origin);
      const bytes = await response.body();
      await page.evaluate(async (value) => WebAssembly.compile(new Uint8Array(value)), [...bytes]);
    }
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadLink(page).click(),
    ]);
    const bytes = await readFile(await download.path());
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP');
    await testInfo.attach('first-webp-traffic', {
      body: JSON.stringify(await page.evaluate(() => performance.getEntriesByType('resource')
        .filter((entry) => entry instanceof PerformanceResourceTiming)
        .map((entry) => ({ name: new URL(entry.name).pathname, transferSize: entry.transferSize }))), null, 2),
      contentType: 'application/json',
    });
    expect(await runtimeFailures()).toEqual({ pageErrors: [], requestFailures: [], consoleErrors: [], cspViolations: [] });
  });
});

// ---------------------------------------------------------------------------
// 5. Visual: Result Section
// ---------------------------------------------------------------------------

test.describe('Deployment: Visual — Result Section', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(DEPLOY_URL);
    await page.waitForLoadState('domcontentloaded');
  });

  test('result section shows correct stats after conversion', async ({ page }) => {
    await uploadTestVideo(page);
    await startConversion(page);

    // Wait for completion — GIF conversion of 1920x1080 can take 30-90s
    const result = resultSection(page);
    await expect(result).toBeVisible({ timeout: 180_000 });

    // Capture final result state
    await captureScreenshot(page, 'deploy-result-section');

    // Verify result stats are present
    const summary = page.getByRole('region', { name: /^GIF conversion results:/ });
    const outputSize = summary.getByText('Output size', { exact: true }).locator('..').locator('dd');
    const format = summary.getByText('Format', { exact: true }).locator('..').locator('dd');
    const details = page.getByRole('region', { name: 'Result details' });

    await expect(details).toContainText(/\d+(?:\.\d+)?\s*(?:B|KB|MB)/);
    await expect(outputSize).toBeVisible();
    await expect(format).toHaveText('GIF');

    // Verify output size is reasonable (not empty)
    const outputSizeText = await outputSize.textContent();
    expect(outputSizeText).toBeTruthy();
    expect(outputSizeText!.length).toBeGreaterThan(0);

    // Verify preview image is loaded
    const showPreview = page.getByRole('button', { name: 'Show animated preview' });
    if (await showPreview.isVisible()) await showPreview.click();
    const resultImage = page.getByRole('img', { name: /^GIF animated preview:/ });
    await expect(resultImage).toBeVisible();
    const naturalWidth = await resultImage.evaluate((el) => (el as HTMLImageElement).naturalWidth);
    expect(naturalWidth).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Cross-environment: Dev vs Deploy comparison
// ---------------------------------------------------------------------------

test.describe('Deployment: Production controls', () => {
  test('app exposes its maintained controls and accessible names', async ({ page }) => {
    await page.goto(DEPLOY_URL);
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('#root')).toBeVisible();
    await expect(page.locator('#main-content')).toBeVisible();
    await expect(page.locator('#file-upload')).toBeAttached();
    await expect(page.getByRole('combobox', { name: 'Select language' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select a video to start conversion' })).toBeDisabled();
    await expect(page.getByRole('radiogroup', { name: 'Output Format' })
      .getByRole('radio', { name: /^GIF/ })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Output Format' })
      .getByRole('radio', { name: /^WebP/ })).toBeVisible();
  });
});
