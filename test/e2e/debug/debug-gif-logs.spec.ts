// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP
//
// Debug: capture console logs from GIF conversion.
// Run with: pnpm test -- debug/debug-gif-logs.spec.ts

import { test, expect } from '@playwright/test';
import {
  injectTestFile,
  setFormat,
  setQuality,
  setScale,
  clickConvert,
  dismissWarningDialog,
  waitForConversionComplete,
} from '../fixtures/test-helpers';

const PUBLIC_DIR = '/home/piesp/projects/wasm-motion-converter/public';

test('H.264 → GIF debug logs', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', (msg) => {
    logs.push(`[${msg.type()}] ${msg.text()}`);
  });

  await page.goto('/');

  await injectTestFile(page, 'test-video-h264-baseline.mp4');
  await setFormat(page, 'gif');
  await setQuality(page, 'medium');
  await setScale(page, '50%');

  const start = Date.now();
  await clickConvert(page);
  await dismissWarningDialog(page);

  const state = await waitForConversionComplete(page, 120_000);
  const elapsed = Date.now() - start;

  console.log(`\n=== Result: ${state} (${(elapsed / 1000).toFixed(1)}s) ===`);

  // Print conversion-related logs
  const conversionLogs = logs.filter((l) =>
    l.includes('[conversion]') ||
    l.includes('[ffmpeg]') ||
    l.includes('WebCodecs') ||
    l.includes('worker') ||
    l.includes('FFmpeg direct')
  );

  console.log('\n── Conversion logs ──');
  for (const log of conversionLogs.slice(0, 50)) {
    console.log(log);
  }
  console.log(`Total conversion logs: ${conversionLogs.length}`);
  console.log('── End logs ──\n');

  expect(state).toBe('done');
});
