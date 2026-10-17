// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

import type {
  APIResponse,
  Browser,
  BrowserContext,
  Download,
  Page,
  Request as PlaywrightRequest,
} from '@playwright/test';

import { runAppUpdate } from './app-update.ts';
import { assertGifPlayback, collectGifPlayback, parseGifDelaysCs } from './gif-playback.ts';
import { makeMp4BudgetFixture } from './mp4-budget-fixture.ts';
import { exerciseOfflineRecovery, runRecoveryBuilds } from './offline-recovery.ts';
import type { OutputContractCase } from './output-contract.ts';
import { compareAnimatedOutputExact, verifyAnimatedOutput } from './output-contract.ts';

type Artifact = { kind: string; file: string; bytes: number; sha256: string };
type HeaderRule = { pattern: string; headers: Map<string, string> };
type AssetFailure = { path: string; mode: '404' | 'wrong-mime' | 'network' };
type PublicTarget = { url: string; sourceSha: string; deploymentId: string };
type PublicMetadata = {
  schemaVersion: number;
  sourceSha: string;
  treeSha: string;
  coreSha: string;
  branch: string;
  version: string;
  files: { path: string; size: number; sha256: string }[];
};
type OutputContractConfig = {
  schemaVersion: number;
  cases: OutputContractCase[];
  markers: Record<string, number[]>;
  pressureExpectations: Record<string, Partial<OutputContractCase['expected']>>;
};
type HttpStatusError = Error & { statusCode: number };
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertPublicMetadata(value: unknown): asserts value is PublicMetadata {
  assert(isRecord(value), 'Invalid public deployment metadata');
  assert(typeof value.schemaVersion === 'number');
  for (const key of ['sourceSha', 'treeSha', 'coreSha', 'branch', 'version'] as const)
    assert(typeof value[key] === 'string', `Invalid public metadata ${key}`);
  assert(Array.isArray(value.files), 'Invalid public metadata files');
  for (const file of value.files) {
    assert(isRecord(file), 'Invalid public metadata file');
    assert(typeof file.path === 'string');
    assert(typeof file.size === 'number');
    assert(typeof file.sha256 === 'string');
  }
}

function assertOutputContractConfig(value: unknown): asserts value is OutputContractConfig {
  assert(isRecord(value), 'Invalid output contract');
  assert(typeof value.schemaVersion === 'number');
  assert(Array.isArray(value.cases) && value.cases.length > 0);
  for (const contract of value.cases) {
    assert(isRecord(contract), 'Invalid output contract case');
    assert(typeof contract.id === 'string' && typeof contract.fixture === 'string');
    assert(contract.format === 'gif' || contract.format === 'webp');
    assert(
      contract.sourceRotationClockwise === undefined ||
        typeof contract.sourceRotationClockwise === 'number'
    );
    const settings = contract.settings;
    assert(isRecord(settings), 'Invalid output contract settings');
    assert(['low', 'medium', 'high'].includes(String(settings.quality)));
    assert(['0.5', '0.75', '1'].includes(String(settings.scale)));
    assert(typeof settings.trimStart === 'number' && typeof settings.trimEnd === 'number');
    assert(['off', 'low', 'medium', 'high', 'adaptive'].includes(String(settings.smartFrameSkip)));
    const expected = contract.expected;
    assert(isRecord(expected), 'Invalid output contract expectation');
    assert(typeof expected.width === 'number' && typeof expected.height === 'number');
    assert(
      Array.isArray(expected.markers) && expected.markers.every((item) => typeof item === 'string')
    );
    assert(
      Array.isArray(expected.durationsMs) &&
        expected.durationsMs.every((item) => typeof item === 'number')
    );
    assert(typeof expected.durationToleranceMs === 'number');
    assert(typeof expected.maxColorDistance === 'number');
    if (expected.corners !== undefined) {
      assert(isRecord(expected.corners));
      for (const corner of ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'])
        assert(typeof expected.corners[corner] === 'string');
    }
  }
  assert(isRecord(value.markers), 'Invalid output contract markers');
  for (const marker of Object.values(value.markers))
    assert(Array.isArray(marker) && marker.every((item) => typeof item === 'number'));
  assert(isRecord(value.pressureExpectations), 'Invalid output contract pressure expectations');
  for (const expectation of Object.values(value.pressureExpectations)) {
    assert(isRecord(expectation));
    for (const [key, entry] of Object.entries(expectation)) {
      assert(
        [
          'width',
          'height',
          'markers',
          'corners',
          'durationsMs',
          'durationToleranceMs',
          'maxColorDistance',
        ].includes(key)
      );
      if (key === 'markers')
        assert(Array.isArray(entry) && entry.every((item) => typeof item === 'string'));
      else if (key === 'durationsMs')
        assert(Array.isArray(entry) && entry.every((item) => typeof item === 'number'));
      else if (key === 'corners') {
        assert(isRecord(entry));
        for (const corner of ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'])
          assert(typeof entry[corner] === 'string');
      } else assert(typeof entry === 'number');
    }
  }
}
function httpStatusError(message: string, statusCode: number): HttpStatusError {
  return Object.assign(new Error(message), { statusCode });
}
type AnalysisObservation = {
  state: string;
  busy: string | null | undefined;
  ariaValueNow: string | null;
  dataProgress: string | null;
  cancelLabel: string | null;
  cancelTitle: string | null;
  diagnosticsCount: number | undefined;
  visibleZero: boolean;
};
type CancellationSample = {
  values: number[];
  ariaValueNow: string | null;
  sameProgressElement: boolean;
};
type CancellationObservation = {
  stateText: string;
  progressBeforeClick: number;
  sameProgressElement: boolean;
  progressValues: number[];
  progressSamples: CancellationSample[];
  sampleOverflow: boolean;
  visibleProgressBarCount: number;
  legacyProgressCount: number;
  settingsCancel: { disabled: boolean | undefined; label: string | null };
  dropzoneCancel: { disabled: boolean | undefined; label: string | null };
  dropzoneBusy: string | null;
  progressBusy: string | null;
  progressAriaValueNow: string | null;
  diagnosticsCount: number;
  diagnosticsOpen: boolean | null;
  diagnosticsSummaryFontSizePx: number | null;
  statusFontSizePx: number | null;
};
type PressureProbe = {
  nativeDecoded: number;
  submittedWebp: number;
  terminal: {
    decodedFrames: number;
    selectedFrames: number;
    encodedFrames: number;
    emittedFrames: number;
  } | null;
  startRatios: number[];
  reset: () => void;
};
type InspectorPage = { evaluate<T>(callback: () => T): Promise<T> };
declare global {
  interface Navigator {
    readonly deviceMemory?: number;
  }
  var __wmcAnalysisInspector:
    | { observer: MutationObserver; observations: AnalysisObservation[] }
    | undefined;
  var __wmcCancellationInspector:
    | {
        progressBar: HTMLElement;
        progress: number;
        observation: CancellationObservation | null;
        observer: MutationObserver | null;
      }
    | undefined;
  var __wmcPressureProbe: PressureProbe;
  var __wmcPublicViolations: string[];
  var __wmcWorkerConstructionAttempts: number;
}

const PROFILE_ID = 'wmc-media';
const SMALL_FIXTURE = 'public/test-video-ci-h264.mp4';
const CANCELLATION_FIXTURE = 'public/test-video-ci-high-motion-120fps.mp4';
const OUTPUT_CONTRACT = 'validation/windows/output-contract.json';
const PUBLIC_TARGET = 'validation/windows/public-target.json';
const CONVERSION_TIMEOUT_MS = 120_000;
const CANCELLATION_TIMEOUT_MS = 180_000;
const ZOOM_PROFILE_PREFIX = 'wmc-zoom-chrome-';

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

function sha256(bytes: Buffer | Uint8Array | string) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseCssColor(value: string) {
  const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/);
  if (rgbMatch) {
    const rgbValues = rgbMatch[1];
    assert(rgbValues);
    const components = rgbValues
      .split(/[,\s/]+/)
      .filter(Boolean)
      .map(Number);
    assert(components.length >= 3 && components.slice(0, 3).every(Number.isFinite));
    return {
      channels: components.slice(0, 3),
      alpha: components[3] ?? 1,
    };
  }

  const srgbMatch = value.match(/^color\(srgb\s+([^)]*)\)$/);
  assert(srgbMatch, `Unsupported computed color: ${value}`);
  const srgbValues = srgbMatch[1];
  assert(srgbValues);
  const components = srgbValues
    .split(/[\s/]+/)
    .filter(Boolean)
    .map(Number);
  assert(components.length >= 3 && components.slice(0, 3).every(Number.isFinite));
  return {
    channels: components.slice(0, 3).map((channel) => channel * 255),
    alpha: components[3] ?? 1,
  };
}

function compositeCssBackgrounds(values: string[]) {
  let composite = { channels: [0, 0, 0], alpha: 0 };
  for (const value of values.toReversed()) {
    const layer = parseCssColor(value);
    const alpha = layer.alpha + composite.alpha * (1 - layer.alpha);
    if (alpha === 0) continue;
    composite = {
      channels: layer.channels.map(
        (channel, index) =>
          (channel * layer.alpha +
            (composite.channels[index] ?? 0) * composite.alpha * (1 - layer.alpha)) /
          alpha
      ),
      alpha,
    };
  }
  assert.equal(composite.alpha, 1, 'Result metadata has no opaque background');
  return composite.channels;
}

function contrastRatio(foreground: number[], background: number[]) {
  const luminance = (color: number[]) => {
    const channels = color.map((channel) => {
      const srgb = channel / 255;
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    });
    return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

async function settleVisualState(page: Page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished.catch(() => {}))
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

async function readResultMetadataContrast(page: Page, selector: string) {
  const computed = await page.locator(selector).evaluate((element) => {
    // The browser converts CSS Color 4 values (including interpolated oklab)
    // to the same sRGB channels used by this contrast measurement.
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Contrast measurement requires a 2D canvas');
    const srgb = (value: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return `rgba(${r}, ${g}, ${b}, ${(a ?? 0) / 255})`;
    };
    const backgrounds = [];
    for (let current: Element | null = element; current; current = current.parentElement) {
      backgrounds.push(srgb(getComputedStyle(current).backgroundColor));
    }
    const style = getComputedStyle(element);
    return {
      color: srgb(style.color),
      computedColor: style.color,
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

async function readPreviewPresentation(page: Page) {
  return page.locator('[data-testid="result-image"]').evaluate((image) => {
    if (!(image instanceof HTMLImageElement)) throw new Error('Result preview is not an image');
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

function isWithin(parent: string, child: string) {
  const childRelative = relative(parent, child);
  return (
    childRelative === '' ||
    (!childRelative.startsWith(`..${sep}`) && childRelative !== '..' && !isAbsolute(childRelative))
  );
}

function parseCatchAllHeaders(contents: string) {
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

function parseHeaderRules(contents: string) {
  const rules: HeaderRule[] = [];
  let current: HeaderRule | null = null;
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const pattern = line.trim();
      assert(pattern.startsWith('/'), `Invalid _headers path: ${pattern}`);
      current = { pattern, headers: new Map<string, string>() };
      rules.push(current);
      continue;
    }
    assert(current, '_headers field has no path rule');
    const separator = line.indexOf(':');
    assert(separator > 0, `Invalid _headers field: ${line}`);
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    assert(name && value && !/[\r\n]/.test(value), 'Invalid _headers value');
    const key = name.toLowerCase();
    const prior = current.headers.get(key);
    current.headers.set(key, prior ? `${prior}, ${value}` : value);
  }
  return rules;
}

function matchedHeaders(rules: HeaderRule[], pathname: string, catchAllOnly = false) {
  const headers = new Map<string, string>();
  for (const rule of rules) {
    if (catchAllOnly && rule.pattern !== '/*') continue;
    const escaped = rule.pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replaceAll('*', '.*');
    if (!new RegExp(`^${escaped}$`).test(pathname)) continue;
    for (const [name, value] of rule.headers) {
      const prior = headers.get(name.toLowerCase());
      headers.set(name.toLowerCase(), prior ? `${prior}, ${value}` : value);
    }
  }
  return headers;
}

function decodeRequestPath(requestUrl: string | undefined) {
  const url = new URL(requestUrl ?? '/', 'http://127.0.0.1');
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw httpStatusError('Malformed URL encoding', 400);
  }
  if (pathname.includes('\0') || pathname.includes('\\')) {
    throw httpStatusError('Unsafe request path', 400);
  }
  const segments = pathname.split('/').filter(Boolean);
  if (
    segments.some((segment) => segment === '.' || segment === '..' || /[:*?"<>|]/.test(segment))
  ) {
    throw httpStatusError('Unsafe request path', 400);
  }
  return segments.length === 0 ? 'index.html' : segments.join('/');
}

async function resolveStaticFile(distRoot: string, requestUrl: string | undefined) {
  const candidate = resolve(distRoot, decodeRequestPath(requestUrl));
  if (!isWithin(distRoot, candidate)) {
    throw httpStatusError('Request escaped the distribution root', 400);
  }

  const candidateStat = await stat(candidate);
  const fileCandidate = candidateStat.isDirectory() ? join(candidate, 'index.html') : candidate;
  const resolvedFile = await realpath(fileCandidate);
  if (!isWithin(distRoot, resolvedFile)) {
    throw httpStatusError('Request resolved outside the distribution root', 400);
  }
  const fileStat = await stat(resolvedFile);
  if (!fileStat.isFile()) {
    throw httpStatusError('Not a file', 404);
  }
  return resolvedFile;
}

export async function startStaticServer(
  bundleRoot: string,
  {
    gzipAssets = false,
    metadataHandler = null,
  }: {
    gzipAssets?: boolean;
    metadataHandler?:
      | ((
          request: import('node:http').IncomingMessage,
          response: import('node:http').ServerResponse
        ) => void | Promise<void>)
      | null;
  } = {}
) {
  let distRoot: string | undefined;
  let headerRules: HeaderRule[] | undefined;
  let assetFailure: AssetFailure | null = null;
  const assetFailureRequests: { path: string; mode: AssetFailure['mode'] }[] = [];
  const observedAssetRequests: string[] = [];
  let observedAssetOverflow = false;
  const missingAssetResponses: { path: string; status: number }[] = [];
  function setAssetFailure(failure: AssetFailure | null) {
    assert(
      failure === null ||
        (typeof failure === 'object' &&
          /^\/assets\/[\w-]+[.-][\w-]{8}\.js$/.test(failure.path) &&
          ['404', 'wrong-mime', 'network'].includes(failure.mode)),
      'Asset failure must target one emitted JavaScript path and an allowed response'
    );
    assetFailure = failure;
    assetFailureRequests.length = 0;
  }
  async function setDistribution(relativePath: string) {
    const nextRoot = await realpath(resolve(bundleRoot, relativePath));
    assert(isWithin(bundleRoot, nextRoot), 'Bundled dist asset resolved outside the bundle root');
    assert((await stat(nextRoot)).isDirectory(), 'Bundled dist asset is not a directory');
    const headersFile = await realpath(join(nextRoot, '_headers'));
    assert(isWithin(nextRoot, headersFile), 'dist/_headers resolved outside the distribution root');
    const headersText = await readFile(headersFile, 'utf8');
    parseCatchAllHeaders(headersText);
    const nextHeaders = parseHeaderRules(headersText);
    distRoot = nextRoot;
    headerRules = nextHeaders;
  }
  await setDistribution('dist');

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
      if (metadataHandler && request.url === '/deployment-state.json') {
        await metadataHandler(request, response);
        return;
      }
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (/^\/assets\/[\w.-]+\.js$/.test(pathname)) {
        if (observedAssetRequests.length < 512) observedAssetRequests.push(pathname);
        else observedAssetOverflow = true;
      }
      if (assetFailure && pathname === assetFailure.path) {
        if (assetFailureRequests.length < 128)
          assetFailureRequests.push({ path: pathname, mode: assetFailure.mode });
        if (assetFailure.mode === 'network') {
          response.destroy();
          return;
        }
        for (const [name, value] of matchedHeaders(headerRules ?? [], pathname))
          response.setHeader(name, value);
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader(
          'Content-Type',
          assetFailure.mode === '404' ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8'
        );
        const body =
          assetFailure.mode === '404' ? 'Not found' : '<!doctype html><title>Unavailable</title>';
        response.writeHead(assetFailure.mode === '404' ? 404 : 200);
        response.end(request.method === 'HEAD' ? undefined : body);
        return;
      }
      assert(distRoot, 'Distribution root was not initialized');
      const file = await resolveStaticFile(distRoot, request.url);
      const bytes = await readFile(file);
      for (const [name, value] of matchedHeaders(headerRules ?? [], pathname))
        response.setHeader(name, value);
      response.setHeader(
        'Content-Type',
        MIME_TYPES.get(extname(file).toLowerCase()) ?? 'application/octet-stream'
      );
      const compressible =
        gzipAssets && ['.js', '.css', '.json'].includes(extname(file).toLowerCase());
      const acceptsGzip = /(?:^|,)\s*gzip\s*(?:;|,|$)/i.test(
        request.headers['accept-encoding'] ?? ''
      );
      const wireBytes = compressible && acceptsGzip ? gzipSync(bytes) : bytes;
      if (compressible) response.setHeader('Vary', 'Accept-Encoding');
      if (wireBytes !== bytes) response.setHeader('Content-Encoding', 'gzip');
      response.setHeader('Content-Length', String(wireBytes.byteLength));
      response.writeHead(200);
      response.end(request.method === 'HEAD' ? undefined : wireBytes);
    } catch (error) {
      const statusCode =
        error instanceof Error &&
        'statusCode' in error &&
        typeof error.statusCode === 'number' &&
        Number.isInteger(error.statusCode)
          ? error.statusCode
          : error instanceof Error && 'code' in error && error.code === 'ENOENT'
            ? 404
            : 500;
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (/^\/assets\/[\w.-]+\.js$/.test(pathname) && missingAssetResponses.length < 128)
        missingAssetResponses.push({ path: pathname, status: statusCode });
      for (const [name, value] of matchedHeaders(headerRules ?? [], '/', true))
        response.setHeader(name, value);
      response.writeHead(statusCode, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      response.end(statusCode === 404 ? 'Not found' : 'Request rejected');
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'Local acceptance server has no address');
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    setDistribution,
    setAssetFailure,
    assetFailureRequests,
    observedAssetRequests,
    get observedAssetOverflow() {
      return observedAssetOverflow;
    },
    missingAssetResponses,
  };
}

async function closeServer(server: Server) {
  server.closeIdleConnections?.();
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function validateBundleFile(bundleRoot: string, relativePath: string) {
  const rootReal = await realpath(bundleRoot);
  const fileReal = await realpath(resolve(rootReal, relativePath));
  assert(isWithin(rootReal, fileReal), `Bundled asset escaped its root: ${relativePath}`);
  const fileStat = await stat(fileReal);
  assert(
    fileStat.isFile() && fileStat.size > 0,
    `Bundled asset is empty or not a file: ${relativePath}`
  );
  return fileReal;
}

async function loadApplication(page: Page, url: string) {
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

async function selectFixture(page: Page, filePath: string, inspectAnalysis = false) {
  if (inspectAnalysis) {
    await page.evaluate(() => {
      const observations: AnalysisObservation[] = [];
      const capture = () => {
        const state = document.querySelector('#app-state')?.textContent?.trim() ?? '';
        const dropzone = document.querySelector('[data-testid="dropzone"]');
        const progress = dropzone?.querySelector('[role="progressbar"]');
        const cancel = document.querySelector('[data-testid="dropzone-cancel-button"]');
        if (!state.startsWith('Analyzing') || !progress || !cancel) return;
        observations.push({
          state,
          busy: dropzone?.getAttribute('aria-busy'),
          ariaValueNow: progress.getAttribute('aria-valuenow'),
          dataProgress: progress.getAttribute('data-progress'),
          cancelLabel: cancel.getAttribute('aria-label'),
          cancelTitle: cancel.getAttribute('title'),
          diagnosticsCount: dropzone?.querySelectorAll('[data-testid="progress-diagnostics"]')
            .length,
          visibleZero: dropzone?.textContent?.includes('0%') ?? false,
        });
      };
      const observer = new MutationObserver(capture);
      observer.observe(document.body, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      globalThis.__wmcAnalysisInspector = { observer, observations };
    });
  }
  const input = page.locator('[data-testid="file-input"]');
  await input.setInputFiles(filePath);
  await page.waitForFunction(
    () => {
      const button = document.querySelector('[data-testid="convert-button"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    undefined,
    { timeout: 30_000 }
  );
  const metadata = page.locator('[data-testid="video-metadata"]');
  await metadata.waitFor({ state: 'visible', timeout: 30_000 });
  assert(
    (await metadata.textContent())?.includes(basename(filePath)),
    'Selected fixture name is absent from metadata'
  );
  if (!inspectAnalysis) return null;
  const observations = await page.evaluate(() => {
    const inspector = globalThis.__wmcAnalysisInspector;
    inspector?.observer.disconnect();
    Reflect.deleteProperty(globalThis, '__wmcAnalysisInspector');
    return inspector?.observations ?? [];
  });
  for (const observation of observations) {
    assert.equal(observation.busy, 'true', 'Analysis was not busy');
    assert.equal(
      observation.ariaValueNow,
      null,
      'Unknown analysis exposed a numeric progress value'
    );
    assert.equal(
      observation.dataProgress,
      null,
      'Unknown analysis exposed synthetic progress data'
    );
    assert.equal(observation.cancelLabel, 'Cancel analysis');
    assert.equal(observation.cancelTitle, 'Cancel analysis');
    assert.equal(observation.diagnosticsCount, 0, 'Analysis displayed conversion diagnostics');
    assert.equal(observation.visibleZero, false, 'Analysis displayed synthetic zero percent');
  }
  return { status: observations.length > 0 ? 'observed' : 'not-observed', observations };
}

async function chooseOption(page: Page, group: string, value: string) {
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
  assert.equal(
    await option.locator('input').isChecked(),
    true,
    `${group}=${value} was not selected`
  );
}

async function proceedIfPrompted(page: Page) {
  const confirmation = page.locator('[data-testid="modal-confirm-button"]');
  if (await confirmation.isVisible()) await confirmation.click();
}

async function waitForConversionOutcome(page: Page, timeout: number) {
  await page.waitForFunction(
    () => {
      const visible = (element: Element | null) =>
        element instanceof HTMLElement && element.getClientRects().length > 0;
      return (
        visible(document.querySelector('[data-testid="result-section"]')) ||
        visible(document.querySelector('[data-testid="error-display"]'))
      );
    },
    undefined,
    { timeout }
  );
  const error = page.locator('[data-testid="error-display"]');
  const errorVisible = await error.isVisible();
  const errorText = errorVisible ? (await error.textContent())?.trim() : null;
  assert.equal(errorVisible, false, `Conversion failed: ${errorText ?? 'unknown error'}`);
  await page.locator('[data-testid="result-section"]').waitFor({ state: 'visible' });
}

async function readDownload(download: Download) {
  const stream = await download.createReadStream();
  assert(stream, 'Browser download did not expose a readable stream');
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function validateOutput(
  bytes: Buffer,
  format: 'gif' | 'webp',
  expectedWidth = 80,
  expectedHeight = 45
) {
  assert(bytes.byteLength > 100, `${format.toUpperCase()} output is unexpectedly small`);
  if (format === 'gif') {
    assert(
      ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')),
      'GIF output has invalid magic bytes'
    );
    assert.equal(bytes.at(-1), 0x3b, 'GIF output is missing its trailer');
    assert.equal(bytes.readUInt16LE(6), expectedWidth, 'GIF output width is unexpected');
    assert.equal(bytes.readUInt16LE(8), expectedHeight, 'GIF output height is unexpected');
    return;
  }
  assert.equal(
    bytes.subarray(0, 4).toString('ascii'),
    'RIFF',
    'WebP output has invalid RIFF magic'
  );
  assert.equal(
    bytes.subarray(8, 12).toString('ascii'),
    'WEBP',
    'WebP output has invalid WEBP magic'
  );
  assert.equal(
    bytes.readUInt32LE(4) + 8,
    bytes.byteLength,
    'WebP RIFF size does not match its download'
  );
}

async function recordScreenshot(
  page: Page,
  outputRoot: string,
  fileName: string,
  artifacts: Artifact[],
  fullPage = true
) {
  const path = join(outputRoot, fileName);
  await page.screenshot({ path, fullPage, animations: 'disabled', caret: 'hide' });
  const bytes = await readFile(path);
  artifacts.push({
    kind: 'screenshot',
    file: fileName,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  });
}

async function recordChromeZoomScreenshot(
  page: Page,
  outputRoot: string,
  fileName: string,
  artifacts: Artifact[]
) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Page.bringToFront');
    // An omitted clip follows Chrome's real zoomed surface, not Playwright's pre-zoom viewport.
    const { data } = await session.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(data, 'base64');
    assert.equal(
      bytes.subarray(0, 8).toString('hex'),
      '89504e470d0a1a0a',
      'Chrome zoom capture is not a PNG'
    );
    await writeFile(join(outputRoot, fileName), bytes);
    artifacts.push({
      kind: 'screenshot',
      file: fileName,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
    return {
      method: 'cdp-page-capture-screenshot-no-clip',
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  } finally {
    await session.detach();
  }
}

async function readForcedColorsControlDiagnostics(page: Page) {
  return page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight, scrollY },
    controls: ['download-result-button', 'download-result-label', 'result-preview-toggle'].map(
      (testId) => {
        const element = document.querySelector(`[data-testid="${testId}"]`);
        if (!(element instanceof HTMLElement)) return { testId, present: false };
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          testId,
          present: true,
          textContent: element.textContent?.trim() ?? '',
          color: style.color,
          backgroundColor: style.backgroundColor,
          forcedColorAdjust: style.forcedColorAdjust,
          visibility: style.visibility,
          display: style.display,
          opacity: style.opacity,
          hasClientRect: element.getClientRects().length > 0,
          rect: {
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          },
        };
      }
    ),
  }));
}

async function readResultDiscoveryState(page: Page, format: 'gif' | 'webp') {
  return page.evaluate((expectedFormat) => {
    const button = document.querySelector('[data-testid="download-result-button"]');
    const image = document.querySelector('[data-testid="result-image"]');
    const summary = document.querySelector('[data-testid="result-summary"]');
    const activeElement = document.activeElement;
    const serializeRect = (element: Element | null) => {
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

async function convertSmallFixture(
  page: Page,
  baseUrl: string,
  fixturePath: string,
  format: 'gif' | 'webp',
  outputRoot: string,
  artifacts: Artifact[],
  reusePage = false
) {
  await page.setViewportSize(
    format === 'webp' ? { width: 390, height: 844 } : { width: 1280, height: 900 }
  );
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  if (!reusePage) await loadApplication(page, baseUrl);
  const analysis = await selectFixture(page, fixturePath, true);
  await chooseOption(page, 'format', format);
  await chooseOption(page, 'quality', 'low');
  await chooseOption(page, 'scale', '0.5');
  await page.locator('[data-testid="convert-button"]').click();
  await proceedIfPrompted(page);
  await waitForConversionOutcome(page, CONVERSION_TIMEOUT_MS);

  const previewToggle = page.locator('[data-testid="result-preview-toggle"]');
  await previewToggle.waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal(await previewToggle.getAttribute('aria-expanded'), 'false');
  assert.equal((await previewToggle.textContent())?.trim(), 'Show animated preview');
  assert.equal(await page.locator('[data-testid="result-image"]').count(), 0);
  assert.equal(await page.locator('[data-testid="result-preview-hidden"]').isVisible(), true);
  const downloadHref = await page
    .locator('[data-testid="download-result-button"]')
    .getAttribute('href');
  assert(downloadHref?.startsWith('blob:'), 'Reduced-motion result has no download URL');
  assert.equal(
    await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
    true,
    'Reduced-motion emulation was not active in the product page'
  );

  let initialDiscovery: Awaited<ReturnType<typeof readResultDiscoveryState>>;
  try {
    await page.waitForFunction(
      () => {
        const button = document.querySelector('[data-testid="download-result-button"]');
        if (!(button instanceof HTMLElement) || document.activeElement !== button) return false;
        const rect = button.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight;
      },
      undefined,
      { timeout: 5_000 }
    );
    initialDiscovery = await readResultDiscoveryState(page, format);
  } catch (error) {
    initialDiscovery = await readResultDiscoveryState(page, format);
    const diagnosticFile = `${PROFILE_ID}-${format}-discovery-failure.json`;
    const diagnosticBytes = Buffer.from(`${JSON.stringify(initialDiscovery, null, 2)}\n`);
    await writeFile(join(outputRoot, diagnosticFile), diagnosticBytes);
    artifacts.push({
      kind: 'diagnostic',
      file: diagnosticFile,
      bytes: diagnosticBytes.byteLength,
      sha256: sha256(diagnosticBytes),
    });
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Result discovery failed for ${format}: ${JSON.stringify(initialDiscovery)}; ${reason}`
    );
  }
  assert.equal(initialDiscovery.button.focused, true, 'Download did not receive completion focus');
  assert.equal(initialDiscovery.summary.present, true, 'Reduced-motion result summary is missing');
  assert.equal(initialDiscovery.summary.beforeDownload, true);
  assert.equal(initialDiscovery.image.present, false, 'Reduced-motion result auto-played');
  await recordScreenshot(
    page,
    outputRoot,
    `${PROFILE_ID}-${format}-reduced-default.png`,
    artifacts
  );

  await previewToggle.focus();
  await page.keyboard.press('Enter');
  assert.equal(await previewToggle.getAttribute('aria-expanded'), 'true');
  assert.equal((await previewToggle.textContent())?.trim(), 'Hide animated preview');
  assert.equal(await previewToggle.evaluate((button) => document.activeElement === button), true);
  const preview = page.locator('[data-testid="result-image"]');
  await preview.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const image = document.querySelector('[data-testid="result-image"]');
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
    },
    undefined,
    { timeout: 30_000 }
  );
  const dimensions = await preview.evaluate((image) => {
    if (!(image instanceof HTMLImageElement)) throw new Error('Result preview is not an image');
    return { width: image.naturalWidth, height: image.naturalHeight };
  });
  assert.deepEqual(dimensions, { width: 80, height: 45 });

  const discovery = await readResultDiscoveryState(page, format);
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
  await page.waitForFunction(
    () => {
      const image = document.querySelector('[data-testid="result-image"]');
      if (!(image instanceof HTMLImageElement) || image.naturalWidth <= 0) return false;
      const rect = image.getBoundingClientRect();
      return Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight) > 1.1;
    },
    undefined,
    { timeout: 5_000 }
  );
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
  await page.waitForFunction(
    () => {
      const image = document.querySelector('[data-testid="result-image"]');
      if (!(image instanceof HTMLImageElement) || image.naturalWidth <= 0) return false;
      const rect = image.getBoundingClientRect();
      return Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight) <= 1.01;
    },
    undefined,
    { timeout: 5_000 }
  );
  await settleVisualState(page);

  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
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
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
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
  await recordScreenshot(page, outputRoot, `${PROFILE_ID}-${format}-dark.png`, artifacts);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce', forcedColors: 'active' });
  await settleVisualState(page);
  const forcedColors: {
    active: boolean;
    horizontalOverflow: number;
    previewToggleVisible: boolean;
    downloadVisible: boolean;
    beforeFullPageScreenshot?: Awaited<ReturnType<typeof readForcedColorsControlDiagnostics>>;
    beforeViewportScreenshot?: Awaited<ReturnType<typeof readForcedColorsControlDiagnostics>>;
    downloadLabelContrast?: Awaited<ReturnType<typeof readResultMetadataContrast>>;
  } = await page.evaluate(() => ({
    active: matchMedia('(forced-colors: active)').matches,
    horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    previewToggleVisible:
      (document.querySelector('[data-testid="result-preview-toggle"]')?.getClientRects().length ??
        0) > 0,
    downloadVisible:
      (document.querySelector('[data-testid="download-result-button"]')?.getClientRects().length ??
        0) > 0,
  }));
  assert.equal(forcedColors.active, true, 'Forced Colors emulation was not active');
  assert(forcedColors.horizontalOverflow <= 1, 'Forced Colors result overflowed horizontally');
  assert.equal(forcedColors.previewToggleVisible, true);
  assert.equal(forcedColors.downloadVisible, true);
  // DOM styles and geometry are diagnostics, not proof that text pixels are legible.
  const beforeFullPageScreenshot = await readForcedColorsControlDiagnostics(page);
  forcedColors.beforeFullPageScreenshot = beforeFullPageScreenshot;
  const downloadControl = beforeFullPageScreenshot.controls.find(
    (control) => control.testId === 'download-result-button'
  );
  const downloadLabel = beforeFullPageScreenshot.controls.find(
    (control) => control.testId === 'download-result-label'
  );
  assert(downloadControl, 'Forced Colors download control diagnostics are missing');
  assert(downloadLabel, 'Forced Colors download label diagnostics are missing');
  assert.equal(downloadLabel.present, true, 'Forced Colors download label is missing');
  assert.equal(downloadControl.forcedColorAdjust, 'none');
  assert.equal(downloadLabel.forcedColorAdjust, 'none');
  assert.equal(downloadLabel.color, downloadControl.color);
  assert.equal(parseCssColor(downloadLabel.backgroundColor).alpha, 0);
  const downloadLabelContrast = await readResultMetadataContrast(
    page,
    '[data-testid="download-result-label"]'
  );
  forcedColors.downloadLabelContrast = downloadLabelContrast;
  assert.equal(downloadLabelContrast.opacity, 1);
  assert(downloadLabelContrast.fontSizePx >= 12);
  assert(
    downloadLabelContrast.ratio >= 4.5,
    'Forced Colors download label and background have insufficient computed contrast'
  );
  await recordScreenshot(page, outputRoot, `${PROFILE_ID}-${format}-forced-colors.png`, artifacts);
  await page.locator('[data-testid="download-result-button"]').scrollIntoViewIfNeeded();
  await page.locator('[data-testid="result-preview-toggle"]').scrollIntoViewIfNeeded();
  await settleVisualState(page);
  forcedColors.beforeViewportScreenshot = await readForcedColorsControlDiagnostics(page);
  await recordScreenshot(
    page,
    outputRoot,
    `${PROFILE_ID}-${format}-forced-colors-viewport.png`,
    artifacts,
    false
  );
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce', forcedColors: 'none' });
  await settleVisualState(page);
  await recordScreenshot(page, outputRoot, `${PROFILE_ID}-${format}-result.png`, artifacts);

  await previewToggle.focus();
  await page.keyboard.press('Space');
  assert.equal(await previewToggle.getAttribute('aria-expanded'), 'false');
  assert.equal((await previewToggle.textContent())?.trim(), 'Show animated preview');
  assert.equal(await previewToggle.evaluate((button) => document.activeElement === button), true);
  assert.equal(await page.locator('[data-testid="result-image"]').count(), 0);
  assert.equal(await page.locator('[data-testid="result-preview-hidden"]').isVisible(), true);
  assert.equal(
    await page.locator('[data-testid="download-result-button"]').getAttribute('href'),
    downloadHref,
    'Hiding the preview revoked or replaced the download URL'
  );
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  assert.equal(
    await page.locator('[data-testid="result-image"]').count(),
    0,
    'A motion preference change overrode the explicit hide choice'
  );
  await recordScreenshot(page, outputRoot, `${PROFILE_ID}-${format}-hidden.png`, artifacts);

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

  return {
    id: `h264-to-${format}`,
    status: 'passed',
    analysis,
    preview: dimensions,
    previewControl: {
      reducedMotionDefaultHidden: true,
      keyboardShowAndHide: true,
      explicitHideSurvivedPreferenceChange: true,
      imageDetachedWhenHidden: true,
      downloadUrlRetainedWhenHidden: true,
      downloadedWhileHidden: true,
    },
    presentation: {
      actual: actualPresentation,
      fit: fitPresentation,
      metadataContrast: {
        light: lightMetadataContrast,
        dark: darkMetadataContrast,
      },
      forcedColors,
    },
    download: {
      file: outputFile,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      focusedAndVisibleOnCompletion: initialDiscovery.button.focused,
      discovery: { initial: initialDiscovery, shown: discovery },
    },
  };
}

function formatTrimTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remaining = (seconds - minutes * 60).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return `${minutes}:${remaining.padStart(2, '0')}`;
}

async function applyContractSettings(page: Page, contract: OutputContractCase) {
  await chooseOption(page, 'format', contract.format);
  await chooseOption(page, 'quality', contract.settings.quality);
  await chooseOption(page, 'scale', contract.settings.scale);
  await chooseOption(page, 'smart-frame-skip', contract.settings.smartFrameSkip);
  if (contract.settings.trimStart > 0 || contract.settings.trimEnd > 0) {
    const start = page.locator('#trim-start-input');
    const end = page.locator('#trim-end-input');
    await start.fill(formatTrimTime(contract.settings.trimStart));
    await start.press('Enter');
    await end.fill(formatTrimTime(contract.settings.trimEnd));
    await end.press('Enter');
  }
}

async function convertOutputContract(
  page: Page,
  baseUrl: string,
  fixturePath: string,
  contract: OutputContractCase,
  markers: Record<string, number[]>,
  outputRoot: string,
  artifacts: Artifact[]
) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await loadApplication(page, baseUrl);
  assert.equal(
    await page.evaluate(() => typeof VideoDecoder === 'function'),
    true,
    `${contract.id}: stable browser explicitly lacks VideoDecoder`
  );
  await selectFixture(page, fixturePath);
  await applyContractSettings(page, contract);
  await page.evaluate(() => globalThis.__wmcPressureProbe?.reset());
  await page.locator('[data-testid="convert-button"]').click();
  await proceedIfPrompted(page);
  await waitForConversionOutcome(page, CONVERSION_TIMEOUT_MS);

  const preview = page.locator('[data-testid="result-image"]');
  await preview.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const image = document.querySelector('[data-testid="result-image"]');
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
    },
    undefined,
    { timeout: 30_000 }
  );
  assert.deepEqual(
    await preview.evaluate((image) => {
      if (!(image instanceof HTMLImageElement)) throw new Error('Result preview is not an image');
      return { width: image.naturalWidth, height: image.naturalHeight };
    }),
    { width: contract.expected.width, height: contract.expected.height },
    `${contract.id}: preview geometry`
  );

  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await page.locator('[data-testid="download-result-button"]').click();
  const bytes = await readDownload(await downloadPromise);
  const outputFile = `${PROFILE_ID}-${contract.id}.${contract.format}`;
  await writeFile(join(outputRoot, outputFile), bytes);
  artifacts.push({
    kind: 'output-contract-media',
    file: outputFile,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  });
  validateOutput(bytes, contract.format, contract.expected.width, contract.expected.height);
  const decoded = await verifyAnimatedOutput(page, bytes, contract, markers);
  const gifDelaysCs = contract.format === 'gif' ? parseGifDelaysCs(bytes) : null;
  if (gifDelaysCs) {
    assert(
      gifDelaysCs.every((delay) => delay >= 2 && delay <= 200),
      `${contract.id}: an emitted record is not viewer-safe`
    );
  }
  const exactOracle =
    contract.id === 'cfr-trim-gif'
      ? await compareAnimatedOutputExact(page, bytes, bytes, contract.format)
      : null;
  return {
    id: `output-contract-${contract.id}`,
    status: 'passed',
    fixture: contract.fixture,
    format: contract.format,
    decoded,
    gifDelaysCs,
    exactOracle,
    output: { file: outputFile, bytes: bytes.byteLength, sha256: sha256(bytes) },
  };
}

async function exerciseUiDisclosures(
  page: Page,
  baseUrl: string,
  fixturePath: string,
  outputRoot: string,
  artifacts: Artifact[]
) {
  await loadApplication(page, baseUrl);
  await selectFixture(page, fixturePath);

  const metadata = page.locator('[data-testid="video-metadata"]');
  const metadataSummary = metadata.locator('summary');
  assert.equal(await metadata.evaluate((element) => element.tagName), 'DETAILS');
  assert.equal(
    await metadata.evaluate((element) => element instanceof HTMLDetailsElement && element.open),
    false
  );
  assert(
    (await metadataSummary.evaluate((element) => element.getBoundingClientRect().height)) >= 44,
    'Metadata disclosure summary is smaller than the minimum interaction target'
  );
  await metadataSummary.focus();
  await page.keyboard.press('Enter');
  assert.equal(
    await metadata.evaluate((element) => element instanceof HTMLDetailsElement && element.open),
    true
  );
  assert.equal(
    await metadataSummary.evaluate((element) => document.activeElement === element),
    true
  );
  assert(
    (await metadata.textContent())?.includes(basename(fixturePath)),
    'Metadata disclosure omitted the selected fixture name'
  );

  const advanced = page.locator('[data-testid="advanced-settings"]');
  const advancedSummary = advanced.locator('summary');
  assert.equal(await advanced.evaluate((element) => element.tagName), 'DETAILS');
  assert.equal(
    await advanced.evaluate((element) => element instanceof HTMLDetailsElement && element.open),
    false
  );
  assert(
    (await advancedSummary.evaluate((element) => element.getBoundingClientRect().height)) >= 44,
    'Advanced-settings summary is smaller than the minimum interaction target'
  );
  await advancedSummary.focus();
  await page.keyboard.press('Enter');
  assert.equal(
    await advanced.evaluate((element) => element instanceof HTMLDetailsElement && element.open),
    true
  );
  assert.equal(
    await advancedSummary.evaluate((element) => document.activeElement === element),
    true
  );

  await chooseOption(page, 'smart-frame-skip', 'off');
  const offInput = page.locator('[data-testid="option-smart-frame-skip-off"] input');
  const lowOption = page.locator('[data-testid="option-smart-frame-skip-low"]');
  const lowInput = lowOption.locator('input');
  await offInput.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(
    await lowInput.isChecked(),
    true,
    'Keyboard did not select the next frame-skip mode'
  );
  const lowLabel = await lowOption.getAttribute('aria-label');
  assert(lowLabel, 'Frame-skip option has no accessible label');
  assert(
    (await advancedSummary.textContent())?.includes(lowLabel),
    'Advanced-settings summary did not reflect the keyboard selection'
  );

  await chooseOption(page, 'format', 'webp');
  await chooseOption(page, 'quality', 'high');
  await chooseOption(page, 'scale', '1');
  const startInput = page.locator('#trim-start-input');
  const endInput = page.locator('#trim-end-input');
  await startInput.fill('0:00.3');
  await startInput.press('Enter');
  await endInput.fill('0:00.7');
  await endInput.press('Enter');
  const trimBeforeSharing = {
    start: await startInput.inputValue(),
    end: await endInput.inputValue(),
  };
  const sharing = page.locator('[data-testid="sharing-settings"]');
  const sharingSummary = sharing.locator('summary');
  const sharingButton = sharing.locator('[data-testid="sharing-settings-button"]');
  const convertButton = page.locator('[data-testid="convert-button"]');
  assert.equal(await sharing.evaluate((element) => element.tagName), 'DETAILS');
  assert.equal(
    await sharing.evaluate((element) => element instanceof HTMLDetailsElement && element.open),
    false
  );
  assert.equal(await sharingButton.isVisible(), false, 'Collapsed sharing action is visible');
  assert.equal(
    await convertButton.evaluate((convert, sharingSelector) => {
      const details = document.querySelector(sharingSelector);
      return details
        ? Boolean(convert.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING)
        : false;
    }, '[data-testid="sharing-settings"]'),
    true,
    'Sharing guidance does not follow the primary Convert action'
  );
  await sharingSummary.click();
  assert.equal(await sharingButton.isVisible(), true, 'Sharing action did not expand');
  await sharingButton.click();
  assert.equal(await page.locator('[data-testid="option-format-webp"] input').isChecked(), true);
  assert.equal(await page.locator('[data-testid="option-quality-low"] input').isChecked(), true);
  assert.equal(await page.locator('[data-testid="option-scale-0.5"] input').isChecked(), true);
  assert.equal(await lowInput.isChecked(), true, 'Sharing action changed frame skip');
  assert.deepEqual(
    { start: await startInput.inputValue(), end: await endInput.inputValue() },
    trimBeforeSharing,
    'Sharing action changed the selected trim range'
  );
  assert.equal(await sharingButton.isDisabled(), true, 'Applied sharing action remained enabled');
  assert.equal(
    await convertButton.isEnabled(),
    true,
    'Sharing action did not leave conversion ready'
  );
  assert.equal(await page.locator('[data-testid="result-section"]').isVisible(), false);
  await chooseOption(page, 'quality', 'high');
  assert.equal(
    await sharingButton.isEnabled(),
    true,
    'Manual override did not re-enable sharing action'
  );

  await recordScreenshot(page, outputRoot, `${PROFILE_ID}-disclosures.png`, artifacts);
  await advancedSummary.focus();
  await page.keyboard.press('Space');
  assert.equal(
    await advanced.evaluate((element) => element instanceof HTMLDetailsElement && element.open),
    false
  );
  await metadataSummary.focus();
  await page.keyboard.press('Space');
  assert.equal(
    await metadata.evaluate((element) => element instanceof HTMLDetailsElement && element.open),
    false
  );

  return {
    id: 'native-disclosures-keyboard',
    status: 'passed',
    metadataDisclosure: true,
    advancedDisclosure: true,
    keyboardSelection: 'smart-frame-skip-low',
    sharingSettings: {
      preserved: ['format-webp', 'trim-range', 'smart-frame-skip-low'],
      applied: ['quality-low', 'scale-0.5'],
      manualOverride: 'quality-high',
      automaticConversion: false,
    },
  };
}

async function exerciseLongLocaleResult(page: Page, outputRoot: string, artifacts: Artifact[]) {
  await page.setViewportSize({ width: 800, height: 800 });
  const toggle = page.locator('[data-testid="result-preview-toggle"]');
  const download = page.locator('[data-testid="download-result-button"]');
  assert.equal(await page.locator('[data-testid="result-section"]').isVisible(), true);
  if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
  const downloadHref = await download.getAttribute('href');
  assert(downloadHref?.startsWith('blob:'), 'Localized result has no Blob download');

  const observations = [];
  for (const { locale, dir, showLabel } of [
    { locale: 'es', dir: 'ltr', showLabel: 'Mostrar vista previa animada' },
    { locale: 'ar', dir: 'rtl', showLabel: 'إظهار المعاينة المتحركة' },
  ]) {
    await page.locator('[data-testid="language-selector"]').selectOption(locale);
    await page.waitForFunction(
      ({ locale, showLabel }) =>
        document.documentElement.lang === locale &&
        document.querySelector('[data-testid="result-preview-toggle"]')?.textContent?.trim() ===
          showLabel,
      { locale, showLabel }
    );
    const layout = await page.evaluate(() => {
      const controls = [
        document.querySelector('[data-testid="result-preview-toggle"]'),
        document.querySelector('[data-testid="download-result-button"]'),
        document.querySelector('[data-testid="language-selector"]'),
      ];
      return {
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        viewportWidth: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        controls: controls.map((control) => {
          const rect = control?.getBoundingClientRect();
          return {
            text: control?.textContent?.trim() ?? null,
            left: rect?.left ?? null,
            right: rect?.right ?? null,
            height: rect?.height ?? null,
            fontSizePx: control ? Number.parseFloat(getComputedStyle(control).fontSize) : null,
          };
        }),
      };
    });
    assert.equal(layout.lang, locale);
    assert.equal(layout.dir, dir);
    assert(
      layout.documentWidth <= layout.viewportWidth + 1,
      `${locale} result overflows horizontally`
    );
    for (const [index, control] of layout.controls.entries()) {
      assert(control.left !== null && control.left >= -1, `${locale} control is clipped at start`);
      assert(
        control.right !== null && control.right <= layout.viewportWidth + 1,
        `${locale} control is clipped at end`
      );
      assert(
        control.height !== null && control.height >= (index < 2 ? 44 : 28),
        `${locale} control is too short`
      );
      assert(
        control.fontSizePx !== null && control.fontSizePx >= 12,
        `${locale} control text is too small`
      );
    }
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('[data-testid="result-image"]').count(), 0);
    assert.equal(await download.getAttribute('href'), downloadHref);
    await settleVisualState(page);
    await recordScreenshot(
      page,
      outputRoot,
      `${PROFILE_ID}-${locale}-narrow-result.png`,
      artifacts
    );
    observations.push(layout);
  }

  return { id: 'long-locale-narrow-result', status: 'passed', observations };
}

async function exerciseBrowserZoom(
  browser: Browser,
  page: Page,
  bundleRoot: string,
  baseUrl: string,
  fixturePath: string,
  outputRoot: string,
  artifacts: Artifact[]
) {
  const userAgent = await page.evaluate(() => navigator.userAgent);
  if (userAgent.includes('Edg/')) {
    return { id: 'browser-zoom-200', status: 'not-run', reason: 'Chrome Settings adapter only' };
  }
  const bundle: unknown = JSON.parse(await readFile(join(bundleRoot, 'bundle.json'), 'utf8'));
  assert(isRecord(bundle), 'Invalid Windows bundle');
  const { mode } = bundle;
  assert(mode === 'desktop' || mode === 'headless-diagnostic', 'Unsupported Windows bundle mode');
  const profilePath = await mkdtemp(join(bundleRoot, ZOOM_PROFILE_PREFIX));
  let zoomContext: import('@playwright/test').BrowserContext | undefined;
  let zoomPage: Page | undefined;
  let settingsPage: Page | undefined;
  let previousZoom: string | undefined;
  let baseline: { devicePixelRatio: number; width: number; scale: number | undefined } | undefined;
  let baselineScreenshot: Awaited<ReturnType<typeof recordChromeZoomScreenshot>> | undefined;
  let result: object | undefined;
  let primaryError: unknown;
  let caught = false;
  let stage = 'launch-owned-chrome';
  let contextClosed = false;
  let profileRemoved = false;
  let zoomRestored = false;
  const cleanupErrors: unknown[] = [];
  const pageErrors: string[] = [];
  try {
    zoomContext = await browser.browserType().launchPersistentContext(profilePath, {
      channel: 'chrome',
      headless: mode === 'headless-diagnostic',
      args: ['--mute-audio'],
      acceptDownloads: true,
      colorScheme: 'light',
      locale: 'en-US',
      reducedMotion: 'reduce',
      viewport: { width: 1280, height: 900 },
    });
    zoomPage = zoomContext.pages()[0] ?? (await zoomContext.newPage());
    zoomPage.on('pageerror', (error) => pageErrors.push(error.message));
    stage = 'load-same-production-bundle';
    const appLoad = await loadApplication(zoomPage, baseUrl);
    assert.equal(
      appLoad.crossOriginIsolated,
      true,
      'Owned Chrome profile lost COOP/COEP isolation'
    );

    stage = 'convert-owned-gif';
    await selectFixture(zoomPage, fixturePath);
    await chooseOption(zoomPage, 'format', 'gif');
    await chooseOption(zoomPage, 'quality', 'low');
    await chooseOption(zoomPage, 'scale', '0.5');
    await zoomPage.locator('[data-testid="convert-button"]').click();
    await proceedIfPrompted(zoomPage);
    await waitForConversionOutcome(zoomPage, CONVERSION_TIMEOUT_MS);
    const toggle = zoomPage.locator('[data-testid="result-preview-toggle"]');
    const download = zoomPage.locator('[data-testid="download-result-button"]');
    await toggle.waitFor({ state: 'visible' });
    assert.equal(
      await toggle.getAttribute('aria-expanded'),
      'false',
      'Reduced-motion GIF started animating in the owned profile'
    );
    assert.equal(await zoomPage.locator('[data-testid="result-image"]').count(), 0);
    const href = await download.getAttribute('href');
    assert(href?.startsWith('blob:'), 'Owned GIF result has no Blob download');

    stage = 'select-arabic-product-locale';
    await zoomPage.locator('[data-testid="language-selector"]').selectOption('ar');
    await zoomPage.waitForFunction(
      () =>
        document.documentElement.lang === 'ar' &&
        document.documentElement.dir === 'rtl' &&
        document.querySelector('[data-testid="result-preview-toggle"]')?.textContent?.trim() ===
          'إظهار المعاينة المتحركة'
    );

    stage = 'set-real-browser-zoom';
    settingsPage = await zoomContext.newPage();
    await settingsPage.goto('chrome://settings/appearance');
    const zoom = settingsPage.locator('select#zoomLevel');
    previousZoom = await zoom.inputValue();
    assert.equal(Number(previousZoom), 1, 'Owned Chrome profile did not start at 100% zoom');
    baseline = await zoomPage.evaluate(() => ({
      devicePixelRatio,
      width: innerWidth,
      scale: visualViewport?.scale,
    }));
    baselineScreenshot = await recordChromeZoomScreenshot(
      zoomPage,
      outputRoot,
      `${PROFILE_ID}-browser-zoom-100.png`,
      artifacts
    );
    await zoom.selectOption('2');
    await zoomPage.bringToFront();
    await zoomPage.waitForFunction(
      (before) =>
        Math.abs(devicePixelRatio / before.devicePixelRatio - 2) < 0.02 &&
        Math.abs(innerWidth / before.width - 0.5) < 0.02 &&
        Math.abs((visualViewport?.scale ?? 0) - 1) < 0.02,
      baseline,
      { timeout: 10_000 }
    );

    stage = 'exercise-zoomed-result';
    assert.equal(await download.getAttribute('href'), href, 'Browser zoom replaced the Blob URL');
    await toggle.focus();
    await zoomPage.keyboard.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await zoomPage.locator('[data-testid="result-image"]').waitFor({ state: 'visible' });
    await zoomPage.keyboard.press('Space');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await zoomPage.locator('[data-testid="result-image"]').count(), 0);
    assert.equal(await download.getAttribute('href'), href);
    const observation = await zoomPage.evaluate(() => ({
      devicePixelRatio,
      width: innerWidth,
      height: innerHeight,
      scale: visualViewport?.scale,
      language: document.documentElement.lang,
      direction: document.documentElement.dir,
      horizontalOverflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    assert(observation.horizontalOverflow <= 1, '200% browser zoom caused horizontal overflow');
    assert.equal(observation.language, 'ar');
    assert.equal(observation.direction, 'rtl');
    for (const control of [toggle, download]) {
      await control.focus();
      const geometry = await control.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          width: innerWidth,
          fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
          focused: document.activeElement === element,
        };
      });
      assert(
        geometry.left >= -1 && geometry.right <= geometry.width + 1,
        'A zoomed result control was clipped horizontally'
      );
      assert(geometry.focused && geometry.fontSize >= 12);
    }
    await toggle.scrollIntoViewIfNeeded();
    await download.scrollIntoViewIfNeeded();
    await settleVisualState(zoomPage);
    const screenshotControls = await zoomPage.evaluate(() => {
      const controls = ['result-preview-toggle', 'download-result-button'];
      return controls.map((testId) => {
        const element = document.querySelector(`[data-testid="${testId}"]`);
        const rect = element?.getBoundingClientRect();
        return {
          testId,
          left: rect?.left ?? null,
          right: rect?.right ?? null,
          top: rect?.top ?? null,
          bottom: rect?.bottom ?? null,
          width: rect?.width ?? null,
          height: rect?.height ?? null,
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
        };
      });
    });
    for (const control of screenshotControls) {
      assert(
        control.width !== null &&
          control.width > 0 &&
          control.height !== null &&
          control.height > 0 &&
          control.left !== null &&
          control.left >= -1 &&
          control.right !== null &&
          control.right <= control.viewportWidth + 1 &&
          control.top !== null &&
          control.top >= -1 &&
          control.bottom !== null &&
          control.bottom <= control.viewportHeight + 1,
        `${control.testId} is outside the zoom screenshot viewport`
      );
    }
    const zoomScreenshot = await recordChromeZoomScreenshot(
      zoomPage,
      outputRoot,
      `${PROFILE_ID}-browser-zoom-200.png`,
      artifacts
    );
    // CDP captures the native surface while Playwright may emulate the page's DPR.
    assert.equal(zoomScreenshot.width, baselineScreenshot.width);
    assert.equal(zoomScreenshot.height, baselineScreenshot.height);

    stage = 'download-zoomed-gif';
    const downloadPromise = zoomPage.waitForEvent('download', { timeout: 30_000 });
    await download.click();
    const browserDownload = await downloadPromise;
    assert(browserDownload.suggestedFilename().toLowerCase().endsWith('.gif'));
    const bytes = await readDownload(browserDownload);
    validateOutput(bytes, 'gif');
    const outputFile = `${PROFILE_ID}-browser-zoom-gif.gif`;
    await writeFile(join(outputRoot, outputFile), bytes);
    artifacts.push({
      kind: 'zoomed-converted-media',
      file: outputFile,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
    assert.deepEqual(pageErrors, [], 'Owned Chrome result page emitted errors');
    result = {
      id: 'browser-zoom-200',
      status: 'passed',
      factor: 2,
      method: 'owned-persistent-chrome-settings-page',
      baseline,
      observation,
      language: 'ar',
      previewHiddenAfterKeyboard: true,
      screenshotControls,
      baselineScreenshot,
      zoomScreenshot,
      download: { file: outputFile, bytes: bytes.byteLength, sha256: sha256(bytes) },
    };
  } catch (error) {
    primaryError = error;
    caught = true;
  } finally {
    if (previousZoom !== undefined && settingsPage) {
      try {
        await settingsPage.locator('select#zoomLevel').selectOption(previousZoom);
        if (baseline) {
          assert(zoomPage);
          await zoomPage.bringToFront();
          await zoomPage.waitForFunction(
            (before) =>
              Math.abs(devicePixelRatio / before.devicePixelRatio - 1) < 0.02 &&
              Math.abs(innerWidth / before.width - 1) < 0.02 &&
              Math.abs((visualViewport?.scale ?? 0) - 1) < 0.02,
            baseline,
            { timeout: 10_000 }
          );
        }
        zoomRestored = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (settingsPage) {
      try {
        await settingsPage.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (zoomContext) {
      try {
        await zoomContext.close();
        contextClosed = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (contextClosed) {
      try {
        assert.equal(dirname(profilePath), bundleRoot, 'Zoom profile escaped the bundle root');
        assert(
          basename(profilePath).startsWith(ZOOM_PROFILE_PREFIX),
          'Zoom profile is not task-owned'
        );
        await rm(profilePath, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
        profileRemoved = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (primaryError || cleanupErrors.length) {
      const diagnostic = {
        stage,
        error:
          primaryError === undefined
            ? null
            : primaryError instanceof Error
              ? primaryError.message
              : String(primaryError),
        cleanupErrors: cleanupErrors.map((error) =>
          error instanceof Error ? error.message : String(error)
        ),
        profileName: basename(profilePath),
        contextClosed,
        profileRemoved,
        zoomRestored,
      };
      try {
        await writeFile(
          join(outputRoot, `${PROFILE_ID}-browser-zoom-failure.json`),
          `${JSON.stringify(diagnostic, null, 2)}\n`
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (cleanupErrors.length) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors].filter((error) => error !== undefined),
      'Owned Chrome zoom validation or cleanup failed'
    );
  }
  if (caught) throw primaryError;
  assert(result);
  return { ...result, cleanup: { contextClosed, profileRemoved, zoomRestored } };
}

export async function installCancellationInspector(page: InspectorPage) {
  return page.evaluate(() => {
    const visible = (element: Element) =>
      element instanceof HTMLElement && element.getClientRects().length > 0;
    const progressBars = [...document.querySelectorAll('[role="progressbar"]')].filter(visible);
    const progressBar = progressBars[0];
    const progress = Number(progressBar?.getAttribute('data-progress'));
    if (!(progressBar instanceof HTMLElement) || progressBars.length !== 1 || !(progress > 0)) {
      throw new Error('Cancellation inspector requires one visible non-zero progress bar');
    }

    const inspector: NonNullable<typeof globalThis.__wmcCancellationInspector> = {
      progressBar,
      progress,
      observation: null,
      observer: null,
    };
    const capture = () => {
      const stateText = document.querySelector('#app-state')?.textContent?.trim() ?? '';
      if (!stateText.toLowerCase().startsWith('cancelling')) return;
      const currentProgressBars = [...document.querySelectorAll('[role="progressbar"]')].filter(
        visible
      );
      const progressSample = {
        values: currentProgressBars.map((element) => Number(element.getAttribute('data-progress'))),
        ariaValueNow: currentProgressBars[0]?.getAttribute('aria-valuenow') ?? null,
        sameProgressElement: currentProgressBars[0] === inspector.progressBar,
      };
      if (inspector.observation) {
        const samples = inspector.observation.progressSamples;
        const previous = samples.at(-1);
        if (
          !previous ||
          previous.values.length !== progressSample.values.length ||
          previous.values.some((value, index) => value !== progressSample.values[index]) ||
          previous.ariaValueNow !== progressSample.ariaValueNow ||
          previous.sameProgressElement !== progressSample.sameProgressElement
        ) {
          if (samples.length < 128) samples.push(progressSample);
          else inspector.observation.sampleOverflow = true;
        }
        return;
      }
      const settingsCancel = document.querySelector('[data-testid="stop-conversion-button"]');
      const dropzoneCancel = document.querySelector('[data-testid="dropzone-cancel-button"]');
      const dropzone = document.querySelector('[data-testid="dropzone"]');
      const progressBusyRegion = currentProgressBars[0]?.closest('[aria-busy]');
      const diagnostics = dropzone?.querySelector('[data-testid="progress-diagnostics"]');
      const diagnosticsSummary = diagnostics?.querySelector('summary');
      const statusMessage = dropzone?.querySelector('[data-testid="progress-status-message"]');
      inspector.observation = {
        stateText,
        progressBeforeClick: inspector.progress,
        sameProgressElement: progressSample.sameProgressElement,
        progressValues: progressSample.values,
        progressSamples: [progressSample],
        sampleOverflow: false,
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
        progressBusy:
          progressBusyRegion &&
          progressBusyRegion !== dropzone &&
          dropzone?.contains(progressBusyRegion)
            ? progressBusyRegion.getAttribute('aria-busy')
            : null,
        progressAriaValueNow: progressSample.ariaValueNow,
        diagnosticsCount:
          dropzone?.querySelectorAll('[data-testid="progress-diagnostics"]').length ?? 0,
        diagnosticsOpen: diagnostics instanceof HTMLDetailsElement ? diagnostics.open : null,
        diagnosticsSummaryFontSizePx: diagnosticsSummary
          ? Number.parseFloat(getComputedStyle(diagnosticsSummary).fontSize)
          : null,
        statusFontSizePx: statusMessage
          ? Number.parseFloat(getComputedStyle(statusMessage).fontSize)
          : null,
      };
    };
    const observer = new MutationObserver(capture);
    inspector.observer = observer;
    observer.observe(document.body, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    globalThis.__wmcCancellationInspector = inspector;
    return progress;
  });
}

export async function readCancellationInspector(page: InspectorPage) {
  return page.evaluate(() => {
    const inspector = globalThis.__wmcCancellationInspector;
    inspector?.observer?.disconnect();
    Reflect.deleteProperty(globalThis, '__wmcCancellationInspector');
    return inspector?.observation ?? null;
  });
}

async function inspectRestoredPreview(page: Page) {
  const preview = page.locator('#selection-preview-video');
  await preview.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(
    () => {
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
    },
    undefined,
    { timeout: 10_000 }
  );
  await settleVisualState(page);

  const firstFrame = await preview.evaluate((video) => {
    if (!(video instanceof HTMLVideoElement)) throw new Error('Restored preview is not a video');
    const element = video;
    const rect = element.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Restored preview canvas has no 2D context');
    context.drawImage(element, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaquePixels = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if ((pixels[index] ?? 0) > 0) opaquePixels++;
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
  });
  assert(firstFrame.currentTime < 0.05, 'Restored preview did not return to its first frame');
  assert.equal(firstFrame.opacity, '1', 'Restored preview transition did not settle');
  assert.equal(firstFrame.opaquePixels, 64, 'Restored first frame was not drawable');
  assert(firstFrame.videoWidth > 0 && firstFrame.videoHeight > 0);
  assert(firstFrame.renderedWidth > 0 && firstFrame.renderedHeight > 0);

  const knownContentPixels = await preview.evaluate(async (video) => {
    if (!(video instanceof HTMLVideoElement)) throw new Error('Restored preview is not a video');
    const element = video;
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Restored preview canvas has no 2D context');

    const seek = (time: number) =>
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Restored preview seek timed out')),
          3_000
        );
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
        if ((pixels[index] ?? 0) + (pixels[index + 1] ?? 0) + (pixels[index + 2] ?? 0) > 24) {
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
  const knownContentTime = await preview.evaluate((video) => {
    if (!(video instanceof HTMLVideoElement)) throw new Error('Restored preview is not a video');
    return video.currentTime;
  });
  return { firstFrame, knownContentPixels, knownContentTime };
}

async function exerciseCancellation(
  page: Page,
  baseUrl: string,
  fixturePath: string,
  outputRoot: string,
  artifacts: Artifact[]
) {
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
    assert.fail(
      `High-motion setup failed: ${(await error.textContent())?.trim() ?? 'unknown error'}`
    );
  }

  const progress = page.locator('[data-testid="dropzone"] [role="progressbar"]');
  const progressOutcome = await Promise.race([
    page
      .waitForFunction(
        () => {
          const element = document.querySelector('[data-testid="dropzone"] [role="progressbar"]');
          return Number(element?.getAttribute('data-progress')) > 0;
        },
        undefined,
        { timeout: CANCELLATION_TIMEOUT_MS }
      )
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
    assert.fail(
      `High-motion setup failed: ${(await error.textContent())?.trim() ?? 'unknown error'}`
    );
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

  await page.waitForFunction(
    () => {
      const convert = document.querySelector('[data-testid="convert-button"]');
      const stopButton = document.querySelector('[data-testid="stop-conversion-button"]');
      return convert instanceof HTMLButtonElement && !convert.disabled && !stopButton;
    },
    undefined,
    { timeout: 30_000 }
  );
  assert.equal(
    await result.isVisible(),
    false,
    'Cancelled conversion unexpectedly produced a result'
  );
  const errorVisible = await error.isVisible();
  const errorText = errorVisible ? (await error.textContent())?.trim() : null;
  assert.equal(
    errorVisible,
    false,
    `Cancellation produced an error: ${errorText ?? 'unknown error'}`
  );
  const cancellationUi = await readCancellationInspector(page);
  const cancellationFile = `${PROFILE_ID}-cancellation-state.json`;
  const cancellationBytes = Buffer.from(`${JSON.stringify(cancellationUi, null, 2)}\n`);
  await writeFile(join(outputRoot, cancellationFile), cancellationBytes);
  artifacts.push({
    kind: 'diagnostic',
    file: cancellationFile,
    bytes: cancellationBytes.byteLength,
    sha256: sha256(cancellationBytes),
  });
  assert(cancellationUi, 'Cancellation state was not observable by the UI inspector');
  assert.equal(cancellationUi.sameProgressElement, true);
  const progressAtCancellation = cancellationUi.progressValues[0];
  assert(progressAtCancellation !== undefined);
  assert(Number.isFinite(progressAtCancellation) && progressAtCancellation > 0);
  assert.equal(cancellationUi.progressBeforeClick, progressBeforeCancel);
  assert.equal(cancellationUi.sampleOverflow, false, 'Cancellation progress samples overflowed');
  assert.deepEqual(
    cancellationUi.progressSamples,
    [
      {
        values: [progressAtCancellation],
        ariaValueNow: String(progressAtCancellation),
        sameProgressElement: true,
      },
    ],
    'Progress changed while the UI was cancelling'
  );
  assert.equal(cancellationUi.visibleProgressBarCount, 1);
  assert.equal(cancellationUi.legacyProgressCount, 0);
  assert.equal(cancellationUi.settingsCancel.disabled, true);
  assert.equal(cancellationUi.dropzoneCancel.disabled, true);
  assert.equal(cancellationUi.settingsCancel.label, cancellationUi.stateText);
  assert.equal(cancellationUi.dropzoneCancel.label, cancellationUi.stateText);
  assert.equal(cancellationUi.dropzoneBusy, 'true');
  assert.equal(cancellationUi.progressBusy, 'true');
  assert.equal(cancellationUi.progressAriaValueNow, String(progressAtCancellation));
  assert.equal(cancellationUi.diagnosticsCount, 1);
  assert.equal(cancellationUi.diagnosticsOpen, false);
  assert(
    cancellationUi.diagnosticsSummaryFontSizePx !== null &&
      cancellationUi.diagnosticsSummaryFontSizePx >= 14
  );
  assert(cancellationUi.statusFontSizePx !== null && cancellationUi.statusFontSizePx >= 14);
  const previewRecovery = await inspectRestoredPreview(page);
  await recordScreenshot(page, outputRoot, `${PROFILE_ID}-cancelled.png`, artifacts);
  return {
    id: 'cancel-high-motion',
    status: 'passed',
    attempted: true,
    effective: true,
    progressBeforeCancel,
    progressAtCancellation,
    cancellationUi,
    previewRecovery,
  };
}

async function observeEnvironment(page: Page, browser: Browser) {
  const pageObservation = await page.evaluate(() => {
    let webglRenderer = null;
    try {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('webgl');
      const extension = context?.getExtension('WEBGL_debug_renderer_info');
      if (context && extension)
        webglRenderer = context.getParameter(extension.UNMASKED_RENDERER_WEBGL);
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

async function loadPublicTargets(bundleRoot: string) {
  const path = await validateBundleFile(bundleRoot, PUBLIC_TARGET);
  const config: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert(isRecord(config), 'Invalid public target configuration');
  assert.equal(config.schemaVersion, 1, 'Unsupported public target schema');
  assert(
    Array.isArray(config.targets) && config.targets.length <= 2,
    'Expected at most two public targets'
  );
  const targets: PublicTarget[] = [];
  for (const target of config.targets) {
    assert(isRecord(target), 'Invalid public target');
    assert(typeof target.url === 'string');
    const url = new URL(target.url);
    assert.equal(url.protocol, 'https:', 'Public target must use HTTPS');
    assert(
      url.hostname === 'wasm-motion-converter.pages.dev' ||
        /^[a-z0-9-]+\.wasm-motion-converter\.pages\.dev$/.test(url.hostname),
      'Public target is outside the owned Pages project'
    );
    assert.equal(url.pathname, '/');
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    assert(
      typeof target.sourceSha === 'string' && /^[a-f0-9]{40}$/.test(target.sourceSha),
      'Public target source SHA is invalid'
    );
    assert(
      typeof target.deploymentId === 'string' && /^[a-f0-9-]{36}$/.test(target.deploymentId),
      'Public target deployment ID is invalid'
    );
    targets.push({
      url: target.url,
      sourceSha: target.sourceSha,
      deploymentId: target.deploymentId,
    });
  }
  return targets;
}

async function exercisePublicTarget(
  browser: Browser,
  target: PublicTarget,
  targetIndex: number,
  fixturePath: string,
  cancellationFixture: string,
  outputRoot: string,
  artifacts: Artifact[]
) {
  const publicDir = `public-${targetIndex + 1}-${target.deploymentId}`;
  const publicRoot = join(outputRoot, publicDir);
  const publicArtifacts: Artifact[] = [];
  let context: BrowserContext | undefined;
  let primaryFailure: unknown;
  let caught = false;
  let closeFailure: unknown;
  const errors: {
    page: string[];
    console: string[];
    request: string[];
    csp: string[];
    uploads: string[];
    external: string[];
  } = {
    page: [],
    console: [],
    request: [],
    csp: [],
    uploads: [],
    external: [],
  };
  const browserInternalRequests: string[] = [];
  const assets = new Map<
    string,
    Promise<
      | {
          url: string;
          status: number;
          headers: Record<string, string>;
          bytes: Buffer;
          error?: never;
        }
      | {
          url: string;
          status: number;
          headers: Record<string, string>;
          error: string;
          bytes?: never;
        }
    >
  >();
  const workers: string[] = [];
  const origin = new URL(target.url).origin;
  const resourceTiming = (subject: Page) =>
    subject.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .filter(
          (entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming
        )
        .map((entry) => ({
          name: new URL(entry.name).pathname,
          initiatorType: entry.initiatorType,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
        }))
    );
  const captureAssetRequests = () => {
    const ownedContext = context;
    assert(ownedContext);
    const requests: PlaywrightRequest[] = [];
    const onRequest = (request: PlaywrightRequest) => {
      const url = new URL(request.url());
      if (url.origin === origin && /^\/assets\/.*\.(?:js|css|wasm)$/.test(url.pathname))
        requests.push(request);
    };
    ownedContext.on('request', onRequest);
    return async () => {
      ownedContext.off('request', onRequest);
      return Promise.all(
        requests.map(async (request) => {
          const response = await request.response();
          assert(response, `Public asset request had no response: ${request.url()}`);
          return {
            path: new URL(request.url()).pathname,
            resourceType: request.resourceType(),
            status: response.status(),
            sizes: await request.sizes(),
          };
        })
      );
    };
  };
  try {
    await mkdir(publicRoot, { recursive: true });
    context = await browser.newContext({
      acceptDownloads: true,
      locale: 'en-US',
      serviceWorkers: 'block',
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    page.on('worker', (worker) => workers.push(new URL(worker.url()).pathname));
    page.on('pageerror', (error) => errors.page.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.console.push(message.text());
    });
    context.on('requestfailed', (request) => {
      if (request.url().startsWith('blob:') && request.failure()?.errorText === 'net::ERR_ABORTED')
        return;
      errors.request.push(`${request.failure()?.errorText ?? 'unknown'} ${request.url()}`);
    });
    context.on('request', (request) => {
      const url = new URL(request.url());
      if (
        url.protocol === 'edge:' &&
        ['downloads-hub', 'resources', 'fileicon'].includes(url.hostname)
      ) {
        browserInternalRequests.push(`${url.protocol}//${url.hostname}${url.pathname}`);
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method()))
        errors.uploads.push(`${request.method()} ${request.url()}`);
      if (!request.url().startsWith('blob:') && url.origin !== origin)
        errors.external.push(request.url());
    });
    context.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      if (/^\/assets\/.*\.(?:js|css|wasm)$/.test(path)) {
        const snapshot = {
          url: response.url(),
          status: response.status(),
          headers: response.headers(),
        };
        // Preserve bodies before later navigation invalidates their CDP request IDs.
        assets.set(
          path,
          response.body().then(
            (bytes) => ({ ...snapshot, bytes }),
            (error) => ({ ...snapshot, error: String(error) })
          )
        );
      }
    });
    await context.addInitScript(() => {
      globalThis.__wmcPublicViolations = [];
      globalThis.document.addEventListener('securitypolicyviolation', (event) => {
        globalThis.__wmcPublicViolations.push(`${event.effectiveDirective}: ${event.blockedURI}`);
      });
    });
    const metadataResponse = await context.request.get(
      new URL('/deployment-state.json', target.url).href,
      { maxRedirects: 0 }
    );
    assert.equal(metadataResponse.status(), 200, 'Public deployment metadata is unavailable');
    assert.match(
      metadataResponse.headers()['content-type'] ?? '',
      /^application\/json\b/i,
      'Public deployment metadata has the wrong MIME type'
    );
    const metadata: unknown = await metadataResponse.json();
    assertPublicMetadata(metadata);
    assert.equal(metadata.schemaVersion, 1);
    assert.equal(
      metadata.sourceSha,
      target.sourceSha,
      'Public source differs from provider deployment source'
    );
    assert(/^[a-f0-9]{40}$/.test(metadata.treeSha));
    assert(/^[a-f0-9]{40}$/.test(metadata.coreSha));
    assert.equal(metadata.branch, 'master');
    assert.equal(typeof metadata.version, 'string');
    assert(Array.isArray(metadata.files) && metadata.files.length > 0);
    const served: { path: string; size: number; sha256: string }[] = [];
    for (const file of metadata.files) {
      assert(
        typeof file.path === 'string' &&
          !file.path.startsWith('/') &&
          !file.path.split('/').includes('..'),
        'Invalid metadata asset path'
      );
      assert(Number.isSafeInteger(file.size) && file.size >= 0);
      assert(/^[a-f0-9]{64}$/.test(file.sha256));
      const path =
        file.path === 'index.html' ? '/' : file.path === '404.html' ? '/404' : `/${file.path}`;
      const response: APIResponse = await context.request.get(new URL(path, target.url).href, {
        maxRedirects: 0,
      });
      assert.equal(response.status(), 200, `Public asset ${file.path} did not return 200`);
      const bytes = await response.body();
      assert.equal(bytes.byteLength, file.size, `Public asset size differs: ${file.path}`);
      assert.equal(sha256(bytes), file.sha256, `Public asset bytes differ: ${file.path}`);
      served.push({ path: file.path, size: bytes.byteLength, sha256: sha256(bytes) });
    }
    const representative = metadata.files.find((file) => file.path.endsWith('.js'));
    assert(representative, 'Public metadata contains no JavaScript asset');
    const representativeUrl = new URL(`/${representative.path}`, target.url).href;
    const initialAsset = await context.request.get(representativeUrl);
    assert.equal(initialAsset.status(), 200);
    assert.match(initialAsset.headers()['cache-control'] ?? '', /\bimmutable\b/i);
    const etag = initialAsset.headers().etag;
    assert(etag, 'Public asset has no ETag for conditional revalidation');
    const revalidatedAsset = await context.request.get(representativeUrl, {
      headers: { 'If-None-Match': etag },
    });
    assert.equal(revalidatedAsset.status(), 304, 'Public asset did not preserve ETag revalidation');
    for (const extension of ['js', 'css', 'wasm']) {
      const missing: APIResponse = await context.request.get(
        new URL(`/assets/missing-289.${extension}`, target.url).href
      );
      assert.equal(missing.status(), 404, `Missing ${extension} asset was not a 404`);
      assert(
        !/\bimmutable\b/i.test(missing.headers()['cache-control'] ?? ''),
        `Missing ${extension} asset received immutable caching`
      );
    }
    const document = await page.goto(target.url);
    assert.equal(document?.status(), 200);
    assert.match(document.headers()['content-type'] ?? '', /^text\/html\b/i);
    assert.equal(document.headers()['cross-origin-opener-policy'], 'same-origin');
    assert.equal(document.headers()['cross-origin-embedder-policy'], 'require-corp');
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    await page.waitForLoadState('networkidle');
    assert.equal(await page.evaluate(() => crossOriginIsolated), true);
    await recordScreenshot(page, publicRoot, 'initial.png', publicArtifacts);
    const timing = () =>
      page.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .filter(
            (entry): entry is PerformanceResourceTiming =>
              entry instanceof PerformanceResourceTiming && entry.name.endsWith('.js')
          )
          .map((entry) => ({
            name: new URL(entry.name).pathname,
            transferSize: entry.transferSize,
            encodedBodySize: entry.encodedBodySize,
            decodedBodySize: entry.decodedBodySize,
          }))
      );
    const cold = await timing();
    const coldPositive = cold.filter((entry) => entry.transferSize > 0);
    assert(coldPositive.length > 0, 'Public cold load has no positive JS transfer timing');
    assert(
      coldPositive.reduce((sum, entry) => sum + entry.transferSize, 0) < 150_000,
      'Public cold JS transfer exceeded the unchanged 150000-byte budget'
    );
    await page.reload();
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    await page.waitForLoadState('networkidle');
    const warm = await timing();

    await selectFixture(page, fixturePath);
    await chooseOption(page, 'format', 'gif');
    await chooseOption(page, 'quality', 'low');
    await chooseOption(page, 'scale', '0.5');
    await page.evaluate(() => performance.clearResourceTimings());
    const finishGifRequests = captureAssetRequests();
    await page.locator('[data-testid="convert-button"]').click();
    await proceedIfPrompted(page);
    await waitForConversionOutcome(page, CONVERSION_TIMEOUT_MS);
    const [gifDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-testid="download-result-button"]').click(),
    ]);
    const gifBytes = await readDownload(gifDownload);
    validateOutput(gifBytes, 'gif');
    assert(workers.length > 0, 'Public GIF conversion never started a module worker');
    await page.waitForLoadState('networkidle');
    const firstGifTraffic = {
      pageResourceTiming: await resourceTiming(page),
      networkAssetRequests: await finishGifRequests(),
    };
    assert(
      firstGifTraffic.networkAssetRequests.some((request) => workers.includes(request.path)),
      'Public GIF traffic did not record its module worker request'
    );
    await recordScreenshot(page, publicRoot, 'gif-result.png', publicArtifacts);

    await loadApplication(page, target.url);
    const documentIdentity = await page.evaluate(() => performance.timeOrigin);
    const budgetFixture = makeMp4BudgetFixture(await readFile(fixturePath));
    await page.locator('[data-testid="file-input"]').setInputFiles({
      name: 'public-invalid.mp4',
      mimeType: 'video/mp4',
      buffer: budgetFixture.bytes,
    });
    const metadataError = page.locator('[data-testid="error-display"]');
    await metadataError.waitFor({ state: 'visible', timeout: 10_000 });
    assert((await metadataError.textContent())?.includes('ISOBMFF sample metadata'));
    await page
      .locator(
        '[data-testid="error-select-different-button"], [data-testid="error-select-different-fallback-button"]'
      )
      .click();
    await page.locator('[data-testid="file-input"]').setInputFiles(fixturePath);
    await page.locator('[data-testid="convert-button"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-testid="convert-button"]').isEnabled(), true);
    assert.equal(
      await page.evaluate(() => performance.timeOrigin),
      documentIdentity,
      'Public invalid-input recovery reloaded the document'
    );
    const cancellation = await exerciseCancellation(
      page,
      target.url,
      cancellationFixture,
      publicRoot,
      publicArtifacts
    );
    assert.equal(
      cancellation.effective,
      true,
      'Public cancellation did not stop active conversion'
    );

    const wasmPage = await context.newPage();
    wasmPage.on('pageerror', (error) => errors.page.push(error.message));
    wasmPage.on('console', (message) => {
      if (message.type() === 'error') errors.console.push(message.text());
    });
    await wasmPage.addInitScript(() => {
      Object.defineProperty(OffscreenCanvas.prototype, 'convertToBlob', {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        value: class UnavailableWorker {
          constructor() {
            throw new DOMException('Force WASM fallback', 'NotSupportedError');
          }
        },
      });
    });
    await loadApplication(wasmPage, target.url);
    await selectFixture(wasmPage, fixturePath);
    await chooseOption(wasmPage, 'format', 'webp');
    await chooseOption(wasmPage, 'quality', 'low');
    await chooseOption(wasmPage, 'scale', '0.5');
    await wasmPage.evaluate(() => performance.clearResourceTimings());
    const finishWebpRequests = captureAssetRequests();
    await wasmPage.locator('[data-testid="convert-button"]').click();
    await proceedIfPrompted(wasmPage);
    await waitForConversionOutcome(wasmPage, CONVERSION_TIMEOUT_MS);
    const [webpDownload] = await Promise.all([
      wasmPage.waitForEvent('download'),
      wasmPage.locator('[data-testid="download-result-button"]').click(),
    ]);
    const webpBytes = await readDownload(webpDownload);
    validateOutput(webpBytes, 'webp');
    await wasmPage.waitForLoadState('networkidle');
    await recordScreenshot(wasmPage, publicRoot, 'webp-wasm-result.png', publicArtifacts);
    const firstWebpTraffic = {
      pageResourceTiming: await resourceTiming(wasmPage),
      networkAssetRequests: await finishWebpRequests(),
    };
    const wasmAssets = [...assets.entries()].filter(([path]) => path.endsWith('.wasm'));
    assert(wasmAssets.length > 0, 'Public WebP fallback loaded no WASM');
    assert(
      firstWebpTraffic.networkAssetRequests.some((request) => request.path.endsWith('.wasm')),
      'Public WebP traffic did not record its WASM request'
    );
    for (const [path, pending] of assets) {
      const response = await pending;
      assert('bytes' in response, `Executable ${path} body capture failed: ${response.error}`);
      assert.equal(response.status, 200, `Executable ${response.url} status`);
      const type = path.endsWith('.wasm')
        ? /^application\/wasm\b/i
        : path.endsWith('.css')
          ? /^text\/css\b/i
          : /^(?:text|application)\/javascript\b/i;
      assert.match(response.headers['content-type'] ?? '', type, `Executable ${path} MIME`);
      const bytes = response.bytes;
      assert(bytes.length > 0, `Executable ${path} has no body`);
      assert(
        !/^\s*<!doctype html/i.test(bytes.subarray(0, 256).toString('utf8')),
        `Executable ${path} is an HTML fallback`
      );
      if (path.endsWith('.wasm')) {
        assert.equal(bytes.subarray(0, 4).toString('hex'), '0061736d', 'WASM magic is invalid');
        await wasmPage.evaluate(
          async (value) => WebAssembly.compile(new Uint8Array(value)),
          [...bytes]
        );
      }
    }
    errors.csp = [
      ...(await page.evaluate(() => globalThis.__wmcPublicViolations)),
      ...(await wasmPage.evaluate(() => globalThis.__wmcPublicViolations)),
    ];
    assert.deepEqual(errors, {
      page: [],
      console: [],
      request: [],
      csp: [],
      uploads: [],
      external: [],
    });
    artifacts.push(
      ...publicArtifacts.map((artifact) => ({
        ...artifact,
        file: `${publicDir}-${artifact.file}`,
      }))
    );
    return {
      id: 'public-source-bound-smoke',
      status: 'passed',
      deploymentId: target.deploymentId,
      url: target.url,
      sourceSha: target.sourceSha,
      metadata: {
        treeSha: metadata.treeSha,
        coreSha: metadata.coreSha,
        version: metadata.version,
        files: served,
      },
      coldJs: cold,
      warmJs: warm,
      firstGifTraffic,
      firstWebpTraffic,
      workerPaths: workers,
      wasmPaths: wasmAssets.map(([path]) => path),
      cancellation,
      gif: { bytes: gifBytes.length, sha256: sha256(gifBytes) },
      webp: { bytes: webpBytes.length, sha256: sha256(webpBytes) },
      browserInternalRequests,
    };
  } catch (error) {
    primaryFailure = error;
    caught = true;
    throw error;
  } finally {
    try {
      await context?.close();
    } catch (error) {
      closeFailure = error;
    }
    await writeFile(
      join(publicRoot, 'diagnostics.json'),
      JSON.stringify(
        {
          target: target.url,
          sourceSha: target.sourceSha,
          deploymentId: target.deploymentId,
          errors,
          observedAssets: [...assets.keys()],
          workers,
          browserInternalRequests,
          failure: primaryFailure ? String(primaryFailure) : null,
          cleanupErrors: closeFailure ? [String(closeFailure)] : [],
        },
        null,
        2
      )
    ).catch(() => {});
    // The shared guest collector reads flat output files, including failures.
    // Keep each target's namespace while preserving every generated byte.
    const files = await readdir(publicRoot, { withFileTypes: true });
    assert(
      files.every((file) => file.isFile()),
      'Public evidence contains a nested directory'
    );
    for (const file of files) {
      await rename(join(publicRoot, file.name), join(outputRoot, `${publicDir}-${file.name}`));
    }
    await rmdir(publicRoot);
    // Cleanup failure is raised only when no primary failure exists.
    if (closeFailure && !caught) throw closeFailure;
  }
}

/** Run the WMC Windows stable-browser acceptance profile. */
type MediaNetworkDiagnostics = {
  pageErrors: string[];
  consoleErrors: string[];
  failedRequests: { url: string; error: string }[];
  failedResponses: { status: number; url: string }[];
};
type MediaProfileFailure = { error: unknown };

function describeMediaFailure(error: unknown): string {
  try {
    return String(error).slice(0, 1000);
  } catch {
    return 'Unprintable thrown value';
  }
}

async function writeMediaNetworkDiagnostics(
  outputRoot: string,
  diagnostics: MediaNetworkDiagnostics,
  failure: MediaProfileFailure | undefined,
  cleanupErrors: string[]
): Promise<void> {
  await writeFile(
    join(outputRoot, 'network-diagnostics.json'),
    JSON.stringify(
      {
        ...diagnostics,
        primaryError: failure ? describeMediaFailure(failure.error) : null,
        cleanupErrors,
      },
      null,
      2
    )
  );
}

export async function assertMediaNetworkDiagnostics(
  outputRoot: string,
  diagnostics: MediaNetworkDiagnostics
): Promise<void> {
  await writeMediaNetworkDiagnostics(outputRoot, diagnostics, undefined, []);
  const { pageErrors, consoleErrors, failedRequests, failedResponses } = diagnostics;
  assert.deepEqual(pageErrors, [], `Unhandled page errors: ${pageErrors.join(' | ')}`);
  assert.deepEqual(consoleErrors, [], `Console errors: ${consoleErrors.join(' | ')}`);
  assert.deepEqual(failedRequests, [], `Failed requests: ${JSON.stringify(failedRequests)}`);
  assert.deepEqual(
    failedResponses,
    [],
    `Failed HTTP responses: ${JSON.stringify(failedResponses)}`
  );
}

/** Finish this profile's owned resources without replacing its original failure. */
export async function finishMediaProfile({
  context,
  server,
  outputRoot,
  diagnostics,
  failure,
}: {
  context: Pick<BrowserContext, 'close'> | undefined;
  server: Server | undefined;
  outputRoot: string;
  diagnostics: MediaNetworkDiagnostics;
  failure: MediaProfileFailure | undefined;
}): Promise<void> {
  const cleanupErrors: string[] = [];
  try {
    await context?.close();
  } catch (error) {
    cleanupErrors.push(`context close: ${describeMediaFailure(error)}`);
  }
  try {
    if (server) await closeServer(server);
  } catch (error) {
    cleanupErrors.push(`server close: ${describeMediaFailure(error)}`);
  }
  try {
    await writeMediaNetworkDiagnostics(outputRoot, diagnostics, failure, cleanupErrors);
  } catch (error) {
    cleanupErrors.push(`diagnostics write: ${describeMediaFailure(error)}`);
  }
  if (failure) throw failure.error;
  if (cleanupErrors.length) throw new Error(cleanupErrors.join('; '));
}

export async function run({
  browser,
  root,
  output,
}: {
  browser: Browser;
  root: string;
  output: string;
}) {
  assert(
    browser && typeof browser.newContext === 'function',
    'run.browser must be a launched Playwright Browser'
  );
  assert.equal(typeof root, 'string', 'run.root must be the bundle root path');
  assert.equal(typeof output, 'string', 'run.output must be the evidence directory path');

  const bundleRoot = await realpath(resolve(root));
  const recoveryConfigPath = 'validation/windows/inputs/recovery.json';
  let recoveryPresent = false;
  try {
    recoveryPresent = (await stat(resolve(bundleRoot, recoveryConfigPath))).isFile();
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (recoveryPresent) {
    const selector = await validateBundleFile(bundleRoot, recoveryConfigPath);
    const config: unknown = JSON.parse(await readFile(selector, 'utf8'));
    const outputRoot = resolve(output);
    await mkdir(outputRoot, { recursive: true });
    return runRecoveryBuilds({
      browser,
      bundleRoot,
      outputRoot,
      config,
      startStaticServer,
      closeServer,
      validateBundleFile,
    });
  }
  const appUpdateConfig = 'validation/windows/inputs/app-update.json';
  let appUpdatePresent = false;
  try {
    appUpdatePresent = (await stat(resolve(bundleRoot, appUpdateConfig))).isFile();
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (appUpdatePresent) {
    const configPath = await validateBundleFile(bundleRoot, appUpdateConfig);
    const config: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    assert(isRecord(config), 'Invalid application-update bundle configuration');
    assert.deepEqual(
      Object.keys(config).sort(),
      [
        'schemaVersion',
        'mode',
        'buildA',
        'baseline',
        'baselineSourceSha',
        'baselineTreeSha',
        'cleanupBaseline',
        'cleanupBaselineSourceSha',
        'cleanupBaselineTreeSha',
      ].sort(),
      'Invalid application-update bundle configuration keys'
    );
    assert(config.schemaVersion === 1);
    assert(config.mode === 'application-update');
    assert(config.buildA === 'validation/windows/inputs/deployment-a');
    assert(config.baseline === 'validation/windows/prior-dist');
    assert(config.cleanupBaseline === 'validation/windows/inputs/cleanup-baseline');
    assert(
      typeof config.baselineSourceSha === 'string' &&
        /^[a-f0-9]{40}$/.test(config.baselineSourceSha)
    );
    assert(
      typeof config.baselineTreeSha === 'string' && /^[a-f0-9]{40}$/.test(config.baselineTreeSha)
    );
    assert(config.cleanupBaselineSourceSha === '6d2463937b46df629c406500bb06685ac115a98f');
    assert(config.cleanupBaselineTreeSha === '3a5c34857aa9e5a9d3dfbb7429d648004fd2fe44');
    const outputRoot = resolve(output);
    await mkdir(outputRoot, { recursive: true });
    return runAppUpdate({
      browser,
      bundleRoot,
      outputRoot,
      config: {
        buildA: config.buildA,
        baseline: config.baseline,
        baselineSourceSha: config.baselineSourceSha,
        baselineTreeSha: config.baselineTreeSha,
        cleanupBaseline: config.cleanupBaseline,
        cleanupBaselineSourceSha: config.cleanupBaselineSourceSha,
        cleanupBaselineTreeSha: config.cleanupBaselineTreeSha,
      },
      startStaticServer,
      closeServer,
      validateBundleFile,
    });
  }
  const outputRoot = resolve(output);
  await mkdir(outputRoot, { recursive: true });
  let context: BrowserContext | undefined;
  let server: Server | undefined;
  let failure: MediaProfileFailure | undefined;
  const artifacts: Artifact[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: { url: string; error: string }[] = [];
  const failedResponses: { status: number; url: string }[] = [];
  const diagnostics = { pageErrors, consoleErrors, failedRequests, failedResponses };

  try {
    const smallFixture = await validateBundleFile(bundleRoot, SMALL_FIXTURE);
    const publicTargets = await loadPublicTargets(bundleRoot);
    const cancellationFixture = await validateBundleFile(bundleRoot, CANCELLATION_FIXTURE);
    const outputContractPath = await validateBundleFile(bundleRoot, OUTPUT_CONTRACT);
    const outputContract: unknown = JSON.parse(await readFile(outputContractPath, 'utf8'));
    assertOutputContractConfig(outputContract);
    assert.equal(outputContract.schemaVersion, 1, 'Unsupported output contract schema');
    assert(Array.isArray(outputContract.cases) && outputContract.cases.length > 0);
    const contractFixtures = new Map<string, string>();
    for (const contract of outputContract.cases) {
      assert.equal(typeof contract.id, 'string');
      assert(['gif', 'webp'].includes(contract.format));
      contractFixtures.set(contract.id, await validateBundleFile(bundleRoot, contract.fixture));
    }
    const fixtureFor = (contract: OutputContractCase) => {
      const fixture = contractFixtures.get(contract.id);
      assert(fixture, `Missing bundled fixture for ${contract.id}`);
      return fixture;
    };
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
    assert.equal(
      appLoad.crossOriginIsolated,
      true,
      'COOP/COEP did not produce a cross-origin-isolated app'
    );

    const checks: object[] = [{ id: 'app-load', status: 'passed', ...appLoad }];
    checks.push(
      await exerciseOfflineRecovery(
        browser,
        started.url,
        outputRoot,
        started.setDistribution,
        bundleRoot,
        smallFixture,
        cancellationFixture
      )
    );
    for (const file of ['offline-app-recovery.png', 'offline-static-recovery.png']) {
      const bytes = await readFile(join(outputRoot, file));
      artifacts.push({ kind: 'screenshot', file, bytes: bytes.byteLength, sha256: sha256(bytes) });
    }
    const budgetFixture = makeMp4BudgetFixture(await readFile(smallFixture));
    const documentIdentity = await page.evaluate(() => performance.timeOrigin);
    const rejectedAt = performance.now();
    await page.locator('[data-testid="file-input"]').setInputFiles({
      name: 'sample-budget.mp4',
      mimeType: 'video/mp4',
      buffer: budgetFixture.bytes,
    });
    const metadataError = page.locator('[data-testid="error-display"]');
    await metadataError.waitFor({ state: 'visible', timeout: 10_000 });
    const errorText = await metadataError.textContent();
    assert(errorText?.includes('ISOBMFF sample metadata') && errorText.includes('sample count'));
    const selectDifferent = page.locator(
      '[data-testid="error-select-different-button"], [data-testid="error-select-different-fallback-button"]'
    );
    assert.equal(await selectDifferent.isEnabled(), true);
    const rejectionMs = performance.now() - rejectedAt;
    assert(
      rejectionMs < 10_000,
      'Over-budget metadata did not settle within the bounded observation'
    );
    await recordScreenshot(page, outputRoot, 'mp4-sample-budget-error.png', artifacts);
    await selectDifferent.click();
    await page.locator('[data-testid="choose-file-button"]').waitFor({ state: 'visible' });
    const recoveredGif = await convertSmallFixture(
      page,
      started.url,
      smallFixture,
      'gif',
      outputRoot,
      artifacts,
      true
    );
    assert.equal(
      await page.evaluate(() => performance.timeOrigin),
      documentIdentity,
      'Recovery must use the same application document'
    );
    assert.equal(await metadataError.isVisible(), false);
    checks.push({
      id: 'mp4-sample-budget-recovery',
      status: 'passed',
      fixtureBytes: budgetFixture.bytes.length,
      fixtureSha256: sha256(budgetFixture.bytes),
      originalCount: budgetFixture.originalCount,
      declaredCount: budgetFixture.declaredCount,
      rejectionMs,
      sameDocument: true,
      subsequentGifDownload: recoveredGif.status,
      accounting:
        'Logical-count rejection before size-table expansion; browser heap/RSS not measured',
    });
    checks.push(recoveredGif);
    checks.push(
      await convertSmallFixture(page, started.url, smallFixture, 'webp', outputRoot, artifacts)
    );
    checks.push(
      await exerciseCancellation(page, started.url, cancellationFixture, outputRoot, artifacts)
    );
    checks.push(
      await exerciseUiDisclosures(page, started.url, smallFixture, outputRoot, artifacts)
    );
    for (const contract of outputContract.cases) {
      const check = await convertOutputContract(
        page,
        started.url,
        fixtureFor(contract),
        contract,
        outputContract.markers,
        outputRoot,
        artifacts
      );
      checks.push(check);
      if (contract.id === 'short-tail-gif') {
        const playback = await collectGifPlayback({
          context,
          gifBytes: await readFile(join(outputRoot, check.output.file)),
          outputRoot,
          artifacts,
          label: 'short-tail-live-playback',
        });
        assertGifPlayback(playback, { expectedCycleMs: 120 });
        checks.push({ id: 'gif-ordinary-image-playback', status: 'passed', observation: playback });
      }
    }

    // A separate page keeps this controlled preflight pressure observation out
    // of the normal corpus and preserves the real application option round-trip.
    const pressurePage = await context.newPage();
    try {
      await pressurePage.addInitScript(() => {
        Object.defineProperty(performance, 'memory', {
          configurable: true,
          value: {
            usedJSHeapSize: 8 * 1024 * 1024,
            totalJSHeapSize: 16 * 1024 * 1024,
            jsHeapSizeLimit: 16 * 1024 * 1024,
          },
        });
        const probe: PressureProbe = (globalThis.__wmcPressureProbe = {
          nativeDecoded: 0,
          submittedWebp: 0,
          terminal: null,
          startRatios: [],
          reset() {
            this.nativeDecoded = 0;
            this.submittedWebp = 0;
            this.terminal = null;
            this.startRatios = [];
          },
        });
        const NativeDecoder = VideoDecoder;
        globalThis.VideoDecoder = class ObservedDecoder extends NativeDecoder {
          constructor(config: VideoDecoderInit) {
            super({
              ...config,
              output(frame) {
                probe.nativeDecoded++;
                config.output(frame);
              },
            });
          }
        };
        const NativeWorker = Worker;
        globalThis.Worker = class ObservedWorker extends NativeWorker {
          constructor(scriptURL: string | URL, options?: WorkerOptions) {
            super(scriptURL, options);
            this.addEventListener('message', ({ data }) => {
              if (data?.type === 'progress' && data.percent === 100) {
                probe.terminal = {
                  decodedFrames: data.decodedFrames,
                  selectedFrames: data.selectedFrames,
                  encodedFrames: data.encodedFrames,
                  emittedFrames: data.emittedFrames,
                };
              }
            });
          }
          override postMessage(
            message: unknown,
            options?: StructuredSerializeOptions | Transferable[]
          ) {
            if (
              message &&
              typeof message === 'object' &&
              'type' in message &&
              message.type === 'start'
            ) {
              if (
                !('options' in message) ||
                !message.options ||
                typeof message.options !== 'object' ||
                !('memoryPressureCadenceRatio' in message.options) ||
                typeof message.options.memoryPressureCadenceRatio !== 'number'
              )
                throw new Error('Start message omitted memory pressure cadence ratio');
              probe.startRatios.push(message.options.memoryPressureCadenceRatio);
            } else if (
              message &&
              typeof message === 'object' &&
              'rgbaData' in message &&
              message.rgbaData instanceof Uint8Array
            ) {
              probe.submittedWebp++;
            }
            if (Array.isArray(options)) return super.postMessage(message, options);
            return super.postMessage(message, options);
          }
        };
      });
      for (const format of ['gif', 'webp']) {
        const contract: OutputContractCase | undefined = outputContract.cases.find(
          (candidate) => candidate.id === `pressure-21fps-${format}`
        );
        assert(contract, 'Missing pressure cadence output contract');
        const check = await convertOutputContract(
          pressurePage,
          started.url,
          fixtureFor(contract),
          {
            ...contract,
            id: `critical-${contract.id}`,
            expected: {
              ...contract.expected,
              ...outputContract.pressureExpectations[format],
            },
          },
          outputContract.markers,
          outputRoot,
          artifacts
        );
        const counts = await pressurePage.evaluate(() => {
          const { reset: _reset, ...observation } = globalThis.__wmcPressureProbe;
          return observation;
        });
        if (format === 'gif') {
          assert.equal(counts.terminal?.decodedFrames, 21);
          assert.equal(counts.terminal?.selectedFrames, 15);
          assert.equal(counts.startRatios.length, 1);
          const ratio = counts.startRatios[0];
          assert(ratio !== undefined && Math.abs(ratio - 1.4) < 0.000001);
        } else {
          assert.equal(counts.nativeDecoded, 21);
          assert.equal(counts.submittedWebp, 15);
        }
        checks.push({
          ...check,
          admission: {
            ...counts,
            route: format === 'gif' ? 'gif-worker' : 'webp-parallel-canvas',
            boundary:
              format === 'gif'
                ? 'production Worker terminal progress'
                : 'native decoder output and submitted encoder tasks',
            controlledPreflight: { usedMB: 8, totalMB: 16, limitMB: 16 },
          },
        });
      }
    } finally {
      await pressurePage.close();
    }

    const serialPage = await context.newPage();
    try {
      await serialPage.addInitScript(() => {
        globalThis.__wmcWorkerConstructionAttempts = 0;
        Object.defineProperty(globalThis, 'Worker', {
          configurable: true,
          value: class UnavailableWorker {
            constructor() {
              globalThis.__wmcWorkerConstructionAttempts++;
              throw new DOMException('Force serial Canvas contract', 'NotSupportedError');
            }
          },
        });
      });
      const contract = outputContract.cases.find(
        (candidate) => candidate.id === 'integer-vfr-webp'
      );
      assert(contract, 'Missing integer-ratio VFR WebP contract');
      const serial = await convertOutputContract(
        serialPage,
        started.url,
        fixtureFor(contract),
        { ...contract, id: 'integer-vfr-serial-webp' },
        outputContract.markers,
        outputRoot,
        artifacts
      );
      const routeProbe = await serialPage.evaluate(() => ({
        workerAttempts: globalThis.__wmcWorkerConstructionAttempts,
        nativeWebpAvailable: typeof OffscreenCanvas.prototype.convertToBlob === 'function',
      }));
      assert(
        routeProbe.workerAttempts > 0 && routeProbe.nativeWebpAvailable,
        'Serial Canvas check did not reject its pool while preserving native WebP'
      );
      checks.push({ ...serial, routeProbe });
    } finally {
      await serialPage.close();
    }

    // Exercise the production WASM bundle under the deployed CSP, preserving
    // Canvas pixel-copy support while disabling the two preferred encoders.
    const wasmContract = outputContract.cases.find((contract) => contract.id === 'vfr-par-webp');
    assert(wasmContract, 'Missing WASM fallback output contract');
    await page.addInitScript(() => {
      globalThis.__wmcWorkerConstructionAttempts = 0;
      Object.defineProperty(OffscreenCanvas.prototype, 'convertToBlob', {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        value: class UnavailableWorker {
          constructor() {
            globalThis.__wmcWorkerConstructionAttempts++;
            throw new DOMException('Forced Worker bootstrap failure', 'NotSupportedError');
          }
        },
      });
    });
    const wasmCheck = await convertOutputContract(
      page,
      started.url,
      fixtureFor(wasmContract),
      { ...wasmContract, id: 'vfr-par-wasm-webp' },
      outputContract.markers,
      outputRoot,
      artifacts
    );
    const fallback = await page.evaluate(() => ({
      workerAttempts: globalThis.__wmcWorkerConstructionAttempts,
      nativeWebpAvailable: typeof OffscreenCanvas.prototype.convertToBlob === 'function',
    }));
    assert.equal(
      fallback.workerAttempts,
      0,
      'Rejected native WebP capability must select WASM before creating a Worker pool'
    );
    assert.equal(fallback.nativeWebpAvailable, false);
    checks.push({ ...wasmCheck, fallback });
    const integerWasmContract = outputContract.cases.find(
      (contract) => contract.id === 'integer-vfr-webp'
    );
    assert(integerWasmContract, 'Missing integer-ratio WASM contract');
    checks.push(
      await convertOutputContract(
        page,
        started.url,
        fixtureFor(integerWasmContract),
        { ...integerWasmContract, id: 'integer-vfr-wasm-webp' },
        outputContract.markers,
        outputRoot,
        artifacts
      )
    );
    checks.push(await exerciseLongLocaleResult(page, outputRoot, artifacts));
    checks.push(
      await exerciseBrowserZoom(
        browser,
        page,
        bundleRoot,
        started.url,
        smallFixture,
        outputRoot,
        artifacts
      )
    );

    for (const [targetIndex, target] of publicTargets.entries()) {
      checks.push(
        await exercisePublicTarget(
          browser,
          target,
          targetIndex,
          smallFixture,
          cancellationFixture,
          outputRoot,
          artifacts
        )
      );
    }

    await assertMediaNetworkDiagnostics(outputRoot, diagnostics);

    return {
      profile: PROFILE_ID,
      status: 'passed',
      checks,
      observations: {
        environment,
        consoleErrors,
        failedRequests,
        scope: 'functional-and-visual-smoke',
        publicTargets:
          publicTargets.length > 0 ? publicTargets.map((target) => target.url) : 'not-run',
        nativeDialogs: 'not-tested',
        explorerIntegration: 'not-tested',
        gpuPerformance: 'not-measured',
      },
      artifacts,
    };
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await finishMediaProfile({ context, server, outputRoot, diagnostics, failure });
  }
}
