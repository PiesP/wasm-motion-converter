// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import type { ConversionProfileReport } from '@services/conversion-profiler';
import {
  clickConvert,
  dismissWarningDialog,
  injectTestFile,
  setFormat,
  setQuality,
  setScale,
  setSmartFrameSkip,
  waitForConversionComplete,
} from './fixtures/test-helpers';
import { inspectAnimatedWebp } from './fixtures/validate-magic';
import { decodeFileFully, probeFile, validateFileMagic } from './fixtures/verify';

const FIXTURE = 'test-video-ci-high-motion-120fps.mp4';
const SOURCE_DURATION_MS = 3_000;

interface OutputMetrics {
  frameCount: number;
  durationMs: number;
  outputBytes: number;
  counts: {
    consumedChunks: number;
    decodedFrames: number;
    selectedFrames: number;
    encodedFrames: number;
    emittedFrames: number;
  };
}

function observedCount(value: number | null, name: string): number {
  if (!Number.isSafeInteger(value) || value === null || value < 1) {
    throw new Error(`Conversion profile did not report a positive ${name} count`);
  }
  return value;
}

async function decodeAllFramesInBrowser(
  page: Page,
  output: Uint8Array,
  format: 'gif' | 'webp'
): Promise<{ frameCount: number; width: number; height: number }> {
  return page.evaluate(
    async ({ base64, mimeType }) => {
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const decoder = new ImageDecoder({ data: bytes, type: mimeType });
      try {
        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack;
        if (!track) throw new Error('Animated output did not expose a selected image track');

        let width = 0;
        let height = 0;
        for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex++) {
          const { image } = await decoder.decode({ frameIndex, completeFramesOnly: true });
          width = image.displayWidth;
          height = image.displayHeight;
          image.close();
        }
        return { frameCount: track.frameCount, width, height };
      } finally {
        decoder.close();
      }
    },
    { base64: Buffer.from(output).toString('base64'), mimeType: `image/${format}` }
  );
}

async function convertAndInspect(
  page: Page,
  format: 'gif' | 'webp',
  smartFrameSkip: 'off' | 'adaptive',
  scale: '50%' | '100%' = '50%'
): Promise<OutputMetrics> {
  const expectedDimensions =
    scale === '50%' ? { width: 160, height: 90 } : { width: 320, height: 180 };
  await injectTestFile(page, FIXTURE);

  const metadata = await page.evaluate(() => window.__TEST_HELPERS__?.getMetadata() ?? null);
  expect(metadata).not.toBeNull();
  expect(metadata).toMatchObject({ width: 320, height: 180 });
  expect(metadata!.duration).toBeCloseTo(3, 1);
  expect(metadata!.framerate).toBeGreaterThanOrEqual(119);

  await setFormat(page, format);
  await setQuality(page, 'high');
  await setScale(page, scale);
  await setSmartFrameSkip(page, smartFrameSkip);

  await clickConvert(page);
  await dismissWarningDialog(page);
  expect(await waitForConversionComplete(page, 180_000)).toBe('done');

  const resultBlob = await page.evaluate(() => window.__TEST_HELPERS__?.getResultBlob() ?? null);
  expect(resultBlob).toMatchObject({ type: `image/${format}` });
  expect(resultBlob!.size).toBeGreaterThan(100);

  const profile = await page.evaluate(() => {
    const helpers = window.__TEST_HELPERS__ as unknown as
      | {
          getConversionProfile: () => ConversionProfileReport | null;
        }
      | undefined;
    return helpers?.getConversionProfile() ?? null;
  });
  expect(profile?.encoderRoute).toMatch(format === 'gif' ? /^gif-/ : /^webp-/);
  const stage = profile?.stages.find((candidate) => candidate.stage === 'transcoding');
  if (!stage || stage.stage !== 'transcoding') {
    throw new Error('Conversion profile did not report transcoding');
  }
  const counts = {
    consumedChunks: observedCount(stage.consumedChunks, 'consumedChunks'),
    decodedFrames: observedCount(stage.decodedFrames, 'decodedFrames'),
    selectedFrames: observedCount(stage.selectedFrames, 'selectedFrames'),
    encodedFrames: observedCount(stage.encodedFrames, 'encodedFrames'),
    emittedFrames: observedCount(stage.emittedFrames, 'emittedFrames'),
  };

  const preview = page.locator('[data-testid="result-image"]');
  await expect(preview).toBeVisible();
  await expect
    .poll(() =>
      preview.evaluate((image) => ({
        width: (image as HTMLImageElement).naturalWidth,
        height: (image as HTMLImageElement).naturalHeight,
      }))
    )
    .toEqual(expectedDimensions);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-testid="download-result-button"]').click();
  const download = await downloadPromise;
  const outputPath = await download.path();
  if (!outputPath) throw new Error('Converted output did not have a download path');

  const output = await readFile(outputPath);
  expect(validateFileMagic(output, format)).toMatchObject({ valid: true });
  const browserDecode = await decodeAllFramesInBrowser(page, output, format);
  expect(browserDecode).toMatchObject(expectedDimensions);
  expect(counts.emittedFrames).toBe(browserDecode.frameCount);
  expect(counts.consumedChunks).toBe(360);
  expect(counts.decodedFrames).toBe(360);
  expect(counts.selectedFrames).toBeLessThanOrEqual(counts.decodedFrames);
  expect(counts.encodedFrames).toBeLessThanOrEqual(counts.selectedFrames);

  if (format === 'gif') {
    await decodeFileFully(outputPath);
    const probe = await probeFile(outputPath);
    expect(probe).toMatchObject({ format: 'gif', ...expectedDimensions });
    expect(browserDecode.frameCount).toBe(probe.frameCount);
    return {
      frameCount: probe.frameCount,
      durationMs: probe.duration * 1_000,
      outputBytes: output.byteLength,
      counts,
    };
  }

  const webp = inspectAnimatedWebp(output);
  expect(webp.valid).toBe(true);
  expect(browserDecode.frameCount).toBe(webp.frameCount);
  return {
    frameCount: webp.frameCount,
    durationMs: webp.durationMs,
    outputBytes: output.byteLength,
    counts,
  };
}

async function emulateCriticalMemoryPressure(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(performance, 'memory', {
      configurable: true,
      value: {
        usedJSHeapSize: 8 * 1024 * 1024,
        totalJSHeapSize: 16 * 1024 * 1024,
        jsHeapSizeLimit: 64 * 1024 * 1024,
      },
    });
  });
}

test.describe('adaptive frame skipping resource safety', () => {
  for (const format of ['gif', 'webp'] as const) {
    test(`${format.toUpperCase()} adaptive mode preserves the preset frame cap and timing`, async ({
      page,
    }) => {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => pageErrors.push(error.message));

      await page.goto('/');
      const fixed = await convertAndInspect(page, format, 'off');

      await page.reload();
      const adaptive = await convertAndInspect(page, format, 'adaptive');

      // All 360 source PTS select exactly 60/90 at the 20/30fps preset cadence.
      // The fixture's alternating 120fps luma aliases at both cadences; exact
      // payload dedup can store far fewer frames than the selected work count.
      const expectedSelectedFrames = format === 'gif' ? 60 : 90;
      expect(fixed.counts.selectedFrames).toBe(expectedSelectedFrames);
      expect(adaptive.counts.selectedFrames).toBeLessThanOrEqual(expectedSelectedFrames);

      for (const result of [fixed, adaptive]) {
        expect(result.counts.emittedFrames).toBe(result.frameCount);
        expect(result.frameCount).toBeGreaterThan(0);
        expect(result.frameCount).toBeLessThanOrEqual(
          expectedSelectedFrames + (format === 'gif' ? 1 : 0)
        );
        expect(result.counts.emittedFrames).toBeLessThanOrEqual(
          result.counts.encodedFrames + (format === 'gif' ? 1 : 0)
        );
        expect(result.durationMs).toBeGreaterThanOrEqual(SOURCE_DURATION_MS - 100);
        expect(result.durationMs).toBeLessThanOrEqual(SOURCE_DURATION_MS + 100);
        expect(result.outputBytes).toBeGreaterThan(100);
      }

      test.info().annotations.push({
        type: 'resource-safety',
        description: JSON.stringify({ format, fixed, adaptive }),
      });
      console.info('[resource-safety]', JSON.stringify({ format, fixed, adaptive }));

      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
    });

    test(`${format.toUpperCase()} adaptive mode honors critical-memory forced decimation`, async ({
      page,
    }) => {
      await emulateCriticalMemoryPressure(page);
      await page.goto('/');

      const fixed = await convertAndInspect(page, format, 'off', '100%');
      await page.reload();
      const adaptive = await convertAndInspect(page, format, 'adaptive', '100%');

      // A 64MiB synthetic heap limit forces decimation 8 before conversion.
      // The 360 source PTS select exactly 45 frames; dedup may emit fewer.
      expect(fixed.counts.selectedFrames).toBe(45);
      expect(adaptive.counts.selectedFrames).toBeLessThanOrEqual(45);

      for (const result of [fixed, adaptive]) {
        expect(result.counts.emittedFrames).toBe(result.frameCount);
        expect(result.frameCount).toBeGreaterThan(0);
        expect(result.frameCount).toBeLessThanOrEqual(format === 'gif' ? 46 : 45);
        expect(result.counts.emittedFrames).toBeLessThanOrEqual(
          result.counts.encodedFrames + (format === 'gif' ? 1 : 0)
        );
        expect(result.durationMs).toBeGreaterThanOrEqual(SOURCE_DURATION_MS - 100);
        expect(result.durationMs).toBeLessThanOrEqual(SOURCE_DURATION_MS + 100);
      }

      console.info('[critical-memory]', JSON.stringify({ format, fixed, adaptive }));
    });
  }
});
