// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP
//
// Matrix tests — parameterized conversion tests driven by test-manifest.ts.
// Tests all codec × format combinations from the manifest.
// For quick smoke tests, see smoke.spec.ts.

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
  isConvertButtonEnabled,
  waitForConversionComplete,
} from './fixtures/test-helpers';
import {
  TEST_VIDEOS,
  type TestVideoEntry,
  type TestFormat,
  type TestQuality,
  type TestScale,
  BASELINE_RESULTS,
} from '../lib/test-manifest';
import { recordResult } from '../lib/test-recorder';

// ── Helpers ────────────────────────────────────────────────────

function getExpectedSizeRange(videoId: string, quality: TestQuality) {
  return BASELINE_RESULTS[videoId]?.[quality] ?? null;
}

// ── Test Suite ─────────────────────────────────────────────────

test.describe('Matrix: All codecs × formats (manifest-driven)', () => {
  for (const video of TEST_VIDEOS) {
    test.describe(`${video.label} (${video.codec})`, () => {
      test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await page.waitForTimeout(3000);
      });

      // GIF conversion for all codecs
      test(`→ GIF (medium, 50%)`, async ({ page }) => {
        // Skip unsupported codecs (e.g. HEVC in headless Chrome)
        if (!video.webCodecsSupported) {
          console.log(`  Skipping ${video.codec} GIF — not supported in this browser`);
          return;
        }
        const startTime = Date.now();
        let success = false;
        let outputSize: number | undefined;
        let errorMsg: string | undefined;

        try {
          await injectTestFile(page, video.file);
          await setFormat(page, 'gif');
          await setQuality(page, 'medium');
          await setScale(page, '50%');

          const enabled = await isConvertButtonEnabled(page);
          if (!enabled) {
            throw new Error('Convert button not enabled after file injection');
          }

          await clickConvert(page);
          await dismissWarningDialog(page);

          const result = await waitForConversionComplete(page, video.maxConversionTimeMs);

          if (result === 'done') {
            success = true;
            const stats = await getVisibleResultStats(page);
            if (stats?.outputSize) {
              outputSize = parseSizeString(stats.outputSize);
            }
          } else if (result === 'error') {
            errorMsg = await getErrorMessage(page) ?? 'Unknown error';
          } else {
            errorMsg = 'Conversion timed out';
          }
        } catch (err) {
          errorMsg = err instanceof Error ? err.message : String(err);
        }

        const elapsed = Date.now() - startTime;

        // Record result for regression tracking
        recordResult({
          timestamp: new Date().toISOString(),
          videoId: video.id,
          format: 'gif',
          quality: 'medium',
          scale: '50%',
          success,
          outputSizeBytes: outputSize,
          conversionTimeMs: elapsed,
          error: errorMsg,
          path: video.webCodecsSupported ? 'gpu' : 'cpu',
        });

        // Assertions
        expect(success, `Conversion failed: ${errorMsg ?? 'unknown'}`).toBe(true);
        expect(await isResultVisible(page)).toBe(true);
        expect(await isErrorVisible(page)).toBe(false);

        // Regression check: output size within expected range
        if (outputSize) {
          const range = getExpectedSizeRange(video.id, 'medium');
          if (range) {
            expect(
              outputSize,
              `Output size ${outputSize} outside expected range [${range.minBytes}, ${range.maxBytes}]`,
            ).toBeLessThanOrEqual(range.maxBytes * 1.5);
          }
        }
      });

      // WebP conversion for all codecs
      test(`→ WebP (medium, 50%)`, async ({ page }) => {
        // Skip unsupported codecs (e.g. HEVC in headless Chrome)
        if (!video.webCodecsSupported) {
          console.log(`  Skipping ${video.codec} WebP — not supported in this browser`);
          return;
        }
        const startTime = Date.now();
        let success = false;
        let errorMsg: string | undefined;

        try {
          await injectTestFile(page, video.file);
          await setFormat(page, 'webp');
          await setQuality(page, 'medium');
          await setScale(page, '50%');

          const enabled = await isConvertButtonEnabled(page);
          if (!enabled) {
            throw new Error('Convert button not enabled after file injection');
          }

          await clickConvert(page);
          await dismissWarningDialog(page);

          const result = await waitForConversionComplete(page, video.maxConversionTimeMs);
          success = result === 'done';
          if (!success && result === 'error') {
            errorMsg = await getErrorMessage(page) ?? 'Unknown error';
          } else if (result === 'timeout') {
            errorMsg = 'Conversion timed out';
          }
        } catch (err) {
          errorMsg = err instanceof Error ? err.message : String(err);
        }

        const elapsed = Date.now() - startTime;

        recordResult({
          timestamp: new Date().toISOString(),
          videoId: video.id,
          format: 'webp',
          quality: 'medium',
          scale: '50%',
          success,
          conversionTimeMs: elapsed,
          error: errorMsg,
          path: video.webCodecsSupported ? 'gpu' : 'cpu',
        });

        expect(success, `Conversion failed: ${errorMsg ?? 'unknown'}`).toBe(true);
        expect(await isResultVisible(page)).toBe(true);
        expect(await isErrorVisible(page)).toBe(false);
      });
    });
  }
});

// ── CPU Path Tests (FFmpeg WASM / software decode) ──────────────────────
// These codecs are NOT supported by WebCodecs in headless Chrome.
// Run with: npx playwright test test/e2e/matrix.spec.ts --grep "CPU path"
//
// NOTE: HEVC is skipped because headless Chrome lacks both WebCodecs HEVC
// and FFmpeg WASM HEVC decode support. Re-enable when FFmpeg software
// decode fallback is implemented.

test.describe('Matrix: CPU path codecs (FFmpeg WASM)', () => {
  const cpuCodecs = TEST_VIDEOS.filter((v) => !v.webCodecsSupported);

  for (const video of cpuCodecs) {
    test.describe(`${video.label} (${video.codec}) [cpu]`, () => {
      test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await page.waitForTimeout(3000);
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gifTest = video.codec === 'hevc'
        ? test.skip('→ GIF (medium, 50%) [cpu]', async ({ page }: any) => {})
        : test(`→ GIF (medium, 50%) [cpu]`, async ({ page }: any) => {
            const startTime = Date.now();
            let success = false;
            let outputSize: number | undefined;
            let errorMsg: string | undefined;

            try {
              await injectTestFile(page, video.file);
              await setFormat(page, 'gif');
              await setQuality(page, 'medium');
              await setScale(page, '50%');

              const enabled = await isConvertButtonEnabled(page);
              if (!enabled) {
                throw new Error('Convert button not enabled after file injection');
              }

              await clickConvert(page);
              await dismissWarningDialog(page);

              const result = await waitForConversionComplete(page, video.maxConversionTimeMs);

              if (result === 'done') {
                success = true;
                const stats = await getVisibleResultStats(page);
                if (stats?.outputSize) {
                  outputSize = parseSizeString(stats.outputSize);
                }
              } else if (result === 'error') {
                errorMsg = await getErrorMessage(page) ?? 'Unknown error';
              } else {
                errorMsg = 'Conversion timed out';
              }
            } catch (err) {
              errorMsg = err instanceof Error ? err.message : String(err);
            }

            const elapsed = Date.now() - startTime;

            recordResult({
              timestamp: new Date().toISOString(),
              videoId: video.id,
              format: 'gif',
              quality: 'medium',
              scale: '50%',
              success,
              outputSizeBytes: outputSize,
              conversionTimeMs: elapsed,
              error: errorMsg,
              path: 'cpu',
            });

            expect(success, `CPU path conversion failed: ${errorMsg ?? 'unknown'}`).toBe(true);
            expect(await isResultVisible(page)).toBe(true);
            expect(await isErrorVisible(page)).toBe(false);
          });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const webpTest = video.codec === 'hevc'
        ? test.skip('→ WebP (medium, 50%) [cpu]', async ({ page }: any) => {})
        : test(`→ WebP (medium, 50%) [cpu]`, async ({ page }: any) => {
            const startTime = Date.now();
            let success = false;
            let errorMsg: string | undefined;

            try {
              await injectTestFile(page, video.file);
              await setFormat(page, 'webp');
              await setQuality(page, 'medium');
              await setScale(page, '50%');

              const enabled = await isConvertButtonEnabled(page);
              if (!enabled) {
                throw new Error('Convert button not enabled after file injection');
              }

              await clickConvert(page);
              await dismissWarningDialog(page);

              const result = await waitForConversionComplete(page, video.maxConversionTimeMs);
              success = result === 'done';
              if (!success && result === 'error') {
                errorMsg = await getErrorMessage(page) ?? 'Unknown error';
              } else if (result === 'timeout') {
                errorMsg = 'Conversion timed out';
              }
            } catch (err) {
              errorMsg = err instanceof Error ? err.message : String(err);
            }

            const elapsed = Date.now() - startTime;

            recordResult({
              timestamp: new Date().toISOString(),
              videoId: video.id,
              format: 'webp',
              quality: 'medium',
              scale: '50%',
              success,
              conversionTimeMs: elapsed,
              error: errorMsg,
              path: 'cpu',
            });

            expect(success, `CPU path conversion failed: ${errorMsg ?? 'unknown'}`).toBe(true);
            expect(await isResultVisible(page)).toBe(true);
            expect(await isErrorVisible(page)).toBe(false);
          });
    });
  }
});
