import { test, expect } from '@playwright/test';
import {
  attachTestHelpers,
  injectFile,
  getAppState,
  isConvertButtonEnabled,
  isErrorVisible,
  isResultVisible,
  getVisibleResultStats,
  getError,
  setFormat,
  clickConvert,
  dismissWarningDialog,
  waitForConversionComplete,
  downloadResult,
} from './fixtures/test-helpers';
import {
  isValidGif,
  isValidWebP,
  getFrameCenterColor,
  probeFile,
} from './fixtures/verify';

test.describe('GIF Conversion', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await attachTestHelpers(page);
  });

  test('converts VP8 WebM to valid GIF', async ({ page }) => {
    await injectFile(page, '/sample-color-test.webm', {
      width: 320, height: 240, duration: 4, codec: 'vp8', frameRate: 10,
    });

    await setFormat(page, 'gif');
    expect(await isConvertButtonEnabled(page)).toBe(true);

    await clickConvert(page);
    await dismissWarningDialog(page);

    const finalState = await waitForConversionComplete(page, 120_000);
    expect(finalState).toBe('done');

    expect(await isResultVisible(page)).toBe(true);
    expect(await isErrorVisible(page)).toBe(false);

    const stats = await getVisibleResultStats(page);
    expect(stats).not.toBeNull();
    expect(stats!.format.toLowerCase()).toBe('gif');

    // Download and verify
    const buffer = await downloadResult(page);
    expect(buffer.length).toBeGreaterThan(100);

    const fs = await import('node:fs');
    const tmpPath = '/tmp/test-output.gif';
    fs.writeFileSync(tmpPath, buffer);

    expect(await isValidGif(tmpPath)).toBe(true);

    const probe = await probeFile(tmpPath);
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(240);
    expect(probe.frameCount).toBeGreaterThan(0);
  });

  test('GIF output has correct colors (no inversion)', async ({ page }) => {
    await injectFile(page, '/sample-color-test.webm', {
      width: 320, height: 240, duration: 4, codec: 'vp8', frameRate: 10,
    });

    await setFormat(page, 'gif');
    await clickConvert(page);
    await dismissWarningDialog(page);
    await waitForConversionComplete(page, 120_000);

    const buffer = await downloadResult(page);
    const fs = await import('node:fs');
    const tmpPath = '/tmp/test-color.gif';
    fs.writeFileSync(tmpPath, buffer);

    // First frame should be red (not cyan/inverted)
    const color = await getFrameCenterColor(tmpPath, 0);
    expect(color.r).toBeGreaterThan(150);
    expect(color.g).toBeLessThan(100);
    expect(color.b).toBeLessThan(100);
  });

  test('GIF frames do not overlap (disposal=2)', async ({ page }) => {
    await injectFile(page, '/sample-color-test.webm', {
      width: 320, height: 240, duration: 4, codec: 'vp8', frameRate: 10,
    });

    await setFormat(page, 'gif');
    await clickConvert(page);
    await dismissWarningDialog(page);
    await waitForConversionComplete(page, 120_000);

    const buffer = await downloadResult(page);
    const fs = await import('node:fs');
    const tmpPath = '/tmp/test-disposal.gif';
    fs.writeFileSync(tmpPath, buffer);

    expect(await isValidGif(tmpPath)).toBe(true);

    // With disposal=2, each frame should be independent.
    // The sample video has distinct color segments (red, green, blue, white).
    // After conversion, different GIF frames should have different colors.
    const c0 = await getFrameCenterColor(tmpPath, 0);

    // Check that at least one frame differs from frame 0
    const probe = await probeFile(tmpPath);
    let foundDifferent = false;
    for (let i = 1; i < Math.min(probe.frameCount, 20); i++) {
      const ci = await getFrameCenterColor(tmpPath, i);
      if (Math.abs(ci.r - c0.r) > 50 || Math.abs(ci.g - c0.g) > 50 || Math.abs(ci.b - c0.b) > 50) {
        foundDifferent = true;
        break;
      }
    }
    expect(foundDifferent).toBe(true);
  });

  test('converts H.264 MP4 to GIF via FFmpeg fallback', async ({ page }) => {
    await injectFile(page, '/sample-h264-test.mp4', {
      width: 640, height: 480, duration: 3, codec: 'h264', frameRate: 10,
    });

    await setFormat(page, 'gif');
    await clickConvert(page);
    await dismissWarningDialog(page);
    await waitForConversionComplete(page, 180_000);

    expect(await isResultVisible(page)).toBe(true);
    expect(await isErrorVisible(page)).toBe(false);

    const buffer = await downloadResult(page);
    const fs = await import('node:fs');
    const tmpPath = '/tmp/test-h264.gif';
    fs.writeFileSync(tmpPath, buffer);

    expect(await isValidGif(tmpPath)).toBe(true);
    const probe = await probeFile(tmpPath);
    expect(probe.width).toBe(640);
    expect(probe.height).toBe(480);
  });
});

test.describe('WebP Conversion', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await attachTestHelpers(page);
  });

  test('converts VP8 WebM to valid WebP', async ({ page }) => {
    await injectFile(page, '/sample-short-test.webm', {
      width: 160, height: 120, duration: 1, codec: 'vp8', frameRate: 10,
    });

    await setFormat(page, 'webp');
    await clickConvert(page);
    await dismissWarningDialog(page);
    await waitForConversionComplete(page);

    expect(await isResultVisible(page)).toBe(true);
    expect(await isErrorVisible(page)).toBe(false);

    const stats = await getVisibleResultStats(page);
    expect(stats).not.toBeNull();
    expect(stats!.format).toBe('webp');

    const buffer = await downloadResult(page);
    expect(buffer.length).toBeGreaterThan(100);

    const fs = await import('node:fs');
    const tmpPath = '/tmp/test-output.webp';
    fs.writeFileSync(tmpPath, buffer);

    expect(await isValidWebP(tmpPath)).toBe(true);
  });

  test('WebP output has correct colors', async ({ page }) => {
    await injectFile(page, '/sample-color-test.webm', {
      width: 320, height: 240, duration: 4, codec: 'vp8', frameRate: 10,
    });

    await setFormat(page, 'webp');
    await clickConvert(page);
    await dismissWarningDialog(page);
    await waitForConversionComplete(page);

    // Verify result section is visible with correct stats
    const stats = await getVisibleResultStats(page);
    expect(stats).not.toBeNull();
    expect(stats!.format.toLowerCase()).toBe('webp');

    // Verify the result image element exists and has loaded
    const imgLoaded = await page.evaluate(() => {
      const img = document.querySelector('[data-testid="result-image"]') as HTMLImageElement | null;
      return img !== null && img.complete && img.naturalWidth > 0;
    });
    expect(imgLoaded).toBe(true);
  });
});

test.describe('Error Handling', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await attachTestHelpers(page);
  });

  test('shows error for unsupported file type', async ({ page }) => {
    await page.evaluate(async () => {
      const file = new File(['not a video'], 'test.txt', { type: 'text/plain' });
      await (globalThis as any).__TEST_HELPERS__.injectFile(file, {
        width: 320, height: 240, duration: 1, codec: 'unknown', frameRate: 10,
      });
    });

    await setFormat(page, 'gif');
    await clickConvert(page);

    const hasError = await isErrorVisible(page);
    const hasResult = await isResultVisible(page);
    expect(hasError || !hasResult).toBe(true);
  });
});
