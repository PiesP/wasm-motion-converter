// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import { inspectAnimatedWebp } from './fixtures/validate-magic';
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
import { probeFile, validateFileMagic } from './fixtures/verify';

const FIXTURE = 'test-video-ci-high-motion-120fps.mp4';
const SOURCE_DURATION_MS = 3_000;

interface OutputMetrics {
  frameCount: number;
  durationMs: number;
  outputBytes: number;
}

async function convertAndInspect(
  page: Page,
  format: 'gif' | 'webp',
  smartFrameSkip: 'off' | 'adaptive',
): Promise<OutputMetrics> {
  await injectTestFile(page, FIXTURE);

  const metadata = await page.evaluate(() => window.__TEST_HELPERS__?.getMetadata() ?? null);
  expect(metadata).not.toBeNull();
  expect(metadata).toMatchObject({ width: 320, height: 180 });
  expect(metadata!.duration).toBeCloseTo(3, 1);
  expect(metadata!.framerate).toBeGreaterThanOrEqual(119);

  await setFormat(page, format);
  await setQuality(page, 'high');
  await setScale(page, '50%');
  await setSmartFrameSkip(page, smartFrameSkip);

  await clickConvert(page);
  await dismissWarningDialog(page);
  expect(await waitForConversionComplete(page, 180_000)).toBe('done');

  const resultBlob = await page.evaluate(() => window.__TEST_HELPERS__?.getResultBlob() ?? null);
  expect(resultBlob).toMatchObject({ type: `image/${format}` });
  expect(resultBlob!.size).toBeGreaterThan(100);

  const preview = page.locator('[data-testid="result-image"]');
  await expect(preview).toBeVisible();
  await expect
    .poll(() =>
      preview.evaluate((image) => ({
        width: (image as HTMLImageElement).naturalWidth,
        height: (image as HTMLImageElement).naturalHeight,
      })),
    )
    .toEqual({ width: 160, height: 90 });

  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-testid="download-result-button"]').click();
  const download = await downloadPromise;
  const outputPath = await download.path();
  if (!outputPath) throw new Error('Converted output did not have a download path');

  const output = await readFile(outputPath);
  expect(validateFileMagic(output, format)).toMatchObject({ valid: true });

  if (format === 'gif') {
    const probe = await probeFile(outputPath);
    expect(probe).toMatchObject({ format: 'gif', width: 160, height: 90 });
    return {
      frameCount: probe.frameCount,
      durationMs: probe.duration * 1_000,
      outputBytes: output.byteLength,
    };
  }

  const webp = inspectAnimatedWebp(output);
  expect(webp.valid).toBe(true);
  return {
    frameCount: webp.frameCount,
    durationMs: webp.durationMs,
    outputBytes: output.byteLength,
  };
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

      // 120fps high quality is capped at 20fps for GIF and 30fps for WebP.
      // GIF can add one identical continuation frame for a trailing duration.
      const expectedFrameCount = format === 'gif' ? 60 : 90;
      expect(fixed.frameCount).toBeGreaterThanOrEqual(expectedFrameCount);
      expect(fixed.frameCount).toBeLessThanOrEqual(expectedFrameCount + (format === 'gif' ? 1 : 0));
      expect(adaptive.frameCount).toBeGreaterThanOrEqual(Math.floor(expectedFrameCount * 0.7));
      expect(adaptive.frameCount).toBeLessThanOrEqual(fixed.frameCount);

      for (const result of [fixed, adaptive]) {
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
  }
});
