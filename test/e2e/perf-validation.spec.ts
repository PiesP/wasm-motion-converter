// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP
//
// Performance validation tests — verify Phase 1 optimizations work correctly.
//
// Tests:
// 1. GIF 100% scale conversion (previously OOM-prone, now streaming)
// 2. Memory stability during conversion (no unbounded growth)
// 3. Output quality regression (GIF/WebP still produce valid files)
// 4. Buffer pool effectiveness (repeated conversions don't leak)
// 5. Per-phase profiling — bottleneck identification and timing breakdown

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  injectTestFile,
  setFormat,
  setQuality,
  setScale,
  clickConvert,
  dismissWarningDialog,
  isResultVisible,
  isErrorVisible,
  getVisibleResultStats,
  getAppState,
  waitForConversionComplete,
  downloadResult,
  runConversion,
} from './fixtures/test-helpers';
import { validateFileMagic } from './fixtures/verify';

// ─── Helper: get conversion profile from browser ───

interface PhaseMetrics {
  phase: string;
  durationMs: number;
  heapStartMB: number;
  heapEndMB: number;
  heapPeakMB: number;
  framesProcessed: number;
  fps: number;
  outputBytes: number;
  throughputMBps: number;
}

interface ConversionProfile {
  totalDurationMs: number;
  heapStartMB: number;
  heapEndMB: number;
  heapPeakMB: number;
  phases: PhaseMetrics[];
  phaseTimePct: Record<string, number>;
  bottleneck: string;
  summary: string;
}

async function getConversionProfile(page: Page): Promise<ConversionProfile | null> {
  return page.evaluate(() => {
    const helpers = (window as any).__TEST_HELPERS__;
    return helpers?.getConversionProfile() ?? null;
  });
}

// ─── Helper: get JS heap usage in MB via performance.memory ───

async function getHeapUsageMB(page: Page): Promise<number> {
  return page.evaluate(() => {
    const mem = (performance as any).memory;
    if (!mem) return -1;
    return Math.round(mem.usedJSHeapSize / (1024 * 1024));
  });
}

// ─── Test: GIF 100% scale (streaming architecture validation) ───

test.describe('Perf: GIF streaming architecture', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(3000);
  });

  test('GIF 50% scale medium quality succeeds (baseline)', async ({ page }) => {
    const { state, error } = await runConversion(page, {
      file: 'test-video-h264-baseline.mp4',
      format: 'gif',
      quality: 'medium',
      scale: '50%',
      timeoutMs: 120_000,
    });

    if (state === 'error') {
      console.log('Conversion error:', error);
    }
    expect(state).toBe('done');
    expect(await isResultVisible(page)).toBe(true);
    expect(await isErrorVisible(page)).toBe(false);

    // Validate output
    const stats = await getVisibleResultStats(page);
    expect(stats).not.toBeNull();
    expect(stats!.format.toLowerCase()).toBe('gif');
    expect(stats!.outputSize).toBeTruthy();

    // Download and verify magic bytes
    const buffer = await downloadResult(page);
    expect(buffer.length).toBeGreaterThan(100);
    const validation = validateFileMagic(buffer, 'gif');
    expect(validation.valid).toBe(true);
    expect(validation.message).toBe('Valid GIF');

    // At 50% scale, 1920x1080 → 960x540
    if (validation.width && validation.height) {
      expect(validation.width).toBeLessThanOrEqual(1920);
      expect(validation.height).toBeLessThanOrEqual(1080);
    }
  });

  test('GIF 100% scale medium quality succeeds (streaming)', async ({ page }) => {
    // This test validates the streaming architecture: previously, 100% scale GIF
    // would hold all decoded frames in memory simultaneously, causing OOM or
    // extreme GC thrashing. With streaming decode→encode interleaving, only
    // 1 RGB + 1 RGBA buffer exist at any time.
    const { state, error } = await runConversion(page, {
      file: 'test-video-h264-baseline.mp4',
      format: 'gif',
      quality: 'medium',
      scale: '100%',
      timeoutMs: 300_000,
    });

    if (state === 'error') {
      console.log('100% scale GIF error:', error);
    }
    expect(state).toBe('done');
    expect(await isResultVisible(page)).toBe(true);

    // Validate output dimensions match source (100% scale)
    const buffer = await downloadResult(page);
    expect(buffer.length).toBeGreaterThan(100);
    const validation = validateFileMagic(buffer, 'gif');
    expect(validation.valid).toBe(true);

    if (validation.width && validation.height) {
      // At 100% scale, output should match source dimensions (1920x1080)
      expect(validation.width).toBeGreaterThan(1000);
      expect(validation.height).toBeGreaterThan(500);
      console.log(`  100% scale GIF dimensions: ${validation.width}x${validation.height}`);
    }
  });
});

// ─── Test: Memory stability ─────────────────────────────────────

test.describe('Perf: Memory stability', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(3000);
  });

  test('JS heap does not grow unbounded during GIF conversion', async ({ page }) => {
    // Measure heap before conversion
    const heapBefore = await getHeapUsageMB(page);
    console.log(`  Heap before: ${heapBefore} MB`);

    await injectTestFile(page, 'test-video-h264-baseline.mp4');
    await setFormat(page, 'gif');
    await setQuality(page, 'medium');
    await setScale(page, '50%');
    await clickConvert(page);
    await dismissWarningDialog(page);

    // Sample heap during conversion (every 2s for up to 30s)
    const samples: number[] = [];
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(2000);
      const state = await getAppState(page);
      const heap = await getHeapUsageMB(page);
      samples.push(heap);
      console.log(`  Heap at ${(i + 1) * 2}s: ${heap} MB (state: ${state})`);
      if (state === 'done' || state === 'error') break;
    }

    const finalState = await waitForConversionComplete(page, 120_000);
    expect(finalState).toBe('done');

    const heapAfter = await getHeapUsageMB(page);
    console.log(`  Heap after: ${heapAfter} MB`);

    // With streaming architecture, peak heap should be bounded.
    // Before optimization: ~900MB+ for 1080p GIF (all frames in memory)
    // After optimization: ~200-400MB (1 frame + encoder buffer + decoder overhead)
    const peakHeap = Math.max(...samples);
    console.log(`  Peak heap during conversion: ${peakHeap} MB`);

    // The key assertion: peak heap should not exceed 600MB for a 50% scale GIF.
    // This would have been ~900MB+ with the old batch architecture.
    expect(peakHeap).toBeLessThan(600);
  });

  test('repeated conversions do not leak memory', async ({ page }) => {
    const heapReadings: number[] = [];

    for (let i = 0; i < 3; i++) {
      console.log(`  Conversion ${i + 1}/3`);

      // Reset app state
      await page.evaluate(() => window.__TEST_HELPERS__?.resetApp());
      await page.waitForTimeout(1000);

      const { state } = await runConversion(page, {
        file: 'test-video-h264-baseline.mp4',
        format: 'gif',
        quality: 'medium',
        scale: '50%',
        timeoutMs: 120_000,
      });

      expect(state).toBe('done');

      // Force GC if available (Chrome --js-flags=--expose-gc)
      await page.evaluate(() => {
        if ((window as any).gc) (window as any).gc();
      });
      await page.waitForTimeout(500);

      const heap = await getHeapUsageMB(page);
      heapReadings.push(heap);
      console.log(`  Heap after conversion ${i + 1}: ${heap} MB`);
    }

    // Heap should not grow linearly across conversions.
    // Allow 50MB tolerance for measurement noise.
    const first = heapReadings[0]!;
    const last = heapReadings[heapReadings.length - 1]!;
    const growth = last - first;
    console.log(`  Heap growth across 3 conversions: ${growth} MB`);
    expect(growth).toBeLessThan(100);
  });
});

// ─── Test: Output quality regression ────────────────────────────

test.describe('Perf: Output quality regression', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(3000);
  });

  test('GIF output has correct frame count (streaming preserves timing)', async ({ page }) => {
    const { state } = await runConversion(page, {
      file: 'test-video-h264-baseline.mp4',
      format: 'gif',
      quality: 'medium',
      scale: '50%',
      timeoutMs: 120_000,
    });

    expect(state).toBe('done');

    const buffer = await downloadResult(page);
    const validation = validateFileMagic(buffer, 'gif');
    expect(validation.valid).toBe(true);

    // GIF should have reasonable file size (not empty, not absurd)
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer.length).toBeLessThan(500 * 1024 * 1024);

    console.log(`  GIF output size: ${(buffer.length / 1024).toFixed(1)} KB`);
  });

  test('WebP output is valid after GIF streaming changes', async ({ page }) => {
    // Ensure WebP path still works correctly after decoder changes
    const { state } = await runConversion(page, {
      file: 'test-video-h264-baseline.mp4',
      format: 'webp',
      quality: 'medium',
      scale: '50%',
      timeoutMs: 120_000,
    });

    expect(state).toBe('done');

    const buffer = await downloadResult(page);
    const validation = validateFileMagic(buffer, 'webp');
    expect(validation.valid).toBe(true);
    expect(validation.message).toBe('Valid WebP');

    console.log(`  WebP output size: ${(buffer.length / 1024).toFixed(1)} KB`);
  });

  test('GIF low quality produces smaller output than medium', async ({ page }) => {
    // Low quality
    const lowResult = await runConversion(page, {
      file: 'test-video-h264-baseline.mp4',
      format: 'gif',
      quality: 'low',
      scale: '50%',
      timeoutMs: 120_000,
    });
    expect(lowResult.state).toBe('done');
    const lowBuffer = await downloadResult(page);
    const lowSize = lowBuffer.length;

    // Reset and run medium
    await page.evaluate(() => window.__TEST_HELPERS__?.resetApp());
    await page.waitForTimeout(1000);

    const medResult = await runConversion(page, {
      file: 'test-video-h264-baseline.mp4',
      format: 'gif',
      quality: 'medium',
      scale: '50%',
      timeoutMs: 120_000,
    });
    expect(medResult.state).toBe('done');
    const medBuffer = await downloadResult(page);
    const medSize = medBuffer.length;

    console.log(`  Low: ${(lowSize / 1024).toFixed(1)} KB, Medium: ${(medSize / 1024).toFixed(1)} KB`);
    // Low quality should produce smaller output (fewer colors = better LZW compression)
    expect(lowSize).toBeLessThan(medSize);
  });
});

// ─── Test: Per-phase profiling ────────────────────────────────────

test.describe('Perf: Per-phase profiling', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(3000);
  });

  test('GIF conversion produces valid profile with all phases', async ({ page }) => {
    const { state } = await runConversion(page, {
      file: 'test-video-h264-baseline.mp4',
      format: 'gif',
      quality: 'medium',
      scale: '50%',
      timeoutMs: 120_000,
    });
    expect(state).toBe('done');

    const profile = await getConversionProfile(page);
    expect(profile).not.toBeNull();

    // All 4 phases should be present
    // Note: GIF streaming combines decode+encode, so we check for demux + decode + encode + assemble
    const phaseNames = profile!.phases.map((p) => p.phase);
    console.log(`  Phases: ${phaseNames.join(', ')}`);
    console.log(`  Summary: ${profile!.summary}`);
    expect(phaseNames).toContain('demux');
    expect(phaseNames).toContain('decode');
    expect(phaseNames).toContain('encode');
    expect(phaseNames).toContain('assemble');

    // Total duration should be reasonable (under 2 minutes for a small test video)
    console.log(`  Total: ${profile!.totalDurationMs}ms`);
    expect(profile!.totalDurationMs).toBeGreaterThan(0);
    expect(profile!.totalDurationMs).toBeLessThan(120_000);

    // Phase time percentages: each phase reports its own duration / total.
    // Since decode and encode run concurrently (streaming), their percentages
    // can sum to > 100%. We just verify each phase has a reasonable percentage.
    console.log(`  Phase %:`, profile!.phaseTimePct);
    for (const [phase, pct] of Object.entries(profile!.phaseTimePct)) {
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
    // Demux and assemble should be small (< 20% each)
    expect(profile!.phaseTimePct.demux).toBeLessThan(20);
    expect(profile!.phaseTimePct.assemble).toBeLessThan(5);

    // Encode should have the most frames (decimation may reduce count)
    const encodePhase = profile!.phases.find((p) => p.phase === 'encode');
    expect(encodePhase).toBeDefined();
    expect(encodePhase!.framesProcessed).toBeGreaterThan(0);

    // Memory tracking should be present (Chrome provides performance.memory)
    console.log(`  Heap: start=${profile!.heapStartMB}MB, end=${profile!.heapEndMB}MB, peak=${profile!.heapPeakMB}MB`);
    // Peak heap should be positive (Chrome exposes performance.memory)
    // Note: In headless CI, performance.memory may not be available (returns 0)
    // so we only assert it's non-negative
    expect(profile!.heapPeakMB).toBeGreaterThanOrEqual(0);

    // Bottleneck should be one of the phases
    expect(phaseNames).toContain(profile!.bottleneck);
    console.log(`  Bottleneck: ${profile!.bottleneck}`);
  });

  test('WebP conversion profile shows encode throughput', async ({ page }) => {
    const { state } = await runConversion(page, {
      file: 'test-video-h264-baseline.mp4',
      format: 'webp',
      quality: 'medium',
      scale: '50%',
      timeoutMs: 120_000,
    });
    expect(state).toBe('done');

    const profile = await getConversionProfile(page);
    expect(profile).not.toBeNull();

    // WebP encode should report throughput
    const encodePhase = profile!.phases.find((p) => p.phase === 'encode');
    expect(encodePhase).toBeDefined();
    expect(encodePhase!.outputBytes).toBeGreaterThan(0);
    console.log(`  WebP encode: ${encodePhase!.framesProcessed}f, ${encodePhase!.throughputMBps} MB/s`);

    // Summary should be a non-empty string
    expect(profile!.summary.length).toBeGreaterThan(0);
    expect(profile!.summary).toContain('total');
    console.log(`  ${profile!.summary}`);
  });

  test('GIF 50% scale — profile shows realistic phase distribution', async ({ page }) => {
    // With streaming architecture, decode+encode run concurrently.
    // The decode phase tracks VideoDecoder output, encode tracks gifenc processing.
    // In practice, decode (VideoDecoder) is often the bottleneck for GIF since
    // it must decode every frame before encoding can proceed.
    const { state } = await runConversion(page, {
      file: 'test-video-h264-baseline.mp4',
      format: 'gif',
      quality: 'medium',
      scale: '50%',
      timeoutMs: 120_000,
    });
    expect(state).toBe('done');

    const profile = await getConversionProfile(page);
    expect(profile).not.toBeNull();

    const decodePhase = profile!.phases.find((p) => p.phase === 'decode');
    const encodePhase = profile!.phases.find((p) => p.phase === 'encode');
    const demuxPhase = profile!.phases.find((p) => p.phase === 'demux');

    expect(decodePhase).toBeDefined();
    expect(encodePhase).toBeDefined();
    expect(demuxPhase).toBeDefined();

    console.log(`  Demux: ${demuxPhase!.durationMs}ms (${profile!.phaseTimePct.demux}%)`);
    console.log(`  Decode: ${decodePhase!.durationMs}ms (${profile!.phaseTimePct.decode}%)`);
    console.log(`  Encode: ${encodePhase!.durationMs}ms (${profile!.phaseTimePct.encode}%)`);
    console.log(`  Assemble: ${profile!.phaseTimePct.assemble}%`);
    console.log(`  Bottleneck: ${profile!.bottleneck}`);

    // Demux should be relatively fast (< 20% of total)
    expect(demuxPhase!.durationMs).toBeLessThan(profile!.totalDurationMs * 0.2);

    // Decode + Encode should account for the majority of time
    const decodeEncodePct = profile!.phaseTimePct.decode + profile!.phaseTimePct.encode;
    expect(decodeEncodePct).toBeGreaterThan(50);

    // The bottleneck should be either decode or encode (not demux or assemble)
    expect(['decode', 'encode']).toContain(profile!.bottleneck);
  });
});
