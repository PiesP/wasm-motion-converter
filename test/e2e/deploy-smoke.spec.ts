// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP
//
// Deployment smoke test — runs against the deployed production URL.
// Verifies core functionality works in the deployed environment.
//
// Run with:
//   vp exec playwright test test/e2e/deploy-smoke.spec.ts --reporter=list
//
// Environment variables:
//   DEPLOY_URL — the deployed URL to test (default: https://wasm-motion-converter.pages.dev)

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import {
  type APIResponse,
  expect,
  type Page,
  request as playwrightRequest,
  type Response,
  test,
} from '@playwright/test';

import {
  isExecutableMediaType,
  RETIRED_WEBP_DELIVERY_FILES,
  RETIRED_REQUEST_MODES,
} from '../../scripts/test/retired-webp-assets';
import { hasLegacyWebpInRetiredBuild } from '../../scripts/test/retired-webp-worker';
import { parseDeploymentState } from '../../scripts/test/verify-deployment';
import {
  forceMainSoftwareWebp,
  observeSoftwareWebp,
  softwareWebpInventory,
  verifySoftwareWebp,
} from '../../validation/windows/offline-recovery';
import { conditionalEtagObservation } from './lib/conditional-etag';
import { assertExecutableBody, assertExecutableResponse } from './lib/deployment-responses';
import { firstConversionTraffic } from './lib/first-conversion-traffic';

const DEPLOY_URL = process.env.DEPLOY_URL || 'https://wasm-motion-converter.pages.dev';
const TEST_VIDEO_PATH =
  process.env.DEPLOY_TEST_VIDEO || resolve(process.cwd(), 'public/test-video-ci-h264.mp4');
const REVALIDATION = 'public, max-age=0, must-revalidate';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const FINGERPRINTED_ASSET = /^assets\/[\w.-]+[.-][\w-]{8}\.(js|css|wasm)$/;
const REQUIRE_OWNED_ONLY = process.env.DEPLOY_REQUIRE_OWNED_VP8_ONLY === '1';

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

async function collectRuntimeFailures(
  page: Page
): Promise<() => Promise<Record<string, string[]>>> {
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const consoleErrors = await getConsoleErrors(page);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    if (request.url().startsWith('blob:') && request.failure()?.errorText === 'net::ERR_ABORTED')
      return;
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
    cspViolations: await page.evaluate(
      () =>
        (globalThis as typeof globalThis & { __deployCspViolations?: string[] })
          .__deployCspViolations ?? []
    ),
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
  const modalProceed = page.getByRole('button', {
    name: 'Proceed with conversion despite warnings',
  });
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

function expectHeader(
  url: string,
  headers: readonly { name: string; value: string }[],
  name: string,
  value: string
): void {
  const values = headers
    .filter((header) => header.name.toLowerCase() === name)
    .map((header) => header.value);
  expect(values, `${url} ${name} values`).toEqual([value]);
}

function expectSingleHeader(response: APIResponse, name: string, value: string): void {
  expectHeader(response.url(), response.headersArray(), name, value);
}

async function expectSecurityHeaders(response: APIResponse | Response, csp: string): Promise<void> {
  const headers = await response.headersArray();
  const url = response.url();
  expectHeader(url, headers, 'content-security-policy', csp);
  expectHeader(url, headers, 'cross-origin-opener-policy', 'same-origin');
  expectHeader(url, headers, 'cross-origin-embedder-policy', 'require-corp');
  expectHeader(url, headers, 'x-content-type-options', 'nosniff');
}

async function expectedCsp(headersSha256: string): Promise<string> {
  const path = REQUIRE_OWNED_ONLY
    ? resolve(process.env.DEPLOY_DIST || 'dist', '_headers')
    : resolve('public/_headers');
  const headers = await readFile(path);
  if (REQUIRE_OWNED_ONLY)
    expect(createHash('sha256').update(headers).digest('hex'), 'Frozen CSP rules').toBe(
      headersSha256
    );
  const policy = /^ {2}Content-Security-Policy: (.+)$/m.exec(headers.toString('utf8'))?.[1];
  expect(policy, 'Source _headers must define a CSP').toBeTruthy();
  return policy!;
}

async function readVerifiedDeployment(response: APIResponse) {
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^application\/json(?:\s*;|$)/i);
  const bytes = await response.body();
  expect(bytes.byteLength).toBeLessThanOrEqual(128_000);
  const deployed = parseDeploymentState(JSON.parse(bytes.toString('utf8')));
  const expectedSource = process.env.EXPECTED_SOURCE_SHA;
  if (expectedSource || REQUIRE_OWNED_ONLY) {
    const dist = process.env.DEPLOY_DIST || 'dist';
    const expectedBytes = await readFile(resolve(dist, 'deployment-state.json'));
    const expected = parseDeploymentState(JSON.parse(expectedBytes.toString('utf8')));
    if (REQUIRE_OWNED_ONLY) {
      expect(expectedSource, 'Final smoke requires an explicit source SHA').toMatch(SHA);
      expect(process.env.DEPLOY_DIST, 'Final smoke requires a local build artifact').toBeTruthy();
      expect(
        bytes.equals(expectedBytes),
        'Served deployment metadata differs from the artifact'
      ).toBe(true);
    }
    if (expectedSource) expect(expected.sourceSha).toBe(expectedSource);
    expect(deployed).toEqual(expected);
  }
  return { deployed, manifestSha256: createHash('sha256').update(bytes).digest('hex') };
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
    await testInfo.attach('runtime-failures', {
      body: JSON.stringify(failures, null, 2),
      contentType: 'application/json',
    });
    expect(failures).toEqual({
      pageErrors: [],
      requestFailures: [],
      consoleErrors: [],
      cspViolations: [],
    });
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
      const response = await request.get(
        new URL(`/assets/deploy-missing-289.${extension}`, DEPLOY_URL).href
      );
      expect(response.status(), extension).toBe(404);
      expect(response.headers()['cache-control'] ?? '', extension).not.toMatch(/immutable/i);
      expect(response.headers()['cross-origin-opener-policy'], extension).toBe('same-origin');
      expect(response.headers()['cross-origin-embedder-policy'], extension).toBe('require-corp');
    }
  });

  test('Pages serves one security and cache policy per document, metadata, and fingerprinted asset', async ({
    request,
  }, testInfo) => {
    const metadataUrl = new URL('/deployment-state.json', DEPLOY_URL).href;
    const metadataResponse = await request.get(metadataUrl, {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(metadataResponse.status()).toBe(200);
    expect(metadataResponse.headers()['content-type']).toMatch(/^application\/json(?:\s*;|$)/i);
    const { deployed: metadata } = await readVerifiedDeployment(metadataResponse);
    const csp = await expectedCsp(metadata.headersSha256);
    await expectSecurityHeaders(metadataResponse, csp);
    expectSingleHeader(metadataResponse, 'cache-control', REVALIDATION);
    expect(metadata).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        sourceSha: expect.stringMatching(SHA),
        treeSha: expect.stringMatching(SHA),
        coreSha: expect.stringMatching(SHA),
        version: expect.any(String),
        branch: expect.any(String),
        sourceDirty: expect.any(Boolean),
        headersSha256: expect.stringMatching(DIGEST),
        files: expect.any(Array),
      })
    );
    const files = (metadata as { files: { path: string; size: number; sha256: string }[] }).files;
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeLessThanOrEqual(100);
    for (const file of files) {
      expect(file).toEqual({
        path: expect.stringMatching(/^[\w.-]+(?:\/[\w.-]+)*$/),
        size: expect.any(Number),
        sha256: expect.stringMatching(DIGEST),
      });
      expect(Number.isSafeInteger(file.size) && file.size > 0, file.path).toBe(true);
    }
    const assetFiles = files.filter((file) => FINGERPRINTED_ASSET.test(file.path));
    if (REQUIRE_OWNED_ONLY) {
      const retiredUrls = [];
      const ordinary = await playwrightRequest.newContext();
      try {
        for (const mode of RETIRED_REQUEST_MODES) {
          const context = mode === 'ordinary' ? ordinary : request;
          for (const prior of RETIRED_WEBP_DELIVERY_FILES) {
            const url = new URL(`/${prior.path}`, DEPLOY_URL).href;
            const response = await context.get(url, {
              maxRedirects: 0,
              failOnStatusCode: false,
              ...(mode === 'revalidated'
                ? { headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } }
                : {}),
            });
            const cacheControl = response.headers()['cache-control'] ?? '';
            const contentType = response.headers()['content-type'] ?? '';
            const bytes = await response.body();
            const responseSha256 = createHash('sha256').update(bytes).digest('hex');
            const label = `${mode} ${prior.path}`;
            expect(response.status(), label).toBe(404);
            expect(cacheControl, label).not.toMatch(/\bimmutable\b/i);
            expect(isExecutableMediaType(contentType), label).toBe(false);
            expect(responseSha256, label).not.toBe(prior.sha256);
            expect(bytes.subarray(0, 4).toString('hex'), label).not.toBe('0061736d');
            retiredUrls.push({
              mode,
              url,
              priorSha256: prior.sha256,
              responseSha256,
              status: response.status(),
              cacheControl,
              contentType,
            });
          }
        }
      } finally {
        await ordinary.dispose();
      }
      await testInfo.attach('retired-webp-urls', {
        body: JSON.stringify(retiredUrls),
        contentType: 'application/json',
      });
      const inventory = softwareWebpInventory(files);
      expect(inventory.ownedOnly, JSON.stringify(inventory)).toBe(true);
      for (const file of files.filter(({ path }) => /\.[cm]?js$/.test(path))) {
        const { path } = file;
        const response = await request.get(new URL(`/${path}`, DEPLOY_URL).href, {
          maxRedirects: 0,
        });
        const bytes = await response.body();
        expect(bytes.byteLength, `${path} served size`).toBe(file.size);
        expect(createHash('sha256').update(bytes).digest('hex'), `${path} served SHA-256`).toBe(
          file.sha256
        );
        assertExecutableBody(
          'js',
          response.status(),
          response.headers()['content-type'] ?? null,
          bytes
        );
        expect(
          hasLegacyWebpInRetiredBuild(path, bytes),
          `Legacy WebP loader in deployed executable ${path}`
        ).toBe(false);
      }
    }
    expect(assetFiles.length).toBeGreaterThan(0);
    expect(new Set(assetFiles.map((file) => file.path)).size).toBe(assetFiles.length);
    const kinds = new Set(assetFiles.map((file) => file.path.split('.').at(-1)));
    expect(kinds).toEqual(new Set(['js', 'css', 'wasm']));
    expect(
      assetFiles.some((file) => /(?:^|[-.])worker[-.]/.test(basename(file.path))),
      'Deployment inventory has no fingerprinted Worker script'
    ).toBe(true);

    for (const path of ['/', '/service-worker.js']) {
      const response = await request.get(new URL(path, DEPLOY_URL).href, {
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      expect(response.status(), path).toBe(200);
      expect(response.headers()['content-type'], path).toMatch(
        path === '/' ? /^text\/html(?:\s*;|$)/i : /^(?:text|application)\/javascript(?:\s*;|$)/i
      );
      await expectSecurityHeaders(response, csp);
      expectSingleHeader(response, 'cache-control', REVALIDATION);
    }

    const conditionalObservations = [];
    for (const file of assetFiles) {
      const url = new URL(`/${file.path}`, DEPLOY_URL).href;
      const response = await request.get(url, { maxRedirects: 0, failOnStatusCode: false });
      const kind = file.path.endsWith('.wasm') ? 'wasm' : file.path.endsWith('.css') ? 'css' : 'js';
      const body = await response.body();
      expect(body.byteLength, `${file.path} served size`).toBe(file.size);
      expect(createHash('sha256').update(body).digest('hex'), `${file.path} served SHA-256`).toBe(
        file.sha256
      );
      assertExecutableBody(
        kind,
        response.status(),
        response.headers()['content-type'] ?? null,
        body
      );
      await expectSecurityHeaders(response, csp);
      expectSingleHeader(response, 'cache-control', IMMUTABLE);
      const etag = response.headers().etag;
      if (!etag) throw new Error(`${file.path} has no ETag`);
      expect(etag, `${file.path} ETag`).toMatch(/^(?:W\/)?"[^"]+"$/);
      const revalidated = await request.get(url, {
        headers: { 'If-None-Match': etag },
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      expect(revalidated.status(), `${file.path} conditional status`).toBe(304);
      const conditionalEtag = revalidated.headers().etag;
      // RFC 9110 15.4.5 requires the 200 ETag on this 304. Pages/Wrangler
      // omissions are an explicitly reported integration exception (#289/#292).
      const etagObservation = conditionalEtagObservation(
        url,
        etag,
        conditionalEtag,
        process.env.PLAYWRIGHT_TEST_PROFILE === 'deploy'
      );
      expect(await revalidated.body(), `${file.path} conditional body`).toHaveLength(0);
      await expectSecurityHeaders(revalidated, csp);
      expectSingleHeader(revalidated, 'cache-control', IMMUTABLE);
      const unmatched = await request.get(url, {
        headers: { 'If-None-Match': '"wmc-unmatched-validator"' },
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      expect(unmatched.status(), `${file.path} unmatched conditional status`).toBe(200);
      expect(await unmatched.body(), `${file.path} unmatched conditional bytes`).toEqual(body);
      expect(unmatched.headers().etag, `${file.path} unmatched conditional ETag`).toBe(etag);
      await expectSecurityHeaders(unmatched, csp);
      expectSingleHeader(unmatched, 'cache-control', IMMUTABLE);
      conditionalObservations.push({
        path: file.path,
        etag,
        ...etagObservation,
        status: revalidated.status(),
        unmatchedStatus: unmatched.status(),
      });
    }
    await testInfo.attach('conditional-header-observations', {
      body: JSON.stringify(conditionalObservations, null, 2),
      contentType: 'application/json',
    });
  });

  test('validator rejects mislabeled HTML and invalid WASM bytes', () => {
    const html = new TextEncoder().encode('<!doctype html><title>fallback</title>');
    expect(() => assertExecutableBody('js', 200, 'text/javascript', html)).toThrow();
    expect(() => assertExecutableBody('wasm', 200, 'application/wasm', html)).toThrow();
    expect(() =>
      assertExecutableBody('js', 404, 'text/javascript', new TextEncoder().encode('export {}'))
    ).toThrow();
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
    await expect(
      page.getByRole('group', { name: 'Select video file for conversion' })
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Select a video to start conversion' })
    ).toBeDisabled();
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
  test('GIF conversion starts a module worker and downloads valid bytes', async ({
    page,
  }, testInfo) => {
    const runtimeFailures = await collectRuntimeFailures(page);
    const workers: string[] = [];
    page.on('worker', (worker) => workers.push(worker.url()));
    const traffic = firstConversionTraffic(page, 'normal-gif');
    await page.goto(DEPLOY_URL);
    await page.waitForLoadState('networkidle');
    await traffic.markInitial();
    await uploadTestVideo(page);
    await startConversion(page);

    const progressBar = page.getByRole('progressbar').first();
    const result = resultSection(page);
    await expect
      .poll(async () => (await progressBar.isVisible()) || (await result.isVisible()), {
        timeout: 30_000,
      })
      .toBe(true);

    // Capture progress UI during conversion
    await captureScreenshot(page, 'deploy-progress-active');

    const progressSample = await progressBar.evaluateAll((elements) => {
      const element = elements.find((value) => value.getClientRects().length > 0);
      return element ? { value: element.getAttribute('aria-valuenow') } : null;
    });
    if (progressSample) {
      // Conversion can finish between observations; sample the transient bar
      // atomically instead of waiting for a disappeared element to return.
      const progressValue = progressSample.value;
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
      body: JSON.stringify(await traffic.observation(bytes.length)),
      contentType: 'application/json',
    });
    expect(await runtimeFailures()).toEqual({
      pageErrors: [],
      requestFailures: [],
      consoleErrors: [],
      cspViolations: [],
    });
  });

  test('Forced WebP downloads a decodable animation from the inventoried software encoder', async ({
    page,
    request,
  }, testInfo) => {
    const metadata = await request.get(new URL('/deployment-state.json', DEPLOY_URL).href, {
      maxRedirects: 0,
    });
    const { deployed, manifestSha256 } = await readVerifiedDeployment(metadata);
    const inventory = softwareWebpInventory(deployed.files);
    if (REQUIRE_OWNED_ONLY) expect(inventory.ownedOnly, JSON.stringify(inventory)).toBe(true);
    const csp = REQUIRE_OWNED_ONLY ? await expectedCsp(deployed.headersSha256) : null;
    const runtimeFailures = await collectRuntimeFailures(page);
    await forceMainSoftwareWebp(page);
    const traffic = firstConversionTraffic(page, 'forced-webp-wasm');
    const softwareTraffic = observeSoftwareWebp(page, new URL(DEPLOY_URL).origin);
    const documentResponse = await page.goto(DEPLOY_URL);
    await page.waitForLoadState('networkidle');
    await traffic.markInitial();
    if (csp) {
      const index = deployed.files.find(({ path }) => path === 'index.html');
      if (!index || !documentResponse) throw new Error('No inventoried startup document');
      expect(documentResponse.status()).toBe(200);
      expect(documentResponse.fromServiceWorker()).toBe(false);
      expect(documentResponse.request().redirectedFrom()).toBeNull();
      await expectSecurityHeaders(documentResponse, csp);
      expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
      expect(
        createHash('sha256')
          .update(await documentResponse.body())
          .digest('hex')
      ).toBe(index.sha256);
      expect(softwareTraffic.requests).not.toContain(`/${inventory.asset.path}`);
    }
    await uploadTestVideo(page);
    await page
      .getByRole('radiogroup', { name: 'Output Format' })
      .getByRole('radio', { name: /^WebP/ })
      .check();
    await startConversion(page);
    await expect(resultSection(page)).toBeVisible({ timeout: 120_000 });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadLink(page).click(),
    ]);
    const bytes = await readFile(await download.path());
    const software = await verifySoftwareWebp(page, bytes, inventory, softwareTraffic);
    if (csp) {
      for (const response of softwareTraffic.responses.filter(
        (entry) => new URL(entry.url()).pathname === `/${inventory.asset.path}`
      )) {
        await expectSecurityHeaders(response, csp);
      }
    }
    softwareTraffic.stop();
    const after = await request.get(new URL('/deployment-state.json', DEPLOY_URL).href, {
      maxRedirects: 0,
    });
    expect((await readVerifiedDeployment(after)).manifestSha256).toBe(manifestSha256);
    await testInfo.attach('forced-webp-encoder', {
      body: JSON.stringify(
        {
          sourceSha: deployed.sourceSha,
          treeSha: deployed.treeSha,
          coreSha: deployed.coreSha,
          manifestSha256,
          ownedOnlyInventory: inventory.ownedOnly,
          legacyExecutables: inventory.legacyExecutables,
          unexpectedWasm: inventory.unexpectedWasm,
          software,
        },
        null,
        2
      ),
      contentType: 'application/json',
    });
    await testInfo.attach('first-webp-traffic', {
      body: JSON.stringify(await traffic.observation(bytes.length)),
      contentType: 'application/json',
    });
    expect(await runtimeFailures()).toEqual({
      pageErrors: [],
      requestFailures: [],
      consoleErrors: [],
      cspViolations: [],
    });
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
    const outputSize = summary
      .getByText('Output size', { exact: true })
      .locator('..')
      .locator('dd');
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
    await expect(
      page.getByRole('button', { name: 'Select a video to start conversion' })
    ).toBeDisabled();
    await expect(
      page.getByRole('radiogroup', { name: 'Output Format' }).getByRole('radio', { name: /^GIF/ })
    ).toBeVisible();
    await expect(
      page.getByRole('radiogroup', { name: 'Output Format' }).getByRole('radio', { name: /^WebP/ })
    ).toBeVisible();
  });
});
