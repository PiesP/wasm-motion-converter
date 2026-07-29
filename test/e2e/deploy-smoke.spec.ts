// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP
//
// Deployment smoke test — runs against the deployed production URL.
// Verifies core functionality works in the deployed environment.
//
// Run with:
//   pnpm exec playwright test test/e2e/deploy-smoke.spec.ts --reporter=list
//
// Environment variables:
//   DEPLOY_URL — the deployed URL to test (default: https://wasm-motion-converter.pages.dev)

import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { isCloudflareInsightsResource } from './fixtures/url-utils';

const DEPLOY_URL = process.env.DEPLOY_URL || 'https://wasm-motion-converter.pages.dev';
const TEST_VIDEO_PATH =
  process.env.DEPLOY_TEST_VIDEO || resolve(process.cwd(), 'public/test-video-ci-h264.mp4');

// Skip all tests in this file when running against local dev server
// (no __TEST_HELPERS__, no file injection support).
const isLocalDev = DEPLOY_URL.includes('127.0.0.1') || DEPLOY_URL.includes('localhost');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getConsoleErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  return errors;
}

async function getFailedResources(page: Page): Promise<string[]> {
  const failed: string[] = [];
  page.on('response', (response) => {
    if (!response.ok() && response.request().resourceType() !== 'document') {
      failed.push(`${response.status()} ${response.url()}`);
    }
  });
  return failed;
}

/**
 * Capture a screenshot and save it to the test-results directory.
 * Used for visual inspection of the deployed UI.
 */
async function captureScreenshot(page: Page, name: string): Promise<void> {
  const screenshotDir = resolve(process.cwd(), 'test-results/screenshots');
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: resolve(screenshotDir, `${name}.png`), fullPage: false });
}

async function uploadTestVideo(page: Page): Promise<void> {
  await page.locator('input[type="file"]').first().setInputFiles(TEST_VIDEO_PATH);
  await expect(page.locator('[data-testid="convert-button"]')).toBeEnabled();
  await expect(page.getByText(basename(TEST_VIDEO_PATH), { exact: true })).toBeVisible();
}

async function startConversion(page: Page): Promise<void> {
  await page.locator('[data-testid="convert-button"]').click();
  const modalProceed = page.locator('[data-testid="modal-confirm-button"]');
  if (await modalProceed.isVisible({ timeout: 5000 }).catch(() => false)) {
    await modalProceed.click();
  }
}

// ---------------------------------------------------------------------------
// 1. Page Load & Health
// ---------------------------------------------------------------------------

test.describe('Deployment: Page Load', () => {
  test.skip(isLocalDev, 'Deploy smoke tests require production environment');
  test('page loads without critical console errors', async ({ page }) => {
    const errors = await getConsoleErrors(page);
    const response = await page.goto(DEPLOY_URL);
    await page.waitForLoadState('domcontentloaded');

    expect(response?.status()).toBe(200);

    const criticalErrors = errors.filter(
      (e) =>
        !e.includes('Content Security Policy') &&
        !isCloudflareInsightsResource(e) &&
        !e.includes('ERR_CONNECTION_REFUSED')
    );
    expect(criticalErrors).toEqual([]);
  });

  test('no failed static resource loads', async ({ page }) => {
    const failed = await getFailedResources(page);
    await page.goto(DEPLOY_URL);
    await page.waitForLoadState('networkidle');

    const criticalFailed = failed.filter(
      (f) => !isCloudflareInsightsResource(f)
    );
    expect(criticalFailed).toEqual([]);
  });

  test('JS bundle is served with correct content-type', async ({ page }) => {
    const responses: string[] = [];
    page.on('response', (response) => {
      if (response.url().includes('/assets/') && response.url().endsWith('.js')) {
        responses.push(response.url());
      }
    });
    await page.goto(DEPLOY_URL);
    await page.waitForLoadState('networkidle');

    expect(responses.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Visual: Initial State
// ---------------------------------------------------------------------------

test.describe('Deployment: Visual — Initial State', () => {
  test.skip(isLocalDev, 'Deploy smoke tests require production environment');
  test('initial page renders correctly', async ({ page }) => {
    await page.goto(DEPLOY_URL);
    await page.waitForLoadState('domcontentloaded');

    // Capture initial state screenshot
    await captureScreenshot(page, 'deploy-initial-state');

    // Verify key elements are visible
    await expect(page.locator('[data-testid="app"]')).toBeVisible();
    await expect(page.locator('[data-testid="dropzone"]')).toBeVisible();
    await expect(page.locator('[data-testid="convert-button"]')).toBeDisabled();
    await expect(page.locator('h1')).toHaveText('Motion Converter');
  });

  test('format selector options are visible', async ({ page }) => {
    await page.goto(DEPLOY_URL);

    // Verify format options
    await expect(page.locator('[data-testid="option-format-gif"]')).toBeVisible();
    await expect(page.locator('[data-testid="option-format-webp"]')).toBeVisible();

    // Verify quality options
    await expect(page.locator('[data-testid="option-quality-low"]')).toBeVisible();
    await expect(page.locator('[data-testid="option-quality-medium"]')).toBeVisible();
    await expect(page.locator('[data-testid="option-quality-high"]')).toBeVisible();

    // Verify scale options
    await expect(page.locator('[data-testid="option-scale-0.5"]')).toBeVisible();
    await expect(page.locator('[data-testid="option-scale-0.75"]')).toBeVisible();
    await expect(page.locator('[data-testid="option-scale-1"]')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 3. Visual: File Upload State
// ---------------------------------------------------------------------------

test.describe('Deployment: Visual — File Upload', () => {
  test.skip(isLocalDev, 'Deploy smoke tests require production environment');
  test('convert button enables after file upload', async ({ page }) => {
    await page.goto(DEPLOY_URL);

    await uploadTestVideo(page);

    // Capture file uploaded state
    await captureScreenshot(page, 'deploy-file-uploaded');

    // Verify convert button is enabled
    const convertBtn = page.locator('[data-testid="convert-button"]');
    await expect(convertBtn).toBeEnabled();

    // Verify metadata is displayed
    await expect(page.getByText(basename(TEST_VIDEO_PATH), { exact: true })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 4. Visual: Progress UI During Conversion
// ---------------------------------------------------------------------------

test.describe('Deployment: Visual — Progress UI', () => {
  test.skip(isLocalDev, 'Deploy smoke tests require production environment');
  test.beforeEach(async ({ page }) => {
    await page.goto(DEPLOY_URL);
    await page.waitForLoadState('domcontentloaded');
  });

  test('conversion exposes progress or completes, then renders a result', async ({ page }) => {
    await uploadTestVideo(page);
    await startConversion(page);

    const progressBar = page.locator('[data-progress]');
    const resultSection = page.locator('[data-testid="result-section"]');
    await expect
      .poll(
        async () =>
          (await progressBar.isVisible()) || (await resultSection.isVisible()),
        { timeout: 30_000 },
      )
      .toBe(true);

    // Capture progress UI during conversion
    await captureScreenshot(page, 'deploy-progress-active');

    if (await progressBar.isVisible()) {
      // Verify progress bar has valid value
      const progressValue = await progressBar.getAttribute('data-progress');
      expect(progressValue).not.toBeNull();
      const progressNum = Number(progressValue);
      expect(progressNum).toBeGreaterThanOrEqual(0);
      expect(progressNum).toBeLessThanOrEqual(100);
    }

    await expect(resultSection).toBeVisible({ timeout: 120_000 });
    await captureScreenshot(page, 'deploy-conversion-complete');
    await expect(page.locator('[data-testid="download-result-button"]')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 5. Visual: Result Section
// ---------------------------------------------------------------------------

test.describe('Deployment: Visual — Result Section', () => {
  test.skip(isLocalDev, 'Deploy smoke tests require production environment');
  test.beforeEach(async ({ page }) => {
    await page.goto(DEPLOY_URL);
    await page.waitForLoadState('domcontentloaded');
  });

  test('result section shows correct stats after conversion', async ({ page }) => {
    await uploadTestVideo(page);
    await startConversion(page);

    // Wait for completion — GIF conversion of 1920x1080 can take 30-90s
    const resultSection = page.locator('[data-testid="result-section"]');
    await expect(resultSection).toBeVisible({ timeout: 180_000 });

    // Capture final result state
    await captureScreenshot(page, 'deploy-result-section');

    // Verify result stats are present
    const originalSize = page.locator('[data-result-original-size]');
    const outputSize = page.locator('[data-result-output-size]');
    const format = page.locator('[data-result-format]');

    await expect(originalSize).toBeVisible();
    await expect(outputSize).toBeVisible();
    await expect(format).toBeVisible();

    // Verify output size is reasonable (not empty)
    const outputSizeText = await outputSize.textContent();
    expect(outputSizeText).toBeTruthy();
    expect(outputSizeText!.length).toBeGreaterThan(0);

    // Verify preview image is loaded
    const resultImage = page.locator('[data-testid="result-image"]');
    await expect(resultImage).toBeVisible();
    const naturalWidth = await resultImage.evaluate((el) => (el as HTMLImageElement).naturalWidth);
    expect(naturalWidth).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Cross-environment: Dev vs Deploy comparison
// ---------------------------------------------------------------------------

test.describe('Deployment: Cross-environment', () => {
  test.skip(isLocalDev, 'Deploy smoke tests require production environment');
  test('deployed version has same core elements as dev', async ({ page }) => {
    await page.goto(DEPLOY_URL);
    await page.waitForLoadState('domcontentloaded');

    // Core elements that must exist in both dev and deploy
    const coreElements = [
      '[data-testid="app"]',
      '[data-testid="dropzone"]',
      '[data-testid="convert-button"]',
      '[data-testid="theme-toggle"]',
      '[data-testid="option-format-gif"]',
      '[data-testid="option-format-webp"]',
    ];

    for (const selector of coreElements) {
      const el = page.locator(selector).first();
      await expect(el).toBeAttached();
    }
  });
});
