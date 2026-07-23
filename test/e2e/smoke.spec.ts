// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP
//
// Smoke tests — verify core conversion paths work end-to-end.
// Fast, minimal coverage: one codec per path, one format per codec.
// For full matrix coverage, see matrix.spec.ts.

import { test, expect } from '@playwright/test';
import {
  injectTestFile,
  parseSizeString,
  setFormat,
  setQuality,
  setScale,
  clickConvert,
  dismissWarningDialog,
  isResultVisible,
  isErrorVisible,
  getVisibleResultStats,
  getErrorMessage,
  getAppState,
  isConvertButtonEnabled,
  waitForConversionComplete,
  downloadResult,
  runConversion,
} from './fixtures/test-helpers';
import { isValidGif, isValidWebP, validateFileMagic } from './fixtures/verify';

test.describe('Smoke: H.264 → GIF (WebCodecs path)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for app to be ready (idle state)
    await page.waitForTimeout(2000);
  });

  test('converts H.264 baseline MP4 to valid GIF', async ({ page }) => {
    const { state, error } = await runConversion(page, {
      file: 'test-video-h264-baseline.mp4',
      format: 'gif',
      quality: 'medium',
      scale: '50%',
      timeoutMs: 120_000,
    });

    if (state === 'error') {
      console.log('Conversion error:', error);
      const logs = await page.evaluate(() => {
        return (window as any).__LAST_ERROR__ || 'no error captured';
      });
      console.log('Browser error:', logs);
    }

    expect(state).toBe('done');
  });
});

test.describe('Smoke: H.264 → WebP', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
  });

  test('converts H.264 MP4 to valid WebP', async ({ page }) => {
    const { state, error } = await runConversion(page, {
      file: 'test-video-h264-baseline.mp4',
      format: 'webp',
      quality: 'medium',
      scale: '50%',
      timeoutMs: 120_000,
    });

    expect(state).toBe('done');

    // Wait for result section to appear (queueMicrotask defers setConversionResults)
    await page.waitForTimeout(1000);
    const resultVisible = await page.evaluate(() => window.__TEST_HELPERS__?.isResultVisible() ?? false);
    if (!resultVisible) {
      // Extra wait for slow environments
      await page.waitForTimeout(2000);
    }

    expect(await isResultVisible(page)).toBe(true);
    expect(await isErrorVisible(page)).toBe(false);
  });
});

test.describe('Smoke: Result validation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
  });

  test('GIF result has valid structure and reasonable size', async ({ page }) => {
    const { state } = await runConversion(page, {
      file: 'test-video-h264-baseline.mp4',
      format: 'gif',
      quality: 'medium',
      scale: '50%',
      timeoutMs: 120_000,
    });

    expect(state).toBe('done');

    // Verify result stats are visible
    const stats = await getVisibleResultStats(page);
    expect(stats).not.toBeNull();
    expect(stats!.format.toLowerCase()).toBe('gif');
    expect(stats!.outputSize).toBeTruthy();
    expect(stats!.originalSize).toBeTruthy();

    // Verify output size is reasonable (not empty, not absurdly large)
    const outputBytes = parseSizeString(stats!.outputSize);
    expect(outputBytes).toBeGreaterThan(1000); // At least 1KB
    expect(outputBytes).toBeLessThan(500 * 1024 * 1024); // Less than 500MB

    // Download and validate magic bytes
    const buffer = await downloadResult(page);
    expect(buffer.length).toBeGreaterThan(100);

    const validation = validateFileMagic(buffer, 'gif');
    expect(validation.valid).toBe(true);
    expect(validation.message).toBe('Valid GIF');

    // Verify GIF dimensions are reasonable
    if (validation.width && validation.height) {
      expect(validation.width).toBeGreaterThan(0);
      expect(validation.height).toBeGreaterThan(0);
      // At 50% scale, 1920x1080 → 960x540
      expect(validation.width).toBeLessThanOrEqual(1920);
      expect(validation.height).toBeLessThanOrEqual(1080);
    }
  });

  test('WebP result has valid structure and reasonable size', async ({ page }) => {
    const { state } = await runConversion(page, {
      file: 'test-video-h264-baseline.mp4',
      format: 'webp',
      quality: 'medium',
      scale: '50%',
      timeoutMs: 120_000,
    });

    expect(state).toBe('done');

    const stats = await getVisibleResultStats(page);
    expect(stats).not.toBeNull();
    expect(stats!.format.toLowerCase()).toBe('webp');

    // WebP should be significantly smaller than GIF
    const outputBytes = parseSizeString(stats!.outputSize);
    expect(outputBytes).toBeGreaterThan(1000);
    expect(outputBytes).toBeLessThan(100 * 1024 * 1024); // Less than 100MB

    // Download and validate magic bytes
    const buffer = await downloadResult(page);
    expect(buffer.length).toBeGreaterThan(100);

    const validation = validateFileMagic(buffer, 'webp');
    expect(validation.valid).toBe(true);
    expect(validation.message).toBe('Valid WebP');
  });

  test('WebP output is smaller than GIF for same input', async ({ page }) => {
    // Run GIF conversion
    const gifResult = await runConversion(page, {
      file: 'test-video-h264-baseline.mp4',
      format: 'gif',
      quality: 'medium',
      scale: '50%',
      timeoutMs: 120_000,
    });
    expect(gifResult.state).toBe('done');
    const gifStats = await getVisibleResultStats(page);
    const gifBytes = parseSizeString(gifStats!.outputSize);

    // Reset and run WebP conversion
    await page.evaluate(() => window.__TEST_HELPERS__?.resetApp());
    await page.waitForTimeout(1000);

    const webpResult = await runConversion(page, {
      file: 'test-video-h264-baseline.mp4',
      format: 'webp',
      quality: 'medium',
      scale: '50%',
      timeoutMs: 120_000,
    });
    expect(webpResult.state).toBe('done');
    const webpStats = await getVisibleResultStats(page);
    const webpBytes = parseSizeString(webpStats!.outputSize);

    // WebP should be smaller than GIF (inter-frame compression absent in current
    // keyframe-only encoder, so we expect modest savings at medium quality).
    const savingsPercent = ((1 - webpBytes! / gifBytes!) * 100).toFixed(1);
    console.log(`  GIF: ${gifStats!.outputSize}, WebP: ${webpStats!.outputSize}, Savings: ${savingsPercent}%`);
    expect(webpBytes!).toBeLessThan(gifBytes!);
  });
});

test.describe('Smoke: Error handling', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
  });

  test('shows error for unsupported file type', async ({ page }) => {
    const fs = await import('node:fs');
    const tmpFile = '/tmp/test-invalid.txt';
    fs.writeFileSync(tmpFile, 'not a video');

    const file = page.locator('input[type="file"]').first();
    await file.setInputFiles(tmpFile);
    await page.waitForTimeout(2000);

    const btn = page.locator('button[data-testid="convert-button"]');
    const disabled = await btn.evaluate((el) => (el as HTMLButtonElement).disabled);
    expect(disabled).toBe(true);
  });

  test('progress increases during conversion', async ({ page }) => {
    await injectTestFile(page, 'test-video-h264-baseline.mp4');
    await setFormat(page, 'gif');
    await setQuality(page, 'medium');
    await setScale(page, '50%');

    await clickConvert(page);
    await dismissWarningDialog(page);

    const initialProgress = await page.evaluate(() => window.__TEST_HELPERS__?.getProgress() ?? 0);
    expect(initialProgress).toBeGreaterThanOrEqual(0);

    let attempts = 0;
    let progressIncreased = false;
    while (attempts < 20) {
      await page.waitForTimeout(1000);
      const currentProgress = await page.evaluate(() => window.__TEST_HELPERS__?.getProgress() ?? 0);
      const currentState = await getAppState(page);
      attempts++;

      if (currentProgress > 0) {
        progressIncreased = true;
        console.log(`  Progress increased to ${currentProgress}% after ${attempts}s`);
        break;
      }
      if (currentState === 'done' || currentState === 'error') {
        console.log(`  State changed to ${currentState} after ${attempts}s`);
        break;
      }
    }

    expect(progressIncreased || (await getAppState(page)) !== 'converting').toBe(true);

    const finalState = await waitForConversionComplete(page, 120_000);
    expect(finalState).toBe('done');
  });
});
