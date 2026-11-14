// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Browser, Page } from '@playwright/test';

import { parseGifDelaysCs } from '../gif-playback.ts';
import { installMotionObserver } from '../motion-signature.ts';

type OracleFixture = {
  id: string;
  input: { size: number; sha256: string };
  config: {
    codec: string;
    codedWidth: number;
    codedHeight: number;
    displayAspectWidth?: number;
    displayAspectHeight?: number;
    description?: string;
    colorSpace?: VideoColorSpaceInit;
  };
  rotation: number;
  duration: number;
  stats: { averagePacketRate: number };
};
type Oracle = {
  schema: number;
  source: string;
  oracle: { package: string; version: string; patchSha256: string };
  fixtures: OracleFixture[];
};
type Probe = { status: 'supported' | 'unsupported' | 'query-error'; detail?: string };

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_DECODED_FRAMES = 400;
const TRIM_IDS = new Set([
  'avc-bframes.mp4',
  'avc-fragmented.mp4',
  'vp9.webm',
  'avc.ts',
  'test-video-contract-clusters.webm',
  'mediabunny-fragmented-no-index.mp4',
]);

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function mimeType(id: string): string {
  if (id.endsWith('.mp4')) return 'video/mp4';
  if (id.endsWith('.mov')) return 'video/quicktime';
  if (id.endsWith('.webm')) return 'video/webm';
  if (id.endsWith('.mkv')) return 'video/x-matroska';
  if (id.endsWith('.ts')) return 'video/mp2t';
  throw new Error(`Unknown fixture extension: ${id}`);
}

function expectedGeometry(fixture: OracleFixture) {
  const width = fixture.config.displayAspectWidth ?? fixture.config.codedWidth;
  const height = fixture.config.displayAspectHeight ?? fixture.config.codedHeight;
  assert(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0);
  return fixture.rotation === 90 || fixture.rotation === 270
    ? { width: height, height: width }
    : { width, height };
}

function displayedDurationSeconds(text: string): number {
  const milliseconds = /^(\d+)ms$/.exec(text);
  if (milliseconds) return Number(milliseconds[1]) / 1000;
  const seconds = /^(\d+(?:\.\d+)?)s$/.exec(text);
  if (seconds) return Number(seconds[1]);
  const minutes = /^(\d+)m (\d+)s$/.exec(text);
  if (minutes) return Number(minutes[1]) * 60 + Number(minutes[2]);
  throw new Error(`Unrecognized displayed duration: ${text}`);
}

async function nativeDecoderProbe(page: Page, fixture: OracleFixture): Promise<Probe> {
  return page.evaluate(async (config) => {
    if (typeof VideoDecoder !== 'function') return { status: 'unsupported' };
    const { description, ...rest } = config;
    const actual: VideoDecoderConfig = {
      ...rest,
      ...(description
        ? {
            description: Uint8Array.from(description.match(/../g) ?? [], (byte) =>
              Number.parseInt(byte, 16)
            ),
          }
        : {}),
    };
    try {
      const result = await VideoDecoder.isConfigSupported(actual);
      return { status: result.supported ? 'supported' : 'unsupported' };
    } catch (error) {
      return {
        status: 'query-error',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }, fixture.config);
}

async function readDownload(page: Page): Promise<Buffer> {
  const pending = page.waitForEvent('download', { timeout: 30_000 });
  await page.locator('[data-testid="download-result-button"]').click();
  const stream = await (await pending).createReadStream();
  assert(stream, 'Saved GIF has no readable stream');
  const parts: Buffer[] = [];
  let total = 0;
  for await (const part of stream) {
    const bytes = Buffer.from(part);
    total += bytes.length;
    assert(total <= MAX_OUTPUT_BYTES, 'Saved GIF exceeded matrix output bound');
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}

function gifLoop(bytes: Buffer): number | null {
  let offset = 13 + ((bytes[10]! & 0x80) !== 0 ? 3 * (1 << ((bytes[10]! & 7) + 1)) : 0);
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x2c || marker === 0x3b) return null;
    assert.equal(marker, 0x21, 'Unexpected GIF extension boundary');
    const label = bytes[offset++];
    const blockSize = bytes[offset++];
    assert(blockSize !== undefined && offset + blockSize <= bytes.length);
    if (label === 0xff && blockSize === 11) {
      const identifier = bytes.toString('ascii', offset, offset + 11);
      if (identifier === 'NETSCAPE2.0' || identifier === 'ANIMEXTS1.0') {
        assert.equal(bytes[offset + 11], 3);
        assert.equal(bytes[offset + 12], 1);
        assert.equal(bytes[offset + 15], 0);
        return bytes.readUInt16LE(offset + 13);
      }
    }
    offset += blockSize;
    while (offset < bytes.length) {
      const size = bytes[offset++]!;
      if (size === 0) break;
      assert(offset + size <= bytes.length, 'Truncated GIF extension');
      offset += size;
    }
  }
  return null;
}

async function decodeGif(page: Page, bytes: Buffer) {
  return page.evaluate(async (base64) => {
    if (typeof ImageDecoder !== 'function') throw new Error('ImageDecoder unavailable');
    const data = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const decoder = new ImageDecoder({ data, type: 'image/gif', preferAnimation: true });
    try {
      await decoder.tracks.ready;
      const track = decoder.tracks.selectedTrack;
      if (!track || track.frameCount < 1 || track.frameCount > 400)
        throw new Error('GIF frame count outside matrix bound');
      const frames: Array<{
        width: number;
        height: number;
        durationUs: number;
        pixelSha256: string;
      }> = [];
      for (let index = 0; index < track.frameCount; index++) {
        const decoded = await decoder.decode({ frameIndex: index, completeFramesOnly: true });
        const image = decoded.image;
        try {
          if (!decoded.complete) throw new Error(`Incomplete GIF frame ${index}`);
          const pixels = new Uint8Array(image.displayWidth * image.displayHeight * 4);
          await image.copyTo(pixels, { format: 'RGBA' });
          const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', pixels));
          frames.push({
            width: image.displayWidth,
            height: image.displayHeight,
            durationUs: image.duration ?? 0,
            pixelSha256: Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join(
              ''
            ),
          });
        } finally {
          image.close();
        }
      }
      return { repetitionCount: track.repetitionCount, frames };
    } finally {
      decoder.close();
    }
  }, bytes.toString('base64'));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Actual production UI route; all fixture bytes stay in the Node test bundle. */
export async function exerciseOwnedDemuxProduct({
  browser,
  bundleRoot,
  output,
  build,
  url,
  validateBundleFile,
  loadApplication,
}: {
  browser: Browser;
  bundleRoot: string;
  output: string;
  build: unknown;
  url: string;
  validateBundleFile: (root: string, path: string) => Promise<string>;
  loadApplication: (page: Page, url: string) => Promise<unknown>;
}) {
  await mkdir(output, { recursive: true });
  const oraclePath = await validateBundleFile(bundleRoot, 'test/fixtures/owned-demux/oracle.json');
  const oracleBytes = await readFile(oraclePath);
  const oracle = JSON.parse(oracleBytes.toString('utf8')) as Oracle;
  assert.equal(oracle.schema, 1);
  assert.equal(oracle.oracle.package, 'mediabunny');
  assert.equal(oracle.fixtures.length, 39);
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(installMotionObserver);
  const cases: unknown[] = [];
  const failures: string[] = [];
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    scenario: 'owned-demux-product',
    status: 'running',
    browserVersion: browser.version(),
    build,
    oracle: {
      sha256: sha256(oracleBytes),
      source: oracle.source,
      package: oracle.oracle.package,
      version: oracle.oracle.version,
      patchSha256: oracle.oracle.patchSha256,
    },
    settings: { format: 'gif', quality: 'medium', scale: 1, smartFrameSkip: 'off' },
    cases,
  };
  try {
    for (const fixture of oracle.fixtures) {
      const path = await validateBundleFile(
        bundleRoot,
        `test/fixtures/owned-demux/${fixture.id}.base64`
      );
      const encoded = (await readFile(path, 'utf8')).trim();
      assert(/^[A-Za-z0-9+/]*={0,2}$/.test(encoded), `${fixture.id}: invalid base64`);
      const input = Buffer.from(encoded, 'base64');
      assert(input.length > 0 && input.length <= MAX_INPUT_BYTES, `${fixture.id}: input bound`);
      assert.equal(input.length, fixture.input.size, `${fixture.id}: input size`);
      assert.equal(sha256(input), fixture.input.sha256, `${fixture.id}: input digest`);
      const variants = [{ id: 'full', trim: null }] as Array<{
        id: string;
        trim: { start: number; end: number } | null;
      }>;
      if (TRIM_IDS.has(fixture.id) && fixture.duration >= 1.5)
        variants.push({ id: 'trim', trim: { start: 0.25, end: 1.5 } });
      for (const variant of variants) {
        const page = await context.newPage();
        const diagnostics = {
          pageErrors: [] as string[],
          consoleErrors: [] as string[],
          failedRequests: [] as string[],
          httpErrors: [] as string[],
        };
        page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
        });
        page.on('requestfailed', (request) => {
          if (
            request.url().startsWith('blob:') &&
            request.failure()?.errorText === 'net::ERR_ABORTED'
          )
            return;
          diagnostics.failedRequests.push(
            `${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? 'unknown'}`
          );
        });
        page.on('response', (response) => {
          if (response.status() >= 400)
            diagnostics.httpErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
        });
        const entry: Record<string, unknown> = {
          id: fixture.id,
          variant: variant.id,
          input: fixture.input,
          expected: {
            duration: fixture.duration,
            rotation: fixture.rotation,
            geometry: expectedGeometry(fixture),
            codec: fixture.config.codec,
            averagePacketRate: fixture.stats.averagePacketRate,
          },
          diagnostics,
        };
        cases.push(entry);
        try {
          entry.appLoad = await loadApplication(page, url);
          if (!report.browserUserAgent)
            report.browserUserAgent = await page.evaluate(() => navigator.userAgent);
          entry.nativeDecoder = await nativeDecoderProbe(page, fixture);
          const beforeMetadataMs = await page.evaluate(() => performance.now());
          await page.locator('[data-testid="file-input"]').setInputFiles({
            name: fixture.id,
            mimeType: mimeType(fixture.id),
            buffer: input,
          });
          await page.waitForFunction(
            () => {
              const metadata = document.querySelector('[data-testid="video-metadata"]');
              const error = document.querySelector('[data-testid="error-display"]');
              return !!metadata?.getClientRects().length || !!error?.getClientRects().length;
            },
            undefined,
            { timeout: 30_000 }
          );
          const afterMetadataMs = await page.evaluate(() => performance.now());
          const metadata = page.locator('[data-testid="video-metadata"]');
          const metadataError = page.locator('[data-testid="error-display"]');
          entry.metadataAdmissionMs = afterMetadataMs - beforeMetadataMs;
          if (await metadataError.isVisible()) {
            entry.metadataError = (await metadataError.textContent())?.trim();
            throw new Error(`${fixture.id}: metadata admission failed`);
          }
          const fields = await metadata
            .locator('div')
            .evaluateAll((rows) =>
              Object.fromEntries(
                rows.map((row) => [
                  row.querySelector('dt')?.textContent?.trim() ?? '',
                  row.querySelector('dd')?.textContent?.trim() ?? '',
                ])
              )
            );
          entry.visibleMetadata = fields;
          const geometry = expectedGeometry(fixture);
          assert.equal(
            fields.Resolution,
            `${geometry.width}×${geometry.height}`,
            `${fixture.id}: visible resolution`
          );
          assert.equal(
            fields.Codec,
            fixture.config.codec.split('.')[0]!.toUpperCase(),
            `${fixture.id}: visible codec`
          );
          assert.equal(
            Number(fields.FPS),
            Math.round(fixture.stats.averagePacketRate * 100) / 100,
            `${fixture.id}: visible packet rate`
          );
          assert(
            fields.Duration && fields.Duration.length > 0,
            `${fixture.id}: no visible duration`
          );
          assert(
            Math.abs(displayedDurationSeconds(fields.Duration) - fixture.duration) <= 0.1,
            `${fixture.id}: visible duration differs from oracle`
          );
          if (variant.trim) {
            await page.locator('#trim-start-input').fill(String(variant.trim.start));
            await page.locator('#trim-start-input').blur();
            await page.locator('#trim-end-input').fill(String(variant.trim.end));
            await page.locator('#trim-end-input').blur();
          }
          for (const [group, value] of [
            ['format', 'gif'],
            ['quality', 'medium'],
            ['scale', '1'],
            ['smart-frame-skip', 'off'],
          ] as const) {
            const option = page.locator(`[data-testid="option-${group}-${value}"]`);
            if (!(await option.isVisible()))
              await page.locator('[data-testid="advanced-settings"] summary').click();
            await option.click();
            assert.equal(await option.locator('input').isChecked(), true);
          }
          const beforeWorker = await page.evaluate(() => {
            const observer = Reflect.get(globalThis, '__wmcMotionObserver') as {
              reset: () => void;
              workers: unknown[];
            };
            observer.reset();
            return { timeOrigin: performance.timeOrigin, workerCount: observer.workers.length };
          });
          await page.locator('[data-testid="convert-button"]').click();
          const prompt = page.locator('[data-testid="modal-confirm-button"]');
          if (await prompt.isVisible()) await prompt.click();
          await page.waitForFunction(
            () => {
              const result = document.querySelector('[data-testid="result-section"]');
              const error = document.querySelector('[data-testid="error-display"]');
              return !!result?.getClientRects().length || !!error?.getClientRects().length;
            },
            undefined,
            { timeout: 120_000 }
          );
          const route = await page.evaluate((before) => {
            const observer = Reflect.get(globalThis, '__wmcMotionObserver') as {
              clickMs: number | null;
              readyMs: number | null;
              outputUrls: Array<{ url: string; size: number; atMs: number }>;
              workers: Array<{
                starts: unknown[];
                completes: Array<{ outputBytes: number }>;
                errors: unknown[];
                terminationCalls: number;
              }>;
            };
            return {
              timeOrigin: performance.timeOrigin,
              clickMs: observer.clickMs,
              readyMs: observer.readyMs,
              outputUrls: observer.outputUrls,
              workers: observer.workers.slice(before.workerCount),
            };
          }, beforeWorker);
          entry.route = route;
          assert.equal(
            route.timeOrigin,
            beforeWorker.timeOrigin,
            'Document changed during conversion'
          );
          const conversionError = page.locator('[data-testid="error-display"]');
          if (await conversionError.isVisible()) {
            entry.conversionError = (await conversionError.textContent())?.trim();
            if ((entry.nativeDecoder as Probe).status === 'unsupported') {
              assert.match(String(entry.conversionError), /codec|decod|support/i);
              assert.equal(
                await page
                  .locator('[data-testid="error-select-different-fallback-button"]')
                  .isVisible(),
                true,
                `${fixture.id}: unsupported decoder did not show the codec recovery route`
              );
              assert.equal(await page.locator('[data-testid="result-section"]').isVisible(), false);
              entry.status = 'native-decoder-unsupported';
              continue;
            }
            throw new Error(
              `${fixture.id}: conversion failed despite native decoder probe ${(entry.nativeDecoder as Probe).status}`
            );
          }
          assert.equal(
            (entry.nativeDecoder as Probe).status,
            'supported',
            `${fixture.id}: conversion succeeded without a supported native decoder probe`
          );
          assert(route.clickMs !== null && route.readyMs !== null && route.readyMs > route.clickMs);
          assert.equal(route.workers.length, 1, `${fixture.id}: expected conversion Worker`);
          assert.equal(route.workers[0]?.starts.length, 1, `${fixture.id}: Worker start`);
          assert.equal(route.workers[0]?.completes.length, 1, `${fixture.id}: Worker completion`);
          assert.deepEqual(route.workers[0]?.errors, [], `${fixture.id}: Worker error`);
          assert.equal(route.workers[0]?.terminationCalls, 1, `${fixture.id}: Worker termination`);
          const bytes = await readDownload(page);
          const file = `owned-demux-${fixture.id.replace(/[^\w.-]/g, '_')}-${variant.id}.gif`;
          await writeFile(join(output, file), bytes);
          assert(bytes.length >= 20 && bytes.length <= MAX_OUTPUT_BYTES);
          assert.equal(bytes.subarray(0, 6).toString('ascii'), 'GIF89a');
          assert.equal(bytes.at(-1), 0x3b);
          const delaysCs = parseGifDelaysCs(bytes);
          const decoded = await decodeGif(page, bytes);
          assert(decoded.frames.length <= MAX_DECODED_FRAMES);
          assert.equal(delaysCs.length, decoded.frames.length);
          assert.equal(bytes.readUInt16LE(6), geometry.width);
          assert.equal(bytes.readUInt16LE(8), geometry.height);
          assert(
            decoded.frames.every(
              (frame) => frame.width === geometry.width && frame.height === geometry.height
            )
          );
          assert(decoded.frames.every((frame) => frame.durationUs > 0));
          assert.equal(gifLoop(bytes), 0, 'GIF loop extension changed');
          const durationUs = decoded.frames.reduce((total, frame) => total + frame.durationUs, 0);
          const expectedDurationUs = variant.trim
            ? (variant.trim.end - variant.trim.start) * 1_000_000
            : fixture.duration * 1_000_000;
          assert(
            Math.abs(durationUs - expectedDurationUs) <= 250_000,
            `${fixture.id}: output timeline differs by more than 250ms`
          );
          assert.equal(route.workers[0]?.completes[0]?.outputBytes, bytes.length);
          assert(route.outputUrls.some((event) => event.size === bytes.length));
          entry.output = {
            file,
            bytes: bytes.length,
            sha256: sha256(bytes),
            width: geometry.width,
            height: geometry.height,
            frameCount: decoded.frames.length,
            delaysCs,
            durationUs,
            repetitionCount: decoded.repetitionCount,
            loopCount: 0,
            compositedFrames: decoded.frames,
          };
          entry.requestToDownloadReadyMs = route.readyMs - route.clickMs;
          entry.status = 'converted';
        } catch (error) {
          entry.status = 'failed';
          entry.error = errorText(error);
          failures.push(`${fixture.id}/${variant.id}: ${errorText(error)}`);
        } finally {
          try {
            await page.close();
          } catch (error) {
            failures.push(`${fixture.id}/${variant.id}: page cleanup: ${errorText(error)}`);
          }
        }
        if (
          diagnostics.pageErrors.length > 0 ||
          diagnostics.failedRequests.length > 0 ||
          diagnostics.httpErrors.length > 0 ||
          (entry.status !== 'native-decoder-unsupported' && diagnostics.consoleErrors.length > 0)
        ) {
          failures.push(`${fixture.id}/${variant.id}: browser diagnostics`);
        }
      }
    }
    report.status = failures.length ? 'failed' : 'passed';
    report.failures = failures;
    assert.deepEqual(failures, [], 'Owned demux product matrix failed');
    return { profile: 'owned-demux-product', status: 'passed', cases: cases.length };
  } finally {
    let cleanupFailure: unknown;
    try {
      await context.close();
    } catch (error) {
      cleanupFailure = error;
      failures.push(`context cleanup: ${errorText(error)}`);
      report.status = 'failed';
    }
    report.failures = failures;
    await writeFile(
      join(output, 'owned-demux-product.json'),
      `${JSON.stringify(report, null, 2)}\n`
    );
    if (cleanupFailure) throw cleanupFailure;
  }
}
