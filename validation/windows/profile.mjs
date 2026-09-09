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

function parseCssColor(value) {
  const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/);
  if (rgbMatch) {
    const components = rgbMatch[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    assert(components.length >= 3 && components.slice(0, 3).every(Number.isFinite));
    return {
      channels: components.slice(0, 3),
      alpha: components.length >= 4 ? components[3] : 1,
    };
  }

  const srgbMatch = value.match(/^color\(srgb\s+([^)]*)\)$/);
  assert(srgbMatch, `Unsupported computed color: ${value}`);
  const components = srgbMatch[1].split(/[\s/]+/).filter(Boolean).map(Number);
  assert(components.length >= 3 && components.slice(0, 3).every(Number.isFinite));
  return {
    channels: components.slice(0, 3).map((channel) => channel * 255),
    alpha: components.length >= 4 ? components[3] : 1,
  };
}

function compositeCssBackgrounds(values) {
  let composite = { channels: [0, 0, 0], alpha: 0 };
  for (const value of values.toReversed()) {
    const layer = parseCssColor(value);
    const alpha = layer.alpha + composite.alpha * (1 - layer.alpha);
    if (alpha === 0) continue;
    composite = {
      channels: layer.channels.map(
        (channel, index) =>
          (channel * layer.alpha +
            composite.channels[index] * composite.alpha * (1 - layer.alpha)) /
          alpha
      ),
      alpha,
    };
  }
  assert.equal(composite.alpha, 1, 'Result metadata has no opaque background');
  return composite.channels;
}

function contrastRatio(foreground, background) {
  const luminance = (color) => {
    const channels = color.map((channel) => {
      const srgb = channel / 255;
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

async function settleVisualState(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}

async function readResultMetadataContrast(page, selector) {
  const computed = await page.locator(selector).evaluate((element) => {
    const backgrounds = [];
    for (let current = element; current; current = current.parentElement) {
      backgrounds.push(getComputedStyle(current).backgroundColor);
    }
    const style = getComputedStyle(element);
    return {
      color: style.color,
      backgrounds,
      fontSizePx: Number.parseFloat(style.fontSize),
      opacity: Number.parseFloat(style.opacity),
    };
  });
  const foreground = parseCssColor(computed.color);
  assert.equal(foreground.alpha, 1, `Computed text color is not opaque: ${computed.color}`);
  return {
    ...computed,
    ratio: contrastRatio(foreground.channels, compositeCssBackgrounds(computed.backgrounds)),
  };
}

async function readPreviewPresentation(page) {
  return page.locator('[data-testid="result-image"]').evaluate((image) => {
    const element = image;
    const rect = element.getBoundingClientRect();
    const scale = Math.min(rect.width / element.naturalWidth, rect.height / element.naturalHeight);
    const actual = document.querySelector('[data-testid="preview-size-actual"]');
    const fit = document.querySelector('[data-testid="preview-size-fit"]');
    const scaleIndicator = document.querySelector('[data-testid="preview-scale"]');
    return {
      naturalWidth: element.naturalWidth,
      naturalHeight: element.naturalHeight,
      renderedWidth: rect.width,
      renderedHeight: rect.height,
      scale,
      actualPressed: actual?.getAttribute('aria-pressed'),
      fitPressed: fit?.getAttribute('aria-pressed'),
      scaleText: scaleIndicator?.getAttribute('data-preview-scale') ?? null,
    };
  });
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
  if (!(await option.isVisible())) {
    const advanced = page.locator('[data-testid="advanced-settings"]');
    assert.equal(
      await advanced.count(),
      1,
      `Hidden ${group}=${value} option has no advanced-settings disclosure`
    );
    await advanced.locator('summary').click();
  }
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

async function readResultDiscoveryState(page, format) {
  return page.evaluate((expectedFormat) => {
    const button = document.querySelector('[data-testid="download-result-button"]');
    const image = document.querySelector('[data-testid="result-image"]');
    const summary = document.querySelector('[data-testid="result-summary"]');
    const activeElement = document.activeElement;
    const serializeRect = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      };
    };
    const buttonRect = serializeRect(button);

    return {
      format: expectedFormat,
      viewport: {
        width: innerWidth,
        height: innerHeight,
        scrollX,
        scrollY,
      },
      activeElement: activeElement
        ? {
            tag: activeElement.tagName.toLowerCase(),
            id: activeElement.id || null,
            testId: activeElement.getAttribute('data-testid'),
          }
        : null,
      button: {
        present: button instanceof HTMLElement,
        focused: button instanceof HTMLElement && activeElement === button,
        href: button instanceof HTMLAnchorElement ? button.getAttribute('href') : null,
        clientRectCount: button instanceof HTMLElement ? button.getClientRects().length : 0,
        rect: buttonRect,
        withinViewport:
          buttonRect !== null &&
          buttonRect.top >= 0 &&
          buttonRect.right <= innerWidth &&
          buttonRect.bottom <= innerHeight &&
          buttonRect.left >= 0,
      },
      summary: {
        present: summary instanceof HTMLElement,
        text: summary?.textContent?.trim() ?? null,
        beforeDownload:
          summary instanceof HTMLElement && button instanceof HTMLElement
            ? Boolean(summary.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING)
            : false,
        downloadBeforePreview:
          button instanceof HTMLElement && image instanceof HTMLImageElement
            ? Boolean(button.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING)
            : false,
      },
      image: {
        present: image instanceof HTMLImageElement,
        complete: image instanceof HTMLImageElement ? image.complete : null,
        naturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : null,
        naturalHeight: image instanceof HTMLImageElement ? image.naturalHeight : null,
        rect: serializeRect(image),
        skeletonPresent:
          image instanceof HTMLImageElement
            ? image.parentElement?.querySelector('.animate-pulse') !== null
            : null,
      },
    };
  }, format);
}

async function convertSmallFixture(page, baseUrl, fixturePath, format, outputRoot, artifacts) {
  await page.setViewportSize(
    format === 'webp' ? { width: 390, height: 844 } : { width: 1280, height: 900 }
  );
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

  let discovery;
  try {
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-testid="download-result-button"]');
      if (!(button instanceof HTMLElement) || document.activeElement !== button) return false;
      const rect = button.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    }, undefined, { timeout: 5_000 });
    discovery = await readResultDiscoveryState(page, format);
  } catch (error) {
    discovery = await readResultDiscoveryState(page, format);
    const diagnosticFile = `${PROFILE_ID}-${format}-discovery-failure.json`;
    const diagnosticBytes = Buffer.from(`${JSON.stringify(discovery, null, 2)}\n`);
    await writeFile(join(outputRoot, diagnosticFile), diagnosticBytes);
    artifacts.push({
      kind: 'diagnostic',
      file: diagnosticFile,
      bytes: diagnosticBytes.byteLength,
      sha256: sha256(diagnosticBytes),
    });
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Result discovery failed for ${format}: ${JSON.stringify(discovery)}; ${reason}`
    );
  }
  assert.equal(discovery.summary.present, true, 'Result summary is missing');
  assert.equal(discovery.summary.beforeDownload, true, 'Result summary does not precede download');
  assert.equal(
    discovery.summary.downloadBeforePreview,
    true,
    'Primary download does not precede the preview'
  );
  assert(
    discovery.summary.text?.includes('80×45'),
    'Result summary omitted the encoded resolution'
  );

  await settleVisualState(page);
  const actualPresentation = await readPreviewPresentation(page);
  assert.equal(actualPresentation.actualPressed, 'true');
  assert.equal(actualPresentation.fitPressed, 'false');
  assert(
    actualPresentation.scale > 0 && actualPresentation.scale <= 1.01,
    `Actual-size preview was enlarged: ${JSON.stringify(actualPresentation)}`
  );
  assert.equal(
    Number.parseInt(actualPresentation.scaleText ?? '', 10),
    Math.round(actualPresentation.scale * 100),
    'Actual-size scale indicator does not match rendered geometry'
  );

  await page.locator('[data-testid="preview-size-fit"]').click();
  await page.waitForFunction(() => {
    const image = document.querySelector('[data-testid="result-image"]');
    if (!(image instanceof HTMLImageElement) || image.naturalWidth <= 0) return false;
    const rect = image.getBoundingClientRect();
    return Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight) > 1.1;
  }, undefined, { timeout: 5_000 });
  await settleVisualState(page);
  const fitPresentation = await readPreviewPresentation(page);
  assert.equal(fitPresentation.actualPressed, 'false');
  assert.equal(fitPresentation.fitPressed, 'true');
  assert(
    fitPresentation.scale > 1.1,
    `Fit preview did not use the available area: ${JSON.stringify(fitPresentation)}`
  );
  assert.equal(
    Number.parseInt(fitPresentation.scaleText ?? '', 10),
    Math.round(fitPresentation.scale * 100),
    'Fit scale indicator does not match rendered geometry'
  );

  await page.locator('[data-testid="preview-size-actual"]').click();
  await page.waitForFunction(() => {
    const image = document.querySelector('[data-testid="result-image"]');
    if (!(image instanceof HTMLImageElement) || image.naturalWidth <= 0) return false;
    const rect = image.getBoundingClientRect();
    return Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight) <= 1.01;
  }, undefined, { timeout: 5_000 });
  await settleVisualState(page);

  await page.emulateMedia({ colorScheme: 'light' });
  await settleVisualState(page);
  const lightMetadataContrast = {
    summary: await readResultMetadataContrast(page, '[data-testid="result-summary"]'),
    details: await readResultMetadataContrast(page, '[data-result-quality]'),
  };
  for (const [surface, contrast] of Object.entries(lightMetadataContrast)) {
    assert(contrast.fontSizePx >= 12, `Light ${surface} metadata is smaller than 12 CSS px`);
    assert.equal(contrast.opacity, 1, `Light ${surface} metadata is translucent`);
    assert(
      contrast.ratio >= 4.5,
      `Light ${surface} metadata contrast is ${contrast.ratio.toFixed(2)}:1`
    );
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await settleVisualState(page);
  const darkMetadataContrast = {
    summary: await readResultMetadataContrast(page, '[data-testid="result-summary"]'),
    details: await readResultMetadataContrast(page, '[data-result-quality]'),
  };
  for (const [surface, contrast] of Object.entries(darkMetadataContrast)) {
    assert(contrast.fontSizePx >= 12, `Dark ${surface} metadata is smaller than 12 CSS px`);
    assert.equal(contrast.opacity, 1, `Dark ${surface} metadata is translucent`);
    assert(
      contrast.ratio >= 4.5,
      `Dark ${surface} metadata contrast is ${contrast.ratio.toFixed(2)}:1`
    );
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await settleVisualState(page);

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
    presentation: {
      actual: actualPresentation,
      fit: fitPresentation,
      metadataContrast: {
        light: lightMetadataContrast,
        dark: darkMetadataContrast,
      },
    },
    download: {
      file: outputFile,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      focusedAndVisibleBeforeClick: true,
      discovery,
    },
  };
}

async function exerciseUiDisclosures(page, baseUrl, fixturePath, outputRoot, artifacts) {
  await loadApplication(page, baseUrl);
  await selectFixture(page, fixturePath);

  const metadata = page.locator('[data-testid="video-metadata"]');
  const metadataSummary = metadata.locator('summary');
  assert.equal(await metadata.evaluate((element) => element.tagName), 'DETAILS');
  assert.equal(await metadata.evaluate((element) => element.open), false);
  assert(
    (await metadataSummary.evaluate((element) => element.getBoundingClientRect().height)) >= 44,
    'Metadata disclosure summary is smaller than the minimum interaction target'
  );
  await metadataSummary.focus();
  await page.keyboard.press('Enter');
  assert.equal(await metadata.evaluate((element) => element.open), true);
  assert.equal(await metadataSummary.evaluate((element) => document.activeElement === element), true);
  assert(
    (await metadata.textContent())?.includes(basename(fixturePath)),
    'Metadata disclosure omitted the selected fixture name'
  );

  const advanced = page.locator('[data-testid="advanced-settings"]');
  const advancedSummary = advanced.locator('summary');
  assert.equal(await advanced.evaluate((element) => element.tagName), 'DETAILS');
  assert.equal(await advanced.evaluate((element) => element.open), false);
  assert(
    (await advancedSummary.evaluate((element) => element.getBoundingClientRect().height)) >= 44,
    'Advanced-settings summary is smaller than the minimum interaction target'
  );
  await advancedSummary.focus();
  await page.keyboard.press('Enter');
  assert.equal(await advanced.evaluate((element) => element.open), true);
  assert.equal(await advancedSummary.evaluate((element) => document.activeElement === element), true);

  await chooseOption(page, 'smart-frame-skip', 'off');
  const offInput = page.locator('[data-testid="option-smart-frame-skip-off"] input');
  const lowOption = page.locator('[data-testid="option-smart-frame-skip-low"]');
  const lowInput = lowOption.locator('input');
  await offInput.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await lowInput.isChecked(), true, 'Keyboard did not select the next frame-skip mode');
  const lowLabel = await lowOption.getAttribute('aria-label');
  assert(lowLabel, 'Frame-skip option has no accessible label');
  assert(
    (await advancedSummary.textContent())?.includes(lowLabel),
    'Advanced-settings summary did not reflect the keyboard selection'
  );

  await recordScreenshot(page, outputRoot, `${PROFILE_ID}-disclosures.png`, artifacts);
  await advancedSummary.focus();
  await page.keyboard.press('Space');
  assert.equal(await advanced.evaluate((element) => element.open), false);
  await metadataSummary.focus();
  await page.keyboard.press('Space');
  assert.equal(await metadata.evaluate((element) => element.open), false);

  return {
    id: 'native-disclosures-keyboard',
    status: 'passed',
    metadataDisclosure: true,
    advancedDisclosure: true,
    keyboardSelection: 'smart-frame-skip-low',
  };
}

async function installCancellationInspector(page) {
  return page.evaluate(() => {
    const visible = (element) =>
      element instanceof HTMLElement && element.getClientRects().length > 0;
    const progressBars = [...document.querySelectorAll('[role="progressbar"]')].filter(visible);
    const progressBar = progressBars[0];
    const progress = Number(progressBar?.getAttribute('data-progress'));
    if (!(progressBar instanceof HTMLElement) || progressBars.length !== 1 || !(progress > 0)) {
      throw new Error('Cancellation inspector requires one visible non-zero progress bar');
    }

    const inspector = {
      progressBar,
      progress,
      observation: null,
      observer: null,
    };
    const capture = () => {
      if (inspector.observation) return;
      const stateText = document.querySelector('#app-state')?.textContent?.trim() ?? '';
      if (!stateText.toLowerCase().startsWith('cancelling')) return;
      const currentProgressBars = [...document.querySelectorAll('[role="progressbar"]')].filter(
        visible
      );
      const settingsCancel = document.querySelector('[data-testid="stop-conversion-button"]');
      const dropzoneCancel = document.querySelector('[data-testid="dropzone-cancel-button"]');
      const dropzone = document.querySelector('[data-testid="dropzone"]');
      inspector.observation = {
        stateText,
        sameProgressElement: currentProgressBars[0] === inspector.progressBar,
        progressValues: currentProgressBars.map((element) =>
          Number(element.getAttribute('data-progress'))
        ),
        visibleProgressBarCount: currentProgressBars.length,
        legacyProgressCount: document.querySelectorAll('[data-testid="conversion-progress"]')
          .length,
        settingsCancel: {
          disabled:
            settingsCancel instanceof HTMLButtonElement ? settingsCancel.disabled : undefined,
          label: settingsCancel?.getAttribute('aria-label') ?? null,
        },
        dropzoneCancel: {
          disabled:
            dropzoneCancel instanceof HTMLButtonElement ? dropzoneCancel.disabled : undefined,
          label: dropzoneCancel?.getAttribute('aria-label') ?? null,
        },
        dropzoneBusy: dropzone?.getAttribute('aria-busy') ?? null,
      };
    };
    inspector.observer = new MutationObserver(capture);
    inspector.observer.observe(document.body, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    globalThis.__wmcCancellationInspector = inspector;
    return progress;
  });
}

async function readCancellationInspector(page) {
  return page.evaluate(() => {
    const inspector = globalThis.__wmcCancellationInspector;
    inspector?.observer?.disconnect();
    delete globalThis.__wmcCancellationInspector;
    return inspector?.observation ?? null;
  });
}

async function inspectRestoredPreview(page) {
  const preview = page.locator('#selection-preview-video');
  await preview.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => {
    const video = document.querySelector('#selection-preview-video');
    if (!(video instanceof HTMLVideoElement)) return false;
    const rect = video.getBoundingClientRect();
    return (
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      video.videoWidth > 0 &&
      video.videoHeight > 0 &&
      rect.width > 0 &&
      rect.height > 0 &&
      getComputedStyle(video).opacity === '1'
    );
  }, undefined, { timeout: 10_000 });
  await settleVisualState(page);

  const firstFrame = await preview.evaluate((video) => {
    const element = video;
    const rect = element.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    assertContext(context);
    context.drawImage(element, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaquePixels = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 0) opaquePixels++;
    }
    return {
      currentTime: element.currentTime,
      readyState: element.readyState,
      videoWidth: element.videoWidth,
      videoHeight: element.videoHeight,
      renderedWidth: rect.width,
      renderedHeight: rect.height,
      opacity: getComputedStyle(element).opacity,
      opaquePixels,
    };

    function assertContext(value) {
      if (!value) throw new Error('Restored preview canvas has no 2D context');
    }
  });
  assert(firstFrame.currentTime < 0.05, 'Restored preview did not return to its first frame');
  assert.equal(firstFrame.opacity, '1', 'Restored preview transition did not settle');
  assert.equal(firstFrame.opaquePixels, 64, 'Restored first frame was not drawable');
  assert(firstFrame.videoWidth > 0 && firstFrame.videoHeight > 0);
  assert(firstFrame.renderedWidth > 0 && firstFrame.renderedHeight > 0);

  const knownContentPixels = await preview.evaluate(async (video) => {
    const element = video;
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Restored preview canvas has no 2D context');

    const seek = (time) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Restored preview seek timed out')), 3_000);
        const onSeeked = () => {
          clearTimeout(timeout);
          resolve();
        };
        element.addEventListener('seeked', onSeeked, { once: true });
        element.currentTime = time;
      });

    for (let frame = 0; frame < 8; frame++) {
      await seek(0.26 + frame / 120);
      context.drawImage(element, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonBlackPixels = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 24) {
          nonBlackPixels++;
        }
      }
      // This fixture alternates black and bright frames. Leave the video on
      // the frame whose pixels were verified so the following capture matches
      // the observation rather than an unrelated final black frame.
      if (nonBlackPixels > 0) return nonBlackPixels;
    }
    return 0;
  });
  assert(knownContentPixels > 0, 'Restored preview did not render known non-black fixture content');

  await settleVisualState(page);
  const knownContentTime = await preview.evaluate((video) => video.currentTime);
  return { firstFrame, knownContentPixels, knownContentTime };
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

  const progress = page.locator('[data-testid="dropzone"] [role="progressbar"]');
  const progressOutcome = await Promise.race([
    page
      .waitForFunction(() => {
        const element = document.querySelector('[data-testid="dropzone"] [role="progressbar"]');
        return Number(element?.getAttribute('data-progress')) > 0;
      }, undefined, { timeout: CANCELLATION_TIMEOUT_MS })
      .then(() => 'progress'),
    result.waitFor({ state: 'visible', timeout: CANCELLATION_TIMEOUT_MS }).then(() => 'completed'),
    error.waitFor({ state: 'visible', timeout: CANCELLATION_TIMEOUT_MS }).then(() => 'error'),
  ]);
  if (progressOutcome === 'completed') {
    return {
      id: 'cancel-high-motion',
      status: 'observed',
      attempted: false,
      effective: false,
      reason: 'conversion-completed-before-non-zero-progress-was-observable',
    };
  }
  if (progressOutcome === 'error') {
    assert.fail(`High-motion setup failed: ${(await error.textContent())?.trim() ?? 'unknown error'}`);
  }
  const progressBeforeCancel = await installCancellationInspector(page);
  assert.equal(Number(await progress.getAttribute('data-progress')), progressBeforeCancel);

  try {
    await stop.click({ timeout: 5_000 });
  } catch (clickError) {
    if (await result.isVisible()) {
      await readCancellationInspector(page);
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
  const cancellationUi = await readCancellationInspector(page);
  assert(cancellationUi, 'Cancellation state was not observable by the UI inspector');
  assert.equal(cancellationUi.sameProgressElement, true);
  assert.deepEqual(cancellationUi.progressValues, [progressBeforeCancel]);
  assert.equal(cancellationUi.visibleProgressBarCount, 1);
  assert.equal(cancellationUi.legacyProgressCount, 0);
  assert.equal(cancellationUi.settingsCancel.disabled, true);
  assert.equal(cancellationUi.dropzoneCancel.disabled, true);
  assert.equal(cancellationUi.settingsCancel.label, cancellationUi.stateText);
  assert.equal(cancellationUi.dropzoneCancel.label, cancellationUi.stateText);
  assert.equal(cancellationUi.dropzoneBusy, 'true');
  const previewRecovery = await inspectRestoredPreview(page);
  await recordScreenshot(page, outputRoot, `${PROFILE_ID}-cancelled.png`, artifacts);
  return {
    id: 'cancel-high-motion',
    status: 'passed',
    attempted: true,
    effective: true,
    progressBeforeCancel,
    cancellationUi,
    previewRecovery,
  };
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
    checks.push(await exerciseUiDisclosures(page, started.url, smallFixture, outputRoot, artifacts));

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
