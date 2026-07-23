// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP
//
// Visual regression tests — screenshot comparison for key UI states.
// Captures screenshots at critical UI states and compares against baselines.
//
// Run with:
//   npx playwright test test/e2e/visual-regression.spec.ts --reporter=list
//
// Update baselines:
//   npx playwright test test/e2e/visual-regression.spec.ts --update-snapshots

import { test, expect, type Page } from '@playwright/test';
import { injectTestFile } from './fixtures/test-helpers';

/**
 * Capture a screenshot with consistent settings for visual comparison.
 */
async function captureForComparison(
  page: Page,
  name: string,
  options?: { fullPage?: boolean; selector?: string }
): Promise<Buffer> {
  const screenshotOptions: Parameters<Page['screenshot']>[0] = {
    fullPage: options?.fullPage ?? false,
    animations: 'disabled',
    caret: 'hide',
  };

  if (options?.selector) {
    const el = page.locator(options.selector).first();
    return el.screenshot(screenshotOptions);
  }

  return page.screenshot(screenshotOptions);
}

// ---------------------------------------------------------------------------
// 1. Initial State Visual Test
// ---------------------------------------------------------------------------

test.describe('Visual: Initial State', () => {
  test('initial page layout matches baseline', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000); // Wait for fonts/icons to load

    const screenshot = await captureForComparison(page, 'initial-state');
    expect(screenshot).toMatchSnapshot('initial-state.png', {
      threshold: 0.2,
      maxDiffPixels: 1000,
    });
  });

  test('dropzone area is visually correct', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const screenshot = await captureForComparison(page, 'dropzone', {
      selector: '[data-testid="dropzone"]',
    });

    expect(screenshot).toMatchSnapshot('dropzone-initial.png', {
      threshold: 0.2,
      maxDiffPixels: 500,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. File Upload State Visual Test
// ---------------------------------------------------------------------------

test.describe('Visual: File Upload State', () => {
  test('file uploaded state shows metadata correctly', async ({ page }) => {
    await page.goto('/');

    // Upload a test file
    await injectTestFile(page, '/test-video-h264-baseline.mp4');
    await page.waitForTimeout(2000);

    // Capture the metadata display area
    const screenshot = await captureForComparison(page, 'file-uploaded', {
      selector: '[data-testid="dropzone"]',
    });

    expect(screenshot).toMatchSnapshot('dropzone-file-uploaded.png', {
      threshold: 0.2,
      maxDiffPixels: 500,
    });

    // Verify convert button is visually enabled
    const convertBtn = page.locator('[data-testid="convert-button"]');
    await expect(convertBtn).toBeEnabled();
    await expect(convertBtn).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// 3. Progress UI Visual Test
// ---------------------------------------------------------------------------

test.describe('Visual: Progress UI', () => {
  test('progress bar renders with correct segments', async ({ page }) => {
    await page.goto('/');

    // Upload file
    await injectTestFile(page, '/test-video-h264-baseline.mp4');
    await page.waitForTimeout(2000);

    // Start conversion
    const convertBtn = page.locator('[data-testid="convert-button"]');
    await convertBtn.click();

    // Handle warning dialog
    const proceedBtn = page.locator('button:has-text("Proceed")').first();
    const isWarningVisible = await proceedBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (isWarningVisible) {
      await proceedBtn.click();
    }

    // Wait for progress UI to appear
    await page.waitForTimeout(3000);

    // Capture progress bar area
    const progressBar = page.locator('[data-progress]').first();
    await expect(progressBar).toBeVisible({ timeout: 5000 });
    const screenshot = await captureForComparison(page, 'progress-bar', {
      selector: '[data-progress]',
    });

    expect(screenshot).toMatchSnapshot('progress-bar-active.png', {
      threshold: 0.3,
      maxDiffPixels: 1000,
    });

    // Wait for completion
    await page.waitForTimeout(60_000);
  });

  test('progress UI shows all required elements', async ({ page }) => {
    await page.goto('/');

    // Upload and convert
    await injectTestFile(page, '/test-video-h264-baseline.mp4');
    await page.waitForTimeout(2000);

    await page.locator('[data-testid="convert-button"]').click();

    const proceedBtn = page.locator('button:has-text("Proceed")').first();
    if (await proceedBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await proceedBtn.click();
    }

    await page.waitForTimeout(3000);

    // Verify all progress UI elements exist
    const progressRegion = page.locator('[data-testid="conversion-progress"]').first();
    await expect(progressRegion).toBeVisible({ timeout: 5000 });

    // Progress bar with data-progress attribute
    const progressBar = page.locator('[data-progress]').first();
    await expect(progressBar).toBeVisible();

    // Progress percentage text
    const progressText = page.locator('text=/\\d+%/').first();
    await expect(progressText).toBeVisible();

    // Elapsed time
    const elapsedText = page.locator('text=/Elapsed:/').first();
    await expect(elapsedText).toBeVisible({ timeout: 3000 });

    // Wait for completion
    await page.waitForTimeout(60_000);
  });
});

// ---------------------------------------------------------------------------
// 4. Result Section Visual Test
// ---------------------------------------------------------------------------

test.describe('Visual: Result Section', () => {
  test('result section renders correctly after conversion', async ({ page }) => {
    await page.goto('/');

    // Upload and convert
    await injectTestFile(page, '/test-video-h264-baseline.mp4');
    await page.waitForTimeout(2000);

    await page.locator('[data-testid="convert-button"]').click();

    const proceedBtn = page.locator('button:has-text("Proceed")').first();
    if (await proceedBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await proceedBtn.click();
    }

    // Wait for completion — GIF conversion can take 30-90s
    const resultSection = page.locator('[data-testid="result-section"]');
    await expect(resultSection).toBeVisible({ timeout: 180_000 });

    // Capture result section
    const screenshot = await captureForComparison(page, 'result-section', {
      selector: '[data-testid="result-section"]',
    });

    expect(screenshot).toMatchSnapshot('result-section.png', {
      threshold: 0.2,
      maxDiffPixels: 500,
    });

    // Verify download button
    const downloadBtn = page.locator('[data-testid="download-result-button"]');
    await expect(downloadBtn).toBeVisible();

    // Verify result image loaded
    const resultImage = page.locator('[data-testid="result-image"]');
    const isImageVisible = await resultImage.isVisible({ timeout: 10_000 }).catch(() => false);
    if (isImageVisible) {
      const naturalWidth = await resultImage.evaluate((el) => (el as HTMLImageElement).naturalWidth);
      expect(naturalWidth).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Theme Visual Test
// ---------------------------------------------------------------------------

test.describe('Visual: Theme', () => {
  test('dark mode renders correctly', async ({ page }) => {
    await page.goto('/');

    // Toggle dark mode
    const themeToggle = page.locator('[data-testid="theme-toggle"]');
    await themeToggle.click();
    await page.waitForTimeout(500);

    const screenshot = await captureForComparison(page, 'dark-mode');

    expect(screenshot).toMatchSnapshot('dark-mode.png', {
      threshold: 0.2,
      maxDiffPixels: 1000,
    });

    // Toggle back to light
    await themeToggle.click();
  });
});

// ---------------------------------------------------------------------------
// 6. Responsive Visual Test
// ---------------------------------------------------------------------------

test.describe('Visual: Responsive', () => {
  test('mobile viewport renders correctly', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const screenshot = await captureForComparison(page, 'mobile');

    expect(screenshot).toMatchSnapshot('mobile-viewport.png', {
      threshold: 0.2,
      maxDiffPixels: 1000,
    });
  });

  test('tablet viewport renders correctly', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const screenshot = await captureForComparison(page, 'tablet');

    expect(screenshot).toMatchSnapshot('tablet-viewport.png', {
      threshold: 0.2,
      maxDiffPixels: 1000,
    });
  });
});
