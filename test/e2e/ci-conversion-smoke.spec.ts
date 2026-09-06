// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { expect, test } from '@playwright/test';
import { downloadResult, runConversion } from './fixtures/test-helpers';
import { validateFileMagic } from './fixtures/verify';

const FIXTURE = 'test-video-ci-h264.mp4';

const PREVIEW_VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'narrow', width: 390, height: 844 },
] as const;

test.describe('CI codec smoke', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  for (const format of ['gif', 'webp'] as const) {
    test(`converts a generated H.264 fixture to ${format.toUpperCase()}`, async ({ page }) => {
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
              currentTime: element.currentTime,
              paused: element.paused,
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
      await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);
      await expect(previewButton).toBeFocused();

      await page.keyboard.press('Space');
      await expect(previewButton).toHaveAttribute('aria-pressed', 'true');
      await expect
        .poll(
          () =>
            video.evaluate(
              (element) => element.paused && Math.abs(element.currentTime - 0.2) < 0.08
            ),
          { timeout: 5_000, intervals: [25, 50, 100] }
        )
        .toBe(true);
      await expect(previewButton).toHaveAttribute('aria-pressed', 'false');
      await expect(previewButton).toBeFocused();
    });
  }
});
