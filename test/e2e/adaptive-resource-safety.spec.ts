// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { expect, test, type Page } from '@playwright/test';
import { Buffer } from 'node:buffer';
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
import { decodeFileFully, probeFile, validateFileMagic } from './fixtures/verify';

const FIXTURE = 'test-video-ci-high-motion-120fps.mp4';
const SOURCE_DURATION_MS = 3_000;

interface OutputMetrics {
  frameCount: number;
  durationMs: number;
  outputBytes: number;
}

async function decodeAllFramesInBrowser(
  page: Page,
  output: Uint8Array,
  format: 'gif' | 'webp',
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
    { base64: Buffer.from(output).toString('base64'), mimeType: `image/${format}` },
  );
}

async function convertAndInspect(
  page: Page,
  format: 'gif' | 'webp',
  smartFrameSkip: 'off' | 'adaptive',
  scale: '50%' | '100%' = '50%',
): Promise<OutputMetrics> {
  const expectedDimensions = scale === '50%' ? { width: 160, height: 90 } : { width: 320, height: 180 };
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

  const preview = page.locator('[data-testid="result-image"]');
  await expect(preview).toBeVisible();
  await expect
    .poll(() =>
      preview.evaluate((image) => ({
        width: (image as HTMLImageElement).naturalWidth,
        height: (image as HTMLImageElement).naturalHeight,
      })),
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

  if (format === 'gif') {
    await decodeFileFully(outputPath);
    const probe = await probeFile(outputPath);
    expect(probe).toMatchObject({ format: 'gif', ...expectedDimensions });
    expect(browserDecode.frameCount).toBe(probe.frameCount);
    return {
      frameCount: probe.frameCount,
      durationMs: probe.duration * 1_000,
      outputBytes: output.byteLength,
    };
  }

  const webp = inspectAnimatedWebp(output);
  expect(webp.valid).toBe(true);
  expect(browserDecode.frameCount).toBe(webp.frameCount);
  return {
    frameCount: webp.frameCount,
    durationMs: webp.durationMs,
    outputBytes: output.byteLength,
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

    test(`${format.toUpperCase()} adaptive mode honors critical-memory forced decimation`, async ({
      page,
    }) => {
      await emulateCriticalMemoryPressure(page);
      await page.goto('/');

      const fixed = await convertAndInspect(page, format, 'off', '100%');
      await page.reload();
      const adaptive = await convertAndInspect(page, format, 'adaptive', '100%');

      // A 64MiB synthetic heap limit makes the real pre-conversion memory check
      // force decimation 8: 360 source frames become at most 45 kept frames.
      // GIF writes one continuation frame to preserve the final skipped duration.
      const expectedContainerFrames = format === 'gif' ? 46 : 45;
      expect(fixed.frameCount).toBe(expectedContainerFrames);
      expect(adaptive.frameCount).toBeLessThanOrEqual(expectedContainerFrames);

      for (const result of [fixed, adaptive]) {
        expect(result.durationMs).toBeGreaterThanOrEqual(SOURCE_DURATION_MS - 100);
        expect(result.durationMs).toBeLessThanOrEqual(SOURCE_DURATION_MS + 100);
      }

      console.info('[critical-memory]', JSON.stringify({ format, fixed, adaptive }));
    });
  }
});
