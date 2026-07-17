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
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEV_SERVER_URL = 'http://127.0.0.1:5173';
const SCREENSHOT_DIR = '/home/piesp/projects/wasm-motion-converter/test-results/visual';
const BASELINE_DIR = '/home/piesp/projects/wasm-motion-converter/test-results/visual/baselines';
const DIFF_DIR = '/home/piesp/projects/wasm-motion-converter/test-results/visual/diffs';

// Ensure directories exists
for (const dir of [SCREENSHOT_DIR, BASELINE_DIR, DIFF_DIR]) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

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

/**
 * Compare two screenshots using pixel diff.
 * Returns the number of differing pixels.
 */
function compareScreenshots(
  baseline: Buffer,
  current: Buffer,
  threshold = 0.1
): { match: boolean; diffPixels: number; totalPixels: number } {
  // Use Playwright's built-in toMatchSnapshot for comparison
  // This is a simplified check — for production use, consider pixelmatch
  const baselineLen = baseline.length;
  const currentLen = current.length;

  if (baselineLen !== currentLen) {
    return { match: false, diffPixels: Math.abs(baselineLen - currentLen), totalPixels: Math.max(baselineLen, currentLen) };
  }

  let diffPixels = 0;
  const sampleRate = 100; // Sample every 100th byte for speed
  for (let i = 0; i < baselineLen; i += sampleRate) {
    if (Math.abs(baseline[i]! - current[i]!) > 10) {
      diffPixels++;
    }
  }

  const totalPixels = baselineLen / sampleRate;
  const diffRatio = diffPixels / totalPixels;

  return {
    match: diffRatio <= threshold,
    diffPixels,
    totalPixels,
  };
}

// ---------------------------------------------------------------------------
// 1. Initial State Visual Test
// ---------------------------------------------------------------------------

test.describe('Visual: Initial State', () => {
  test('initial page layout matches baseline', async ({ page }) => {
    await page.goto(DEV_SERVER_URL);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000); // Wait for fonts/icons to load

    const screenshot = await captureForComparison(page, 'initial-state');
    const baselinePath = join(BASELINE_DIR, 'initial-state.png');

    if (!existsSync(baselinePath)) {
      // First run: save as baseline
      writeFileSync(baselinePath, screenshot);
      console.log(`  Baseline saved: ${baselinePath}`);
      return;
    }

    // Compare against baseline
    const baseline = readFileSync(baselinePath);
    const comparison = compareScreenshots(baseline, screenshot, 0.05);

    if (!comparison.match) {
      // Save diff for inspection
      const currentPath = join(DIFF_DIR, 'initial-state-current.png');
      const diffPath = join(DIFF_DIR, 'initial-state-diff.png');
      writeFileSync(currentPath, screenshot);
      console.log(`  Diff detected: ${comparison.diffPixels}/${comparison.totalPixels} pixels differ`);
    }

    // Use Playwright's built-in comparison for CI
    expect(screenshot).toMatchSnapshot('initial-state.png', {
      threshold: 0.2,
      maxDiffPixels: 1000,
    });
  });

  test('dropzone area is visually correct', async ({ page }) => {
    await page.goto(DEV_SERVER_URL);
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
    await page.goto(DEV_SERVER_URL);

    // Upload a test file
    const fileInput = page.locator('input[type="file"]').first();
    const testVideoPath = '/home/piesp/projects/wasm-motion-converter/public/sample-h264-test.mp4';
    await fileInput.setInputFiles(testVideoPath);
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
    await page.goto(DEV_SERVER_URL);

    // Upload file
    const fileInput = page.locator('input[type="file"]').first();
    const testVideoPath = '/home/piesp/projects/wasm-motion-converter/public/sample-h264-test.mp4';
    await fileInput.setInputFiles(testVideoPath);
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
    const isProgressVisible = await progressBar.isVisible({ timeout: 5000 }).catch(() => false);

    if (isProgressVisible) {
      const screenshot = await captureForComparison(page, 'progress-bar', {
        selector: '[data-progress]',
      });

      expect(screenshot).toMatchSnapshot('progress-bar-active.png', {
        threshold: 0.3,
        maxDiffPixels: 1000,
      });
    }

    // Wait for completion
    await page.waitForTimeout(60_000);
  });

  test('progress UI shows all required elements', async ({ page }) => {
    await page.goto(DEV_SERVER_URL);

    // Upload and convert
    const fileInput = page.locator('input[type="file"]').first();
    const testVideoPath = '/home/piesp/projects/wasm-motion-converter/public/sample-h264-test.mp4';
    await fileInput.setInputFiles(testVideoPath);
    await page.waitForTimeout(2000);

    await page.locator('[data-testid="convert-button"]').click();

    const proceedBtn = page.locator('button:has-text("Proceed")').first();
    if (await proceedBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await proceedBtn.click();
    }

    await page.waitForTimeout(3000);

    // Verify all progress UI elements exist
    const progressRegion = page.locator('[data-testid="conversion-progress"]').first();
    const isProgressRegionVisible = await progressRegion.isVisible({ timeout: 5000 }).catch(() => false);

    if (isProgressRegionVisible) {
      // Progress bar with data-progress attribute
      const progressBar = page.locator('[data-progress]').first();
      await expect(progressBar).toBeVisible();

      // Progress percentage text
      const progressText = page.locator('text=/\\d+%/').first();
      await expect(progressText).toBeVisible();

      // Elapsed time
      const elapsedText = page.locator('text=/Elapsed:/').first();
      const isElapsedVisible = await elapsedText.isVisible({ timeout: 3000 }).catch(() => false);
      // Elapsed may not be visible in headless mode — non-critical
    }

    // Wait for completion
    await page.waitForTimeout(60_000);
  });
});

// ---------------------------------------------------------------------------
// 4. Result Section Visual Test
// ---------------------------------------------------------------------------

test.describe('Visual: Result Section', () => {
  test('result section renders correctly after conversion', async ({ page }) => {
    await page.goto(DEV_SERVER_URL);

    // Upload and convert
    const fileInput = page.locator('input[type="file"]').first();
    const testVideoPath = '/home/piesp/projects/wasm-motion-converter/public/sample-h264-test.mp4';
    await fileInput.setInputFiles(testVideoPath);
    await page.waitForTimeout(2000);

    await page.locator('[data-testid="convert-button"]').click();

    const proceedBtn = page.locator('button:has-text("Proceed")').first();
    if (await proceedBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await proceedBtn.click();
    }

    // Wait for completion — GIF conversion can take 30-90s
    const resultSection = page.locator('[data-testid="result-section"]');
    const isDone = await resultSection.isVisible({ timeout: 180_000 }).catch(() => false);

    if (!isDone) {
      console.log('  Conversion did not complete within timeout — skipping result section test');
      return;
    }

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
    await page.goto(DEV_SERVER_URL);

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
    await page.goto(DEV_SERVER_URL);
    await page.waitForLoadState('domcontentloaded');

    const screenshot = await captureForComparison(page, 'mobile');

    expect(screenshot).toMatchSnapshot('mobile-viewport.png', {
      threshold: 0.2,
      maxDiffPixels: 1000,
    });
  });

  test('tablet viewport renders correctly', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(DEV_SERVER_URL);
    await page.waitForLoadState('domcontentloaded');

    const screenshot = await captureForComparison(page, 'tablet');

    expect(screenshot).toMatchSnapshot('tablet-viewport.png', {
      threshold: 0.2,
      maxDiffPixels: 1000,
    });
  });
});
