// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';
import type { Page, Response } from '@playwright/test';

import type { OwnedVp8FixtureRequest } from '../../src/test-helpers';
import type {} from './fixtures/test-helpers';

const wasmBytes = readFileSync(new URL('../../crates/owned-vp8/owned-vp8.wasm', import.meta.url));
const wasmSha256 = sha256(wasmBytes);
const fixtures: OwnedVp8FixtureRequest[] = [
  { width: 1, height: 1, quality: 60, seed: 7 },
  { width: 17, height: 13, quality: 75, seed: 31 },
  { width: 45, height: 29, quality: 85, seed: 83 },
];

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function asIvf(raw: readonly number[], width: number, height: number): Buffer {
  const frame = Buffer.from(raw);
  const ivf = Buffer.alloc(44 + frame.length);
  ivf.write('DKIF');
  ivf.writeUInt16LE(32, 6);
  ivf.write('VP80', 8);
  ivf.writeUInt16LE(width, 12);
  ivf.writeUInt16LE(height, 14);
  ivf.writeUInt32LE(1, 16);
  ivf.writeUInt32LE(1, 20);
  ivf.writeUInt32LE(1, 24);
  ivf.writeUInt32LE(frame.length, 32);
  frame.copy(ivf, 44);
  return ivf;
}

function independentlyDecode(raw: readonly number[], width: number, height: number): string {
  const ivf = asIvf(raw, width, height);
  const decoded = ['vp8', 'libvpx'].map((decoder) =>
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-c:v',
        decoder,
        '-f',
        'ivf',
        '-i',
        'pipe:0',
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        'pipe:1',
      ],
      { input: ivf, maxBuffer: width * height * 4 + 4096 }
    )
  );
  for (const pixels of decoded) {
    expect(pixels).toHaveLength(width * height * 4);
    for (let at = 3; at < pixels.length; at += 4) expect(pixels[at]).toBe(255);
  }
  expect(decoded[0]!.equals(decoded[1]!)).toBe(true);
  return sha256(decoded[0]!);
}

async function openKernelPage(page: Page): Promise<{
  wasmResponses: Response[];
  browserErrors: string[];
}> {
  const wasmResponses: Response[] = [];
  const browserErrors: string[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.endsWith('/crates/owned-vp8/owned-vp8.wasm')) {
      wasmResponses.push(response);
    }
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'VideoDecoder', { configurable: true, value: undefined });
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__TEST_HELPERS__));
  expect(await page.evaluate(() => typeof globalThis.VideoDecoder)).toBe('undefined');
  return { wasmResponses, browserErrors };
}

async function assertModuleResponses(responses: readonly Response[]): Promise<void> {
  expect(responses.length).toBeGreaterThan(0);
  for (const response of responses) {
    expect(response.ok()).toBe(true);
    expect((await response.headerValue('content-type'))?.split(';')[0]).toBe('application/wasm');
    expect(sha256(await response.body())).toBe(wasmSha256);
  }
}

test('compiled owned VP8 encodes tiny and odd frames deterministically without VideoDecoder', async ({
  page,
  browser,
  browserName,
}, testInfo) => {
  const { wasmResponses, browserErrors } = await openKernelPage(page);
  const observations: object[] = [];
  let oddFrame: number[] | undefined;
  for (const fixture of fixtures) {
    const result = await page.evaluate(
      (request) => window.__TEST_HELPERS__!.encodeOwnedVp8Fixture(request),
      { ...fixture, repeats: 2 }
    );
    expect(result.releases).toBe(1);
    expect(result.rawFrames).toHaveLength(2);
    expect(result.rawFrames[0]).toEqual(result.rawFrames[1]);
    expect(result.stats).toHaveLength(2);
    for (const stats of result.stats) {
      expect(stats.steps).toBeGreaterThan(0);
      expect(stats.sourceCopyBytes).toBe(fixture.width * fixture.height * 4);
      expect(stats.finalizedVp8Bytes).toBe(result.rawFrames[0]!.length);
    }
    const raw = result.rawFrames[0]!;
    const decodedSha256 = independentlyDecode(raw, fixture.width, fixture.height);
    if (fixture.width === 17) oddFrame = raw;
    observations.push({
      fixture,
      rawBytes: raw.length,
      rawSha256: sha256(Buffer.from(raw)),
      decodedSha256,
      steps: result.stats.map((stats) => stats.steps),
    });
  }
  const fresh = await page.evaluate(
    (request) => window.__TEST_HELPERS__!.encodeOwnedVp8Fixture(request),
    fixtures[1]!
  );
  expect(fresh.releases).toBe(1);
  expect(fresh.rawFrames[0]).toEqual(oddFrame);
  await assertModuleResponses(wasmResponses);
  expect(browserErrors).toEqual([]);
  await testInfo.attach('owned-vp8-engine-identity', {
    body: Buffer.from(
      JSON.stringify({
        engine: browserName,
        browserVersion: browser.version(),
        moduleSha256: wasmSha256,
        moduleBytes: wasmBytes.length,
        observations,
      })
    ),
    contentType: 'application/json',
  });
});

test('active compiled-step cancellation retires the job and a fresh same-document request succeeds', async ({
  page,
  browser,
  browserName,
}, testInfo) => {
  const { wasmResponses, browserErrors } = await openKernelPage(page);
  const request = fixtures[2]!;
  const before = await page.evaluate(
    (fixture) => window.__TEST_HELPERS__!.encodeOwnedVp8Fixture(fixture),
    request
  );
  expect(before.releases).toBe(1);
  expect(before.stats[0]?.steps).toBeGreaterThan(0);
  const cancellationRequest: OwnedVp8FixtureRequest = {
    width: 512,
    height: 384,
    quality: 85,
    seed: 83,
  };
  const cancelled = await page.evaluate(
    (fixture) => window.__TEST_HELPERS__!.cancelOwnedVp8AfterStep(fixture),
    cancellationRequest
  );
  expect(cancelled.moduleSha256).toBe(wasmSha256);
  expect(cancelled.abiVersion).toBe(2);
  expect(cancelled.realSteps).toBeGreaterThan(0);
  expect(cancelled.observedAnalysisSteps).toBeGreaterThan(0);
  expect(cancelled.cancellationStage).toBe(2);
  expect(cancelled.analyzedMacroblocks).toBeGreaterThan(0);
  expect(cancelled.analyzedMacroblocks).toBeLessThanOrEqual(cancelled.totalMacroblocks);
  expect(cancelled.totalMacroblocks).toBe(32 * 24);
  expect(cancelled.hostTaskRan).toBe(true);
  expect(cancelled.taskObservedActive).toBe(true);
  expect(cancelled.outputPublished).toBe(false);
  expect(cancelled.errorName).toBe('OwnedVp8CancelledError');
  expect(cancelled.releases).toBe(1);

  const recovered = await page.evaluate(
    (fixture) => window.__TEST_HELPERS__!.encodeOwnedVp8Fixture(fixture),
    request
  );
  expect(recovered.releases).toBe(1);
  expect(recovered.rawFrames[0]).toEqual(before.rawFrames[0]);
  const decodedSha256 = independentlyDecode(recovered.rawFrames[0]!, request.width, request.height);
  await assertModuleResponses(wasmResponses);
  expect(browserErrors).toEqual([]);
  await testInfo.attach('owned-vp8-cancel-recovery', {
    body: Buffer.from(
      JSON.stringify({
        engine: browserName,
        browserVersion: browser.version(),
        moduleSha256: wasmSha256,
        cancelled,
        recoveredRawSha256: sha256(Buffer.from(recovered.rawFrames[0]!)),
        decodedSha256,
      })
    ),
    contentType: 'application/json',
  });
});
