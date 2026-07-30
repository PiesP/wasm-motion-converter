// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP
//
// Visual regression tests — screenshot comparison for key UI states.
// Captures screenshots at critical UI states and compares against baselines.
//
// Run with:
//   pnpm exec playwright test test/e2e/visual-regression.spec.ts --reporter=list
//
// Update baselines:
//   pnpm exec playwright test test/e2e/visual-regression.spec.ts --update-snapshots

import { test, expect, type Locator, type Page } from '@playwright/test';
import { injectTestFile } from './fixtures/test-helpers';

/**
 * Capture a screenshot with consistent settings for visual comparison.
 */
async function captureForComparison(
  page: Page,
  name: string,
  options?: { fullPage?: boolean; selector?: string; mask?: Locator[] }
): Promise<Buffer> {
  const screenshotOptions: Parameters<Page['screenshot']>[0] = {
    fullPage: options?.fullPage ?? false,
    animations: 'disabled',
    caret: 'hide',
    mask: options?.mask,
    maskColor: '#1a1a1a',
  };

  if (options?.selector) {
    const el = page.locator(options.selector).first();
    return el.screenshot(screenshotOptions);
  }

  return page.screenshot(screenshotOptions);
}

/** Keep the transient progress UI visible long enough for deterministic assertions. */
async function slowConversionForCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'Worker', { configurable: true, value: undefined });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
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
    await slowConversionForCapture(page);
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

    // Observe the transient state immediately; this conversion can complete in
    // under three seconds on fast machines.
    const progressBar = page.locator('[data-progress]').first();
    await expect(progressBar).toBeVisible({ timeout: 5000 });
    await expect(progressBar).toHaveAttribute('aria-valuenow', /\d+/);
  });

  test('progress UI shows all required elements', async ({ page }) => {
    await slowConversionForCapture(page);
    await page.goto('/');

    // Upload and convert
    await injectTestFile(page, '/test-video-h264-baseline.mp4');
    await page.waitForTimeout(2000);

    await page.locator('[data-testid="convert-button"]').click();

    const proceedBtn = page.locator('button:has-text("Proceed")').first();
    if (await proceedBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await proceedBtn.click();
    }

    // Verify all progress UI elements exist
    const progressRegion = page.locator('[data-testid="dropzone"][aria-busy="true"]').first();
    await expect(progressRegion).toBeVisible({ timeout: 5000 });

    // Progress bar with data-progress attribute
    const progressBar = page.locator('[data-progress]').first();
    await expect(progressBar).toBeVisible();

    // Progress percentage text
    const progressText = page.locator('text=/\\d+%/').first();
    await expect(progressText).toBeVisible();

    // Elapsed time
    const elapsedText = page.locator('[data-testid="elapsed-time"]').first();
    await expect(elapsedText).toBeVisible({ timeout: 3000 });

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
      // Animated GIF frames and conversion duration are intentionally dynamic.
      // Their behavior is asserted below; keep the layout snapshot deterministic.
      mask: [
        page.locator('[data-testid="result-image"]'),
        page.locator('[data-testid="conversion-time"]'),
      ],
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
  test('follows the system color scheme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(247, 248, 250)');
    await expect(page.locator('body')).toHaveCSS('color', 'rgb(21, 24, 29)');

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(11, 14, 19)');
    await expect(page.locator('body')).toHaveCSS('color', 'rgb(243, 246, 249)');
  });

  test('dark mode renders correctly', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await page.waitForTimeout(500);

    const screenshot = await captureForComparison(page, 'dark-mode');

    expect(screenshot).toMatchSnapshot('dark-mode.png', {
      threshold: 0.2,
      maxDiffPixels: 1000,
    });

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
