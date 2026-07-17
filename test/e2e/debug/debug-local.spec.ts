// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP
//
// Debug: diagnose conversion issues on local dev server.
// Run with: pnpm test -- debug/debug-local.spec.ts

import { test, expect } from '@playwright/test';
import {
  injectTestFile,
  setFormat,
  setQuality,
  setScale,
  clickConvert,
  dismissWarningDialog,
  getAppState,
  waitForConversionComplete,
  getErrorMessage,
} from '../fixtures/test-helpers';

const PUBLIC_DIR = '/home/piesp/projects/wasm-motion-converter/public';

test.describe('Debug: Local Server Diagnosis', () => {
  test('page loads and FFmpeg becomes available', async ({ page }) => {
    const logs: string[] = [];
    page.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        logs.push(`[${type}] ${msg.text()}`);
      }
    });

    await page.goto('/');
    await page.waitForTimeout(5000);

    // Check environment
    const env = await page.evaluate(() => ({
      crossOriginIsolated: window.crossOriginIsolated,
      hasTestHelpers: typeof window.__TEST_HELPERS__ !== 'undefined',
    }));
    console.log(`  Environment: ${JSON.stringify(env)}`);

    // Inject file
    const input = page.locator('input[type="file"]').first();
    await input.setInputFiles(`${PUBLIC_DIR}/test-video-h264-baseline.mp4`);
    console.log('  File injected');

    await page.waitForTimeout(3000);

    // Check state after injection
    const state = await getAppState(page);
    console.log(`  App state after injection: ${state}`);

    // Configure and convert
    await setFormat(page, 'gif');
    await setQuality(page, 'medium');
    await setScale(page, '50%');
    console.log('  Settings: GIF, medium, 50%');

    await clickConvert(page);
    await dismissWarningDialog(page);
    console.log('  Convert clicked');

    // Monitor progress
    const finalState = await waitForConversionComplete(page, 120_000);
    console.log(`  Final state: ${finalState}`);

    if (finalState === 'error') {
      const error = await getErrorMessage(page);
      console.log(`  Error: ${error}`);
    }

    // Print browser errors
    if (logs.length > 0) {
      console.log('\n  Browser errors/warnings:');
      for (const log of logs.slice(0, 20)) {
        console.log(`    ${log}`);
      }
    }

    expect(finalState).toBe('done');
  });
});
