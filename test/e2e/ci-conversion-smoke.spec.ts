// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { expect, test } from '@playwright/test';
import {
  clickConvert,
  downloadResult,
  injectTestFile,
  runConversion,
  setFormat,
  setQuality,
  setScale,
  setSmartFrameSkip,
  waitForConversionComplete,
} from './fixtures/test-helpers';
import { validateFileMagic } from './fixtures/verify';

const FIXTURE = 'test-video-ci-h264.mp4';

const PREVIEW_VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'narrow', width: 390, height: 844 },
] as const;

test('sharing settings preserve the selected format and clip and allow manual changes', async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.goto('/');
  await injectTestFile(page, FIXTURE);
  await setFormat(page, 'webp');
  await setQuality(page, 'high');
  await setScale(page, '100%');
  await setSmartFrameSkip(page, 'low');

  const startInput = page.locator('#trim-start-input');
  const endInput = page.locator('#trim-end-input');
  await startInput.fill('0:00.2');
  await startInput.press('Enter');
  await endInput.fill('0:00.9');
  await endInput.press('Enter');

  const sharingButton = page.getByTestId('sharing-settings-button');
  await page.getByTestId('sharing-settings').locator('summary').click();
  await sharingButton.focus();
  await page.keyboard.press('Enter');
  await expect(sharingButton).toBeDisabled();
  await expect(page.locator('input[name="quality"][value="low"]')).toBeChecked();
  await expect(page.locator('input[name="scale"][value="0.5"]')).toBeChecked();
  await expect(page.locator('input[name="format"][value="webp"]')).toBeChecked();
  await expect(startInput).toHaveValue('0:00.2');
  await expect(endInput).toHaveValue('0:00.9');
  await expect(page.getByTestId('result-section')).not.toBeVisible();
  await expect(page.getByTestId('convert-button')).toBeEnabled();

  const expectedSettings = {
    format: 'webp',
    quality: 'low',
    scale: 0.5,
    trimStart: 0.2,
    trimEnd: 0.9,
    smartFrameSkip: 'low',
  };
  await expect
    .poll(() => page.evaluate(() => window.__TEST_HELPERS__?.getSettings()))
    .toMatchObject(expectedSettings);
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('conversion-settings') ?? '{}')))
    .toMatchObject(expectedSettings);
  const screenshotPath = test.info().outputPath('sharing-settings.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await test.info().attach('sharing-settings', {
    path: screenshotPath,
    contentType: 'image/png',
  });

  await clickConvert(page);
  expect(await waitForConversionComplete(page)).toBe('done');
  await expect(page.locator('[data-result-resolution]')).toHaveText('80×45');
  expect(validateFileMagic(await downloadResult(page), 'webp')).toMatchObject({ valid: true });

  await setQuality(page, 'high');
  await expect(sharingButton).toBeEnabled();
  await expect(page.getByTestId('result-section')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('conversion-settings') ?? '{}').quality))
    .toBe('high');
  await page.reload();
  await expect(page.locator('input[name="quality"][value="high"]')).toBeChecked();
  await expect(page.locator('input[name="scale"][value="0.5"]')).toBeChecked();
  await expect(page.locator('input[name="format"][value="webp"]')).toBeChecked();
  expect(browserErrors).toEqual([]);
});

test.describe('CI codec smoke', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  for (const format of ['gif', 'webp'] as const) {
    test(`converts a generated H.264 fixture to ${format.toUpperCase()}`, async ({ page }) => {
      await page.setViewportSize(
        format === 'webp' ? { width: 390, height: 844 } : { width: 1280, height: 900 }
      );
      const result = await runConversion(page, {
        file: FIXTURE,
        format,
        quality: 'low',
        scale: '50%',
        timeoutMs: 120_000,
      });

      expect(result.error).toBeNull();
      expect(result.state).toBe('done');

      const preview = page.locator('[data-testid="result-image"]');
      await expect(preview).toBeVisible();
      await expect
        .poll(() =>
          preview.evaluate((image) => ({
            width: (image as HTMLImageElement).naturalWidth,
            height: (image as HTMLImageElement).naturalHeight,
          }))
        )
        .toEqual({ width: 80, height: 45 });

      const resultSummary = page.locator('[data-testid="result-summary"]');
      await expect(resultSummary.locator('[data-result-resolution]')).toHaveText('80×45');
      await expect(resultSummary.locator('[data-result-output-size]')).not.toHaveText('');

      const downloadButton = page.locator('[data-testid="download-result-button"]');
      await expect(downloadButton).toBeFocused();
      expect(
        await downloadButton.evaluate((button, image) => {
          const previewImage = document.querySelector(image);
          return previewImage
            ? Boolean(
                button.compareDocumentPosition(previewImage) & Node.DOCUMENT_POSITION_FOLLOWING
              )
            : false;
        }, '[data-testid="result-image"]')
      ).toBe(true);
      await expect
        .poll(() =>
          downloadButton.evaluate((button) => {
            const rect = button.getBoundingClientRect();
            return rect.top >= 0 && rect.bottom <= innerHeight;
          })
        )
        .toBe(true);

      const actualSizeButton = page.locator('[data-testid="preview-size-actual"]');
      const fitButton = page.locator('[data-testid="preview-size-fit"]');
      await expect(actualSizeButton).toHaveAttribute('aria-pressed', 'true');
      await expect(fitButton).toHaveAttribute('aria-pressed', 'false');
      await expect
        .poll(() =>
          preview.evaluate((image) => {
            const element = image as HTMLImageElement;
            const rect = element.getBoundingClientRect();
            return Math.min(rect.width / element.naturalWidth, rect.height / element.naturalHeight);
          })
        )
        .toBeLessThanOrEqual(1.01);

      await fitButton.click();
      await expect(fitButton).toHaveAttribute('aria-pressed', 'true');
      await expect
        .poll(() =>
          preview.evaluate((image) => {
            const element = image as HTMLImageElement;
            const rect = element.getBoundingClientRect();
            return Math.min(rect.width / element.naturalWidth, rect.height / element.naturalHeight);
          })
        )
        .toBeGreaterThan(1.1);
      await expect
        .poll(async () => {
          const value = await page
            .locator('[data-testid="preview-scale"]')
            .getAttribute('data-preview-scale');
          return Number.parseInt(value ?? '', 10);
        })
        .toBeGreaterThan(110);

      await actualSizeButton.click();
      await expect(actualSizeButton).toHaveAttribute('aria-pressed', 'true');
      await expect
        .poll(() =>
          preview.evaluate((image) => {
            const element = image as HTMLImageElement;
            const rect = element.getBoundingClientRect();
            return Math.min(rect.width / element.naturalWidth, rect.height / element.naturalHeight);
          })
        )
        .toBeLessThanOrEqual(1.01);

      const output = await downloadResult(page);
      const validation = validateFileMagic(output, format);
      expect(validation).toMatchObject({ valid: true });
    });
  }
});

test.describe('Selected-range preview', () => {
  for (const viewport of PREVIEW_VIEWPORTS) {
    test(`keeps the ${viewport.name} playback control with the video`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/');
      await page.locator('[data-testid="file-input"]').setInputFiles(`public/${FIXTURE}`);
      await expect(page.locator('[data-testid="convert-button"]')).toBeEnabled();

      const startInput = page.locator('#trim-start-input');
      const endInput = page.locator('#trim-end-input');
      await startInput.fill('0:00.2');
      await startInput.press('Enter');
      await endInput.fill('0:00.9');
      await endInput.press('Enter');

      const player = page.locator('[data-testid="selection-preview-player"]');
      const video = player.locator('video');
      const previewButton = player.locator('[data-testid="trim-preview-button"]');
      await expect(player).toBeVisible();
      await expect(previewButton).toHaveAttribute('aria-controls', 'selection-preview-video');
      await page.waitForFunction(() => {
        const element = document.querySelector('#selection-preview-video');
        return element instanceof HTMLVideoElement && element.readyState >= 1;
      });

      await previewButton.focus();
      await page.keyboard.press('Space');
      await expect(previewButton).toHaveAttribute('aria-pressed', 'true');
      await expect
        .poll(
          () =>
            video.evaluate((element) => ({
              currentTime:
                element instanceof HTMLVideoElement ? element.currentTime : Number.NaN,
              paused: element instanceof HTMLVideoElement ? element.paused : true,
            })),
          { timeout: 3_000, intervals: [25, 50, 100] }
        )
        .toMatchObject({ paused: false });

      const geometry = await player.evaluate((element) => {
        const videoElement = element.querySelector('video');
        const buttonElement = element.querySelector('[data-testid="trim-preview-button"]');
        if (!(videoElement instanceof HTMLVideoElement) || !(buttonElement instanceof HTMLElement)) {
          throw new Error('Selection preview player is incomplete');
        }
        const videoRect = videoElement.getBoundingClientRect();
        const buttonRect = buttonElement.getBoundingClientRect();
        const visibleVideoHeight = Math.max(
          0,
          Math.min(videoRect.bottom, innerHeight) - Math.max(videoRect.top, 0)
        );
        return {
          video: {
            top: videoRect.top,
            right: videoRect.right,
            bottom: videoRect.bottom,
            left: videoRect.left,
            height: videoRect.height,
          },
          button: {
            top: buttonRect.top,
            right: buttonRect.right,
            bottom: buttonRect.bottom,
            left: buttonRect.left,
            height: buttonRect.height,
          },
          visibleVideoHeight,
          viewport: { width: innerWidth, height: innerHeight },
          focused: document.activeElement === buttonElement,
        };
      });
      expect(geometry.button.left).toBeGreaterThanOrEqual(geometry.video.left);
      expect(geometry.button.right).toBeLessThanOrEqual(geometry.video.right);
      expect(geometry.button.top).toBeGreaterThanOrEqual(geometry.video.top);
      expect(geometry.button.bottom).toBeLessThanOrEqual(geometry.video.bottom);
      expect(geometry.video.top).toBeGreaterThanOrEqual(-1);
      expect(geometry.video.left).toBeGreaterThanOrEqual(-1);
      expect(geometry.video.bottom).toBeLessThanOrEqual(geometry.viewport.height + 1);
      expect(geometry.video.right).toBeLessThanOrEqual(geometry.viewport.width + 1);
      expect(geometry.visibleVideoHeight).toBeGreaterThanOrEqual(geometry.video.height - 1);
      expect(geometry.focused).toBe(true);

      await page.keyboard.press('Space');
      await expect(previewButton).toHaveAttribute('aria-pressed', 'false');
      await expect
        .poll(() =>
          video.evaluate((element) =>
            element instanceof HTMLVideoElement ? element.paused : true
          )
        )
        .toBe(true);
      await expect(previewButton).toBeFocused();

      await page.keyboard.press('Space');
      await expect(previewButton).toHaveAttribute('aria-pressed', 'true');
      await expect
        .poll(
          () =>
            video.evaluate(
              (element) =>
                element instanceof HTMLVideoElement &&
                element.paused &&
                Math.abs(element.currentTime - 0.2) < 0.08
            ),
          { timeout: 5_000, intervals: [25, 50, 100] }
        )
        .toBe(true);
      await expect(previewButton).toHaveAttribute('aria-pressed', 'false');
      await expect(previewButton).toBeFocused();
    });
  }
});
