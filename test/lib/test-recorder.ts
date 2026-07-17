// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP
//
// Test result recorder — logs conversion test results to a JSON Lines file
// for historical tracking and regression detection.
//
// Usage:
//   import { recordResult, loadResults, detectRegressions } from './test-recorder';
//   recordResult({ videoId: 'h264-baseline', format: 'gif', quality: 'medium', ... });
//   const regressions = detectRegressions();

import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ── Types ──────────────────────────────────────────────────────

// Re-export baseline data from manifest for regression detection.
// Using inline import pattern to avoid circular dependency issues.
import type { ExpectedOutputRange } from './test-manifest';

export interface ConversionTestResult {
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Git commit SHA (if available). */
  commitSha?: string;
  /** Video ID from test manifest. */
  videoId: string;
  /** Output format. */
  format: string;
  /** Quality preset. */
  quality: string;
  /** Scale percentage. */
  scale: string;
  /** Conversion succeeded. */
  success: boolean;
  /** Error message if failed. */
  error?: string;
  /** Output file size in bytes. */
  outputSizeBytes?: number;
  /** Conversion time in milliseconds. */
  conversionTimeMs?: number;
  /** Conversion path used. */
  path?: 'gpu' | 'cpu';
  /** Encoder backend used. */
  encoder?: string;
  /** Browser name if available. */
  browser?: string;
}

// ── Storage ────────────────────────────────────────────────────

const RESULTS_DIR = join(import.meta.dirname, '..', '.results');
const RESULTS_FILE = join(RESULTS_DIR, 'conversion-results.jsonl');

// Re-export baseline data from manifest for regression detection.
import { BASELINE_RESULTS, BASELINE_TIMINGS } from './test-manifest';

function loadBaselines(): BaselineData {
  return {
    results: BASELINE_RESULTS as Record<string, Record<string, ExpectedOutputRange>>,
    timings: BASELINE_TIMINGS as Record<string, Record<string, number>>,
  };
}

/** Ensure the results directory exists. */
function ensureResultsDir(): void {
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }
}

// ── Public API ─────────────────────────────────────────────────

/** Record a single conversion test result. */
export function recordResult(result: ConversionTestResult): void {
  ensureResultsDir();
  const line = JSON.stringify(result);
  appendFileSync(RESULTS_FILE, line + '\n', 'utf-8');
}

/** Load all recorded results. */
export function loadResults(): ConversionTestResult[] {
  if (!existsSync(RESULTS_FILE)) return [];
  const content = readFileSync(RESULTS_FILE, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const results: ConversionTestResult[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      results.push(JSON.parse(lines[i] as string));
    } catch {
      // Skip corrupted lines
    }
  }
  return results;
}

/** Load results filtered by video ID and format. */
export function loadResultsForVideo(
  videoId: string,
  format?: string,
): ConversionTestResult[] {
  return loadResults().filter(
    (r) => r.videoId === videoId && (!format || r.format === format),
  );
}

/** Get the latest result for each video+format+quality combination. */
export function getLatestResults(): Map<string, ConversionTestResult> {
  const latest = new Map<string, ConversionTestResult>();
  for (const result of loadResults()) {
    const key = `${result.videoId}|${result.format}|${result.quality}|${result.scale}`;
    const existing = latest.get(key);
    if (!existing || result.timestamp > existing.timestamp) {
      latest.set(key, result);
    }
  }
  return latest;
}

export interface Regression {
  videoId: string;
  format: string;
  quality: string;
  scale: string;
  type: 'size' | 'timing' | 'failure';
  message: string;
  previousValue: number | string;
  currentValue: number | string;
}

/**
 * Detect regressions by comparing latest results against baseline thresholds.
 * Returns a list of detected regressions.
 */
export function detectRegressions(
  sizeTolerance = 1.5, // 50% larger than baseline max = regression
  timingTolerance = 2.0, // 2× slower than baseline = regression
): Regression[] {
  const regressions: Regression[] = [];
  const latest = getLatestResults();
  const baselines = loadBaselines();

  for (const [, result] of latest) {
    if (!result.success) {
      // Check if this is a new failure (previous run succeeded)
      const previous = loadResults()
        .filter(
          (r) =>
            r.videoId === result.videoId &&
            r.format === result.format &&
            r.quality === result.quality &&
            r.scale === result.scale &&
            r.success,
        )
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];

      if (previous) {
        regressions.push({
          videoId: result.videoId,
          format: result.format,
          quality: result.quality,
          scale: result.scale,
          type: 'failure',
          message: `Conversion started failing: ${result.error || 'Unknown error'}`,
          previousValue: 'success',
          currentValue: 'failure',
        });
      }
      continue;
    }

    // Size regression check
    if (result.outputSizeBytes) {
      const baseline = baselines.results[result.videoId]?.[result.quality];
      if (baseline && result.outputSizeBytes > baseline.maxBytes * sizeTolerance) {
        regressions.push({
          videoId: result.videoId,
          format: result.format,
          quality: result.quality,
          scale: result.scale,
          type: 'size',
          message: `Output size ${result.outputSizeBytes} exceeds baseline max ${baseline.maxBytes} × ${sizeTolerance}`,
          previousValue: baseline.maxBytes,
          currentValue: result.outputSizeBytes,
        });
      }
    }

    // Timing regression check
    if (result.conversionTimeMs) {
      const baselineTiming = baselines.timings[result.videoId]?.[result.quality];
      if (baselineTiming && result.conversionTimeMs > baselineTiming * 1000 * timingTolerance) {
        regressions.push({
          videoId: result.videoId,
          format: result.format,
          quality: result.quality,
          scale: result.scale,
          type: 'timing',
          message: `Conversion time ${result.conversionTimeMs}ms exceeds baseline ${baselineTiming}s × ${timingTolerance}`,
          previousValue: baselineTiming * 1000,
          currentValue: result.conversionTimeMs,
        });
      }
    }
  }

  return regressions;
}

/** Generate a summary report of all test results. */
export function generateReport(): string {
  const latest = getLatestResults();
  const regressions = detectRegressions();

  const lines: string[] = [];
  lines.push('# Conversion Test Report');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  // Summary
  const total = latest.size;
  const passed = [...latest.values()].filter((r) => r.success).length;
  const failed = total - passed;
  lines.push(`## Summary: ${passed}/${total} passed, ${failed} failed`);
  lines.push('');

  // Results table
  lines.push('## Results');
  lines.push('');
  lines.push('| Video | Format | Quality | Scale | Status | Size | Time | Path |');
  lines.push('|--------|--------|---------|-------|--------|------|------|------|');

  for (const [, result] of latest) {
    const status = result.success ? 'PASS' : 'FAIL';
    const size = result.outputSizeBytes
      ? `${(result.outputSizeBytes / (1024 * 1024)).toFixed(1)}MB`
      : '-';
    const time = result.conversionTimeMs
      ? `${(result.conversionTimeMs / 1000).toFixed(1)}s`
      : '-';
    const path = result.path ?? '-';
    lines.push(
      `| ${result.videoId} | ${result.format} | ${result.quality} | ${result.scale} | ${status} | ${size} | ${time} | ${path} |`,
    );
  }

  // Regressions
  if (regressions.length > 0) {
    lines.push('');
    lines.push(`## Regressions (${regressions.length})`);
    lines.push('');
    for (const r of regressions) {
      lines.push(`- **${r.videoId} → ${r.format} (${r.quality}, ${r.scale})**: ${r.message}`);
    }
  } else {
    lines.push('');
    lines.push('## No regressions detected');
  }

  return lines.join('\n');
}
