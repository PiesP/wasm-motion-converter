// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP
//
// Benchmark: measure conversion times on local dev server.
// Run with: pnpm test -- debug/benchmark-local.spec.ts

import { test, expect } from '@playwright/test';
import {
  injectTestFile,
  setFormat,
  setQuality,
  setScale,
  clickConvert,
  dismissWarningDialog,
  isConvertButtonEnabled,
  waitForConversionComplete,
} from '../fixtures/test-helpers';

interface BenchmarkResult {
  codec: string;
  format: string;
  quality: string;
  scale: string;
  totalTimeMs: number;
  success: boolean;
  error?: string;
}

const results: BenchmarkResult[] = [];

function record(result: BenchmarkResult) {
  results.push(result);
  const icon = result.success ? '✅' : '❌';
  console.log(`  ${icon} ${result.codec} → ${result.format} (${result.quality}, ${result.scale}) ${(result.totalTimeMs / 1000).toFixed(1)}s${result.error ? ' — ' + result.error : ''}`);
}

test.afterAll(() => {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('BENCHMARK SUMMARY');
  console.log('═══════════════════════════════════════════════════════');

  const codecs = [...new Set(results.map((r) => r.codec))];
  for (const codec of codecs) {
    const codecResults = results.filter((r) => r.codec === codec);
    console.log(`\n${codec}:`);
    for (const r of codecResults) {
      const icon = r.success ? '✅' : '❌';
      console.log(`  ${icon} ${r.format} (${r.quality}, ${r.scale}) ${(r.totalTimeMs / 1000).toFixed(1)}s`);
    }
  }

  console.log('\n── Recommended Timeouts ──');
  for (const codec of codecs) {
    const codecResults = results.filter((r) => r.codec === codec && r.success);
    if (codecResults.length === 0) continue;
    const maxTime = Math.max(...codecResults.map((r) => r.totalTimeMs));
    const recommended = Math.ceil((maxTime / 1000) * 1.5 / 30) * 30;
    console.log(`  ${codec}: ${recommended}s (max measured: ${(maxTime / 1000).toFixed(1)}s)`);
  }
  console.log('═══════════════════════════════════════════════════════\n');
});

async function runBenchmark(
  page: any,
  codec: string,
  file: string,
  format: 'gif' | 'webp',
  quality: 'low' | 'medium' | 'high',
  scale: '50%' | '75%' | '100%',
  timeoutMs: number,
) {
  const start = Date.now();
  let success = false;
  let error: string | undefined;

  try {
    await page.goto('/');
    await injectTestFile(page, file);
    await setFormat(page, format);
    await setQuality(page, quality);
    await setScale(page, scale);

    const enabled = await isConvertButtonEnabled(page);
    if (!enabled) {
      throw new Error('Convert button not enabled');
    }

    await clickConvert(page);
    await dismissWarningDialog(page);

    const state = await waitForConversionComplete(page, timeoutMs);
    success = state === 'done';
    if (!success) error = state;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  record({ codec, format, quality, scale, totalTimeMs: Date.now() - start, success, error });
  return success;
}

test.describe('Benchmark: H.264', () => {
  test('H.264 → GIF (medium, 50%)', async ({ page }) => {
    const ok = await runBenchmark(page, 'H.264', 'test-video-h264-baseline.mp4', 'gif', 'medium', '50%', 120_000);
    expect(ok).toBe(true);
  });
});

test.describe('Benchmark: HEVC', () => {
  test('HEVC → GIF (medium, 50%)', async ({ page }) => {
    const ok = await runBenchmark(page, 'HEVC', 'test-video-hevc.mp4', 'gif', 'medium', '50%', 120_000);
    expect(ok).toBe(true);
  });
});

test.describe('Benchmark: VP8', () => {
  test('VP8 → GIF (medium, 50%)', async ({ page }) => {
    const ok = await runBenchmark(page, 'VP8', 'test-video-vp8.webm', 'gif', 'medium', '50%', 180_000);
    expect(ok).toBe(true);
  });
});

test.describe('Benchmark: VP9', () => {
  test('VP9 → GIF (medium, 50%)', async ({ page }) => {
    const ok = await runBenchmark(page, 'VP9', 'test-video-vp9.webm', 'gif', 'medium', '50%', 300_000);
    expect(ok).toBe(true);
  });
});

test.describe('Benchmark: AV1', () => {
  test('AV1 → GIF (medium, 50%)', async ({ page }) => {
    const ok = await runBenchmark(page, 'AV1', 'test-video-av1.webm', 'gif', 'medium', '50%', 300_000);
    expect(ok).toBe(true);
  });
});
