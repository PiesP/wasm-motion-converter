// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const PROFILE_ID = 'wmc-media';
const SMALL_FIXTURE = 'public/test-video-ci-h264.mp4';
const CANCELLATION_FIXTURE = 'public/test-video-ci-high-motion-120fps.mp4';
const CONVERSION_TIMEOUT_MS = 120_000;
const CANCELLATION_TIMEOUT_MS = 180_000;

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.xml', 'application/xml; charset=utf-8'],
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isWithin(parent, child) {
  const childRelative = relative(parent, child);
  return (
    childRelative === '' ||
    (!childRelative.startsWith(`..${sep}`) &&
      childRelative !== '..' &&
      !isAbsolute(childRelative))
  );
}

function parseCatchAllHeaders(contents) {
  const headers = new Map();
  let inCatchAll = false;

  for (const line of contents.split(/\r?\n/)) {
    if (!/^\s/.test(line)) {
      const pattern = line.trim();
      inCatchAll = pattern === '/*';
      continue;
    }
    if (!inCatchAll) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf(':');
    assert(separatorIndex > 0, `Invalid catch-all header in dist/_headers: ${trimmed}`);
    const name = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    assert(!/[\r\n]/.test(name) && !/[\r\n]/.test(value), 'Unsafe response header');
    headers.set(name, value);
  }

  assert(headers.has('Content-Security-Policy'), 'dist/_headers is missing its catch-all CSP');
  assert.equal(headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  assert.equal(headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
  return headers;
}

function decodeRequestPath(requestUrl) {
  const url = new URL(requestUrl ?? '/', 'http://127.0.0.1');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    const error = new Error('Malformed URL encoding');
    error.statusCode = 400;
    throw error;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) {
    const error = new Error('Unsafe request path');
    error.statusCode = 400;
    throw error;
  }
  const segments = pathname.split('/').filter(Boolean);
  if (
    segments.some(
      (segment) => segment === '.' || segment === '..' || /[:*?"<>|]/.test(segment)
    )
  ) {
    const error = new Error('Unsafe request path');
    error.statusCode = 400;
    throw error;
  }
  return segments.length === 0 ? 'index.html' : segments.join('/');
}

async function resolveStaticFile(distRoot, requestUrl) {
  const candidate = resolve(distRoot, decodeRequestPath(requestUrl));
  if (!isWithin(distRoot, candidate)) {
    const error = new Error('Request escaped the distribution root');
    error.statusCode = 400;
    throw error;
  }

  const candidateStat = await stat(candidate);
  const fileCandidate = candidateStat.isDirectory() ? join(candidate, 'index.html') : candidate;
  const resolvedFile = await realpath(fileCandidate);
  if (!isWithin(distRoot, resolvedFile)) {
    const error = new Error('Request resolved outside the distribution root');
    error.statusCode = 400;
    throw error;
  }
  const fileStat = await stat(resolvedFile);
  if (!fileStat.isFile()) {
    const error = new Error('Not a file');
    error.statusCode = 404;
    throw error;
  }
  return resolvedFile;
}

async function startStaticServer(bundleRoot) {
  const distRoot = await realpath(resolve(bundleRoot, 'dist'));
  assert(isWithin(bundleRoot, distRoot), 'Bundled dist asset resolved outside the bundle root');
  assert((await stat(distRoot)).isDirectory(), 'Bundled dist asset is not a directory');
  const headersFile = await realpath(join(distRoot, '_headers'));
  assert(isWithin(distRoot, headersFile), 'dist/_headers resolved outside the distribution root');
  const catchAllHeaders = parseCatchAllHeaders(await readFile(headersFile, 'utf8'));

  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' });
        response.end();
        return;
      }

      // Headed stable browsers request this optional icon even without an HTML link.
      // The production app has no favicon; keep the fixture host's response quiet.
      if (request.url === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      }
      const file = await resolveStaticFile(distRoot, request.url);
      const bytes = await readFile(file);
      for (const [name, value] of catchAllHeaders) response.setHeader(name, value);
      response.setHeader(
        'Content-Type',
        MIME_TYPES.get(extname(file).toLowerCase()) ?? 'application/octet-stream'
      );
      response.setHeader('Content-Length', String(bytes.byteLength));
      response.setHeader(
        'Cache-Control',
        request.url?.startsWith('/assets/') || extname(file).toLowerCase() === '.wasm'
          ? 'public, max-age=31536000, immutable'
          : 'no-cache'
      );
      response.writeHead(200);
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode)
        ? error.statusCode
        : error?.code === 'ENOENT'
          ? 404
          : 500;
      response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(statusCode === 404 ? 'Not found' : 'Request rejected');
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'Local acceptance server has no address');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server) {
  server.closeIdleConnections?.();
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function validateBundleFile(bundleRoot, relativePath) {
  const rootReal = await realpath(bundleRoot);
  const fileReal = await realpath(resolve(rootReal, relativePath));
  assert(isWithin(rootReal, fileReal), `Bundled asset escaped its root: ${relativePath}`);
  const fileStat = await stat(fileReal);
  assert(fileStat.isFile() && fileStat.size > 0, `Bundled asset is empty or not a file: ${relativePath}`);
  return fileReal;
}

async function loadApplication(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  assert(response, 'Application navigation did not return an HTTP response');
  assert.equal(response.status(), 200, `Application returned HTTP ${response.status()}`);
  const responseHeaders = await response.allHeaders();
  assert.equal(responseHeaders['cross-origin-opener-policy'], 'same-origin');
  assert.equal(responseHeaders['cross-origin-embedder-policy'], 'require-corp');
  assert(responseHeaders['content-security-policy'], 'Application response did not include CSP');
  await page.locator('[data-testid="app"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('[data-testid="dropzone"]').waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal(
    await page.locator('[data-testid="environment-warning"]').count(),
    0,
    'Stable browser lacks required WebCodecs or WebAssembly support'
  );
  return {
    httpStatus: response.status(),
    crossOriginIsolated: await page.evaluate(() => globalThis.crossOriginIsolated === true),
    csp: true,
  };
}

async function selectFixture(page, filePath) {
  const input = page.locator('[data-testid="file-input"]');
  await input.setInputFiles(filePath);
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="convert-button"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 30_000 });
  const metadata = page.locator('[data-testid="video-metadata"]');
  await metadata.waitFor({ state: 'visible', timeout: 30_000 });
  assert(
    (await metadata.textContent())?.includes(basename(filePath)),
    'Selected fixture name is absent from metadata'
  );
}

async function chooseOption(page, group, value) {
  const option = page.locator(`[data-testid="option-${group}-${value}"]`);
  await option.click();
  assert.equal(await option.locator('input').isChecked(), true, `${group}=${value} was not selected`);
}

async function proceedIfPrompted(page) {
  const confirmation = page.locator('[data-testid="modal-confirm-button"]');
  if (await confirmation.isVisible()) await confirmation.click();
}

async function waitForConversionOutcome(page, timeout) {
  await page.waitForFunction(() => {
    const visible = (element) => element instanceof HTMLElement && element.getClientRects().length > 0;
    return (
      visible(document.querySelector('[data-testid="result-section"]')) ||
      visible(document.querySelector('[data-testid="error-display"]'))
    );
  }, undefined, { timeout });
  const error = page.locator('[data-testid="error-display"]');
  const errorVisible = await error.isVisible();
  const errorText = errorVisible ? (await error.textContent())?.trim() : null;
  assert.equal(
    errorVisible,
    false,
    `Conversion failed: ${errorText ?? 'unknown error'}`
  );
  await page.locator('[data-testid="result-section"]').waitFor({ state: 'visible' });
}

async function readDownload(download) {
  const stream = await download.createReadStream();
  assert(stream, 'Browser download did not expose a readable stream');
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function validateOutput(bytes, format) {
  assert(bytes.byteLength > 100, `${format.toUpperCase()} output is unexpectedly small`);
  if (format === 'gif') {
    assert(
      ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')),
      'GIF output has invalid magic bytes'
    );
    assert.equal(bytes.at(-1), 0x3b, 'GIF output is missing its trailer');
    assert.equal(bytes.readUInt16LE(6), 80, 'GIF output width is not 80');
    assert.equal(bytes.readUInt16LE(8), 45, 'GIF output height is not 45');
    return;
  }
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF', 'WebP output has invalid RIFF magic');
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP', 'WebP output has invalid WEBP magic');
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.byteLength, 'WebP RIFF size does not match its download');
}

async function recordScreenshot(page, outputRoot, fileName, artifacts) {
  const path = join(outputRoot, fileName);
  await page.screenshot({ path, fullPage: true, animations: 'disabled', caret: 'hide' });
  const bytes = await readFile(path);
  artifacts.push({ kind: 'screenshot', file: fileName, bytes: bytes.byteLength, sha256: sha256(bytes) });
}

async function convertSmallFixture(page, baseUrl, fixturePath, format, outputRoot, artifacts) {
  await loadApplication(page, baseUrl);
  await selectFixture(page, fixturePath);
  await chooseOption(page, 'format', format);
  await chooseOption(page, 'quality', 'low');
  await chooseOption(page, 'scale', '0.5');
  await page.locator('[data-testid="convert-button"]').click();
  await proceedIfPrompted(page);
  await waitForConversionOutcome(page, CONVERSION_TIMEOUT_MS);

  const preview = page.locator('[data-testid="result-image"]');
  await preview.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => {
    const image = document.querySelector('[data-testid="result-image"]');
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
  }, undefined, { timeout: 30_000 });
  const dimensions = await preview.evaluate((image) => ({
    width: image.naturalWidth,
    height: image.naturalHeight,
  }));
  assert.deepEqual(dimensions, { width: 80, height: 45 });

  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await page.locator('[data-testid="download-result-button"]').click();
  const download = await downloadPromise;
  assert(
    download.suggestedFilename().toLowerCase().endsWith(`.${format}`),
    'Downloaded file has the wrong extension'
  );
  const bytes = await readDownload(download);
  validateOutput(bytes, format);
  const outputFile = `${PROFILE_ID}-${format}.${format}`;
  await writeFile(join(outputRoot, outputFile), bytes);
  artifacts.push({
    kind: 'converted-media',
    file: outputFile,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  });
  await recordScreenshot(page, outputRoot, `${PROFILE_ID}-${format}-result.png`, artifacts);

  return {
    id: `h264-to-${format}`,
    status: 'passed',
    preview: dimensions,
    download: { file: outputFile, bytes: bytes.byteLength, sha256: sha256(bytes) },
  };
}

async function exerciseCancellation(page, baseUrl, fixturePath, outputRoot, artifacts) {
  await loadApplication(page, baseUrl);
  await selectFixture(page, fixturePath);
  await chooseOption(page, 'format', 'gif');
  await chooseOption(page, 'quality', 'high');
  await chooseOption(page, 'scale', '1');
  await chooseOption(page, 'smart-frame-skip', 'adaptive');
  await page.locator('[data-testid="convert-button"]').click();
  await proceedIfPrompted(page);

  const stop = page.locator('[data-testid="stop-conversion-button"]');
  const result = page.locator('[data-testid="result-section"]');
  const error = page.locator('[data-testid="error-display"]');
  const firstOutcome = await Promise.race([
    stop.waitFor({ state: 'visible', timeout: CANCELLATION_TIMEOUT_MS }).then(() => 'stoppable'),
    result.waitFor({ state: 'visible', timeout: CANCELLATION_TIMEOUT_MS }).then(() => 'completed'),
    error.waitFor({ state: 'visible', timeout: CANCELLATION_TIMEOUT_MS }).then(() => 'error'),
  ]);

  if (firstOutcome === 'completed') {
    return {
      id: 'cancel-high-motion',
      status: 'observed',
      attempted: false,
      effective: false,
      reason: 'conversion-completed-before-stop-control-was-observable',
    };
  }
  if (firstOutcome === 'error') {
    assert.fail(`High-motion setup failed: ${(await error.textContent())?.trim() ?? 'unknown error'}`);
  }

  try {
    await stop.click({ timeout: 5_000 });
  } catch (clickError) {
    if (await result.isVisible()) {
      return {
        id: 'cancel-high-motion',
        status: 'observed',
        attempted: false,
        effective: false,
        reason: 'conversion-completed-during-stop-click-race',
      };
    }
    throw clickError;
  }

  await page.waitForFunction(() => {
    const convert = document.querySelector('[data-testid="convert-button"]');
    const stopButton = document.querySelector('[data-testid="stop-conversion-button"]');
    return convert instanceof HTMLButtonElement && !convert.disabled && !stopButton;
  }, undefined, { timeout: 30_000 });
  assert.equal(await result.isVisible(), false, 'Cancelled conversion unexpectedly produced a result');
  const errorVisible = await error.isVisible();
  const errorText = errorVisible ? (await error.textContent())?.trim() : null;
  assert.equal(
    errorVisible,
    false,
    `Cancellation produced an error: ${errorText ?? 'unknown error'}`
  );
  await recordScreenshot(page, outputRoot, `${PROFILE_ID}-cancelled.png`, artifacts);
  return { id: 'cancel-high-motion', status: 'passed', attempted: true, effective: true };
}

async function observeEnvironment(page, browser) {
  const pageObservation = await page.evaluate(() => {
    let webglRenderer = null;
    try {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('webgl');
      const extension = context?.getExtension('WEBGL_debug_renderer_info');
      if (context && extension) webglRenderer = context.getParameter(extension.UNMASKED_RENDERER_WEBGL);
    } catch {
      // The renderer is diagnostic-only and can be withheld by browser policy.
    }
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      languages: [...navigator.languages],
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGiB: navigator.deviceMemory ?? null,
      isSecureContext: globalThis.isSecureContext,
      crossOriginIsolated: globalThis.crossOriginIsolated,
      apis: {
        videoDecoder: typeof globalThis.VideoDecoder === 'function',
        videoFrame: typeof globalThis.VideoFrame === 'function',
        webAssembly: typeof globalThis.WebAssembly === 'object',
        sharedArrayBuffer: typeof globalThis.SharedArrayBuffer === 'function',
        offscreenCanvas: typeof globalThis.OffscreenCanvas === 'function',
        imageDecoder: typeof globalThis.ImageDecoder === 'function',
      },
      webglRenderer,
    };
  });
  return {
    browserType: browser.browserType().name(),
    browserVersion: browser.version(),
    ...pageObservation,
    performanceQualification: 'not-measured',
  };
}

/**
 * Run the WMC Windows stable-browser acceptance profile.
 *
 * @param {{browser: import('playwright-core').Browser, root: string, output: string}} input
 * @returns {Promise<Record<string, unknown>>} JSON-serializable acceptance result
 */
export async function run({ browser, root, output }) {
  assert(
    browser && typeof browser.newContext === 'function',
    'run.browser must be a launched Playwright Browser'
  );
  assert.equal(typeof root, 'string', 'run.root must be the bundle root path');
  assert.equal(typeof output, 'string', 'run.output must be the evidence directory path');

  const bundleRoot = await realpath(resolve(root));
  const smallFixture = await validateBundleFile(bundleRoot, SMALL_FIXTURE);
  const cancellationFixture = await validateBundleFile(bundleRoot, CANCELLATION_FIXTURE);
  const outputRoot = resolve(output);
  await mkdir(outputRoot, { recursive: true });

  let context;
  let server;
  const artifacts = [];
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  const failedResponses = [];

  try {
    const started = await startStaticServer(bundleRoot);
    server = started.server;
    context = await browser.newContext({
      acceptDownloads: true,
      colorScheme: 'light',
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
      const requestUrl = new URL(request.url());
      const error = request.failure()?.errorText ?? 'unknown';
      if (requestUrl.protocol === 'blob:' && error === 'net::ERR_ABORTED') return;
      failedRequests.push({
        url: requestUrl.pathname,
        error,
      });
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        failedResponses.push({
          status: response.status(),
          url: new URL(response.url()).pathname,
        });
      }
    });

    const appLoad = await loadApplication(page, started.url);
    const environment = await observeEnvironment(page, browser);
    assert.equal(appLoad.crossOriginIsolated, true, 'COOP/COEP did not produce a cross-origin-isolated app');

    const checks = [{ id: 'app-load', status: 'passed', ...appLoad }];
    checks.push(await convertSmallFixture(page, started.url, smallFixture, 'gif', outputRoot, artifacts));
    checks.push(await convertSmallFixture(page, started.url, smallFixture, 'webp', outputRoot, artifacts));
    checks.push(await exerciseCancellation(page, started.url, cancellationFixture, outputRoot, artifacts));

    await writeFile(join(outputRoot, 'network-diagnostics.json'), JSON.stringify({ pageErrors, consoleErrors, failedRequests, failedResponses }, null, 2));
    assert.deepEqual(pageErrors, [], `Unhandled page errors: ${pageErrors.join(' | ')}`);
    assert.deepEqual(consoleErrors, [], `Console errors: ${consoleErrors.join(' | ')}`);
    assert.deepEqual(failedRequests, [], `Failed requests: ${JSON.stringify(failedRequests)}`);
    assert.deepEqual(failedResponses, [], `Failed HTTP responses: ${JSON.stringify(failedResponses)}`);

    return {
      profile: PROFILE_ID,
      status: 'passed',
      checks,
      observations: {
        environment,
        consoleErrors,
        failedRequests,
        scope: 'functional-and-visual-smoke',
        nativeDialogs: 'not-tested',
        explorerIntegration: 'not-tested',
        gpuPerformance: 'not-measured',
      },
      artifacts,
    };
  } finally {
    await context?.close();
    if (server) await closeServer(server);
  }
}
