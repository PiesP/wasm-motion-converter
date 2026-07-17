// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP
//
// Test matrix generator — creates parameterized test cases from the manifest.
// Provides helpers for running conversion tests with consistent configuration.

import {
  TEST_VIDEOS,
  type TestVideoEntry,
  type TestFormat,
  type TestQuality,
  type TestScale,
  BASELINE_RESULTS,
  BASELINE_TIMINGS,
} from './test-manifest';

/** A single test case in the conversion matrix. */
export interface ConversionTestCase {
  video: TestVideoEntry;
  format: TestFormat;
  quality: TestQuality;
  scale: TestScale;
  /** Human-readable test name. */
  name: string;
}

/** Generate the full test matrix from manifests. */
export function generateTestMatrix(options?: {
  codecs?: string[];
  formats?: TestFormat[];
  qualities?: TestQuality[];
  scales?: TestScale[];
  webCodecsOnly?: boolean;
  maxDurationSec?: number;
}): ConversionTestCase[] {
  const {
    codecs,
    formats = ['gif', 'webp'],
    qualities = ['medium', 'high'],
    scales = ['100%'],
    webCodecsOnly = false,
    maxDurationSec,
  } = options ?? {};

  const videos = TEST_VIDEOS.filter((v) => {
    if (codecs && !codecs.includes(v.codec)) return false;
    if (webCodecsOnly && !v.webCodecsSupported) return false;
    if (maxDurationSec && v.duration > maxDurationSec) return false;
    return true;
  });

  const cases: ConversionTestCase[] = [];
  for (const video of videos) {
    for (const format of formats) {
      for (const quality of qualities) {
        for (const scale of scales) {
          const pathLabel = video.webCodecsSupported ? 'gpu' : 'cpu';
          cases.push({
            video,
            format,
            quality,
            scale,
            name: `${video.id} → ${format.toUpperCase()} (${quality}, ${scale}, ${pathLabel})`,
          });
        }
      }
    }
  }
  return cases;
}

/** Generate a smaller smoke test matrix for quick verification. */
export function generateSmokeMatrix(): ConversionTestCase[] {
  // One codec + one format + one quality + one scale = minimal coverage
  return generateTestMatrix({
    codecs: ['h264-baseline'],
    formats: ['gif'],
    qualities: ['medium'],
    scales: ['100%'],
  });
}

/** Generate codec coverage matrix (all codecs, one preset). */
export function generateCodecCoverageMatrix(
  format: TestFormat = 'gif',
  quality: TestQuality = 'medium',
  scale: TestScale = '50%',
): ConversionTestCase[] {
  return generateTestMatrix({
    formats: [format],
    qualities: [quality],
    scales: [scale],
  });
}

/** Get expected output range for regression check. */
export function getExpectedOutputRange(
  videoId: string,
  quality: TestQuality,
): { minBytes: number; maxBytes: number } | null {
  const videoResults = BASELINE_RESULTS[videoId];
  return videoResults?.[quality] ?? null;
}

/** Get expected timing upper bound (seconds) for performance check. */
export function getExpectedTiming(videoId: string, quality: TestQuality): number | null {
  return BASELINE_TIMINGS[videoId]?.[quality] ?? null;
}

/** Format bytes to human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format milliseconds to human-readable duration. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.round(sec % 60);
  return `${min}m ${remSec}s`;
}
