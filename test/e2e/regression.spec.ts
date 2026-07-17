// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP
//
// Regression tests — compare current results against baseline thresholds.
// Run after matrix tests to detect performance/size regressions.
//
// Usage:
//   pnpm test -- regression.spec.ts
//   (Run after matrix.spec.ts to populate results file)

import { test, expect } from '@playwright/test';
import { detectRegressions, generateReport } from '../lib/test-recorder';

test.describe('Regression: Baseline comparison', () => {
  test('no output size regressions', () => {
    const regressions = detectRegressions(1.5, 2.0);

    // Filter to size regressions only
    const sizeRegressions = regressions.filter((r) => r.type === 'size');

    if (sizeRegressions.length > 0) {
      console.log('\n── Size Regressions ──');
      for (const r of sizeRegressions) {
        console.log(`  ${r.videoId} → ${r.format} (${r.quality}, ${r.scale}): ${r.message}`);
      }
    }

    expect(sizeRegressions, `Size regressions detected: ${sizeRegressions.length}`).toHaveLength(0);
  });

  test('no timing regressions', () => {
    const regressions = detectRegressions(1.5, 2.0);

    // Filter to timing regressions only
    const timingRegressions = regressions.filter((r) => r.type === 'timing');

    if (timingRegressions.length > 0) {
      console.log('\n── Timing Regressions ──');
      for (const r of timingRegressions) {
        console.log(`  ${r.videoId} → ${r.format} (${r.quality}, ${r.scale}): ${r.message}`);
      }
    }

    expect(timingRegressions, `Timing regressions detected: ${timingRegressions.length}`).toHaveLength(0);
  });

  test('no new failures', () => {
    const regressions = detectRegressions(1.5, 2.0);

    // Filter to failure regressions only, excluding known-unsupported codecs
    const failureRegressions = regressions.filter(
      (r) => r.type === 'failure' && r.videoId !== 'hevc',
    );

    if (failureRegressions.length > 0) {
      console.log('\n── Failure Regressions ──');
      for (const r of failureRegressions) {
        console.log(`  ${r.videoId} → ${r.format} (${r.quality}, ${r.scale}): ${r.message}`);
      }
    }

    expect(failureRegressions, `New failures detected: ${failureRegressions.length}`).toHaveLength(0);
  });

  test('generate report', () => {
    const report = generateReport();
    console.log(report);

    // Report should always be a non-empty string
    expect(report.length).toBeGreaterThan(0);
    expect(report).toContain('Conversion Test Report');
  });
});
