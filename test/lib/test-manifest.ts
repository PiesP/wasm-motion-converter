// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP
//
// Test manifest — single source of truth for all conversion test cases.
// Defines input videos, their metadata, and expected conversion parameters.

/** Supported video codecs for testing. */
export type TestCodec =
  | 'h264-baseline'
  | 'h264-main'
  | 'h264-high'
  | 'hevc'
  | 'vp8'
  | 'vp9'
  | 'av1';

/** Output format for conversion tests. */
export type TestFormat = 'gif' | 'webp';

/** Quality levels for conversion tests. */
export type TestQuality = 'low' | 'medium' | 'high';

/** Scale options for conversion tests. */
export type TestScale = '50%' | '75%' | '100%';

/** Defines a single test video with its metadata and test configuration. */
export interface TestVideoEntry {
  /** Unique identifier for this test case. */
  id: string;
  /** Relative path from public/ directory. */
  file: string;
  /** Human-readable label. */
  label: string;
  /** Video codec. */
  codec: TestCodec;
  /** Resolution width in pixels. */
  width: number;
  /** Resolution height in pixels. */
  height: number;
  /** Duration in seconds. */
  duration: number;
  /** Frame rate (fps). */
  frameRate: number;
  /** File size in bytes. */
  fileSizeBytes: number;
  /** Trim duration in seconds for testing (null = full video). */
  testTrimSeconds: number | null;
  /** Maximum acceptable conversion time in ms (for timeout). */
  maxConversionTimeMs: number;
}

/**
 * Registry of all test videos.
 * Adding a new video for testing requires only adding an entry here.
 *
 * File paths are relative to `public/` directory.
 */
export const TEST_VIDEOS: ReadonlyArray<TestVideoEntry> = [
  {
    id: 'h264-baseline',
    file: '/test-video-h264-baseline.mp4',
    label: 'H.264 Constrained Baseline',
    codec: 'h264-baseline',
    width: 1920,
    height: 1080,
    duration: 9.75,
    frameRate: 60,
    fileSizeBytes: 842_356,
    testTrimSeconds: 5,
    maxConversionTimeMs: 60_000,
  },
  {
    id: 'h264-main',
    file: '/test-video-h264-main.mp4',
    label: 'H.264 Main',
    codec: 'h264-main',
    width: 1920,
    height: 1080,
    duration: 9.75,
    frameRate: 60,
    fileSizeBytes: 671_634,
    testTrimSeconds: 5,
    maxConversionTimeMs: 60_000,
  },
  {
    id: 'h264-high',
    file: '/test-video-h264-high.mp4',
    label: 'H.264 High',
    codec: 'h264-high',
    width: 1920,
    height: 1080,
    duration: 9.75,
    frameRate: 60,
    fileSizeBytes: 675_613,
    testTrimSeconds: 5,
    maxConversionTimeMs: 60_000,
  },
  {
    id: 'hevc',
    file: '/test-video-hevc.mp4',
    label: 'HEVC Main',
    codec: 'hevc',
    width: 1920,
    height: 1080,
    duration: 9.75,
    frameRate: 60,
    fileSizeBytes: 507_558,
    // HEVC availability is hardware/build-dependent and checked at runtime.
    testTrimSeconds: 5,
    maxConversionTimeMs: 120_000,
  },
  {
    id: 'vp8',
    file: '/test-video-vp8.webm',
    label: 'VP8',
    codec: 'vp8',
    width: 1920,
    height: 1080,
    duration: 9.75,
    frameRate: 60,
    fileSizeBytes: 3_889_439,
    testTrimSeconds: 5,
    maxConversionTimeMs: 180_000,
  },
  {
    id: 'vp9',
    file: '/test-video-vp9.webm',
    label: 'VP9 Profile 0',
    codec: 'vp9',
    width: 1920,
    height: 1080,
    duration: 9.75,
    frameRate: 60,
    fileSizeBytes: 1_550_521,
    testTrimSeconds: 5,
    maxConversionTimeMs: 300_000,
  },
  {
    id: 'av1',
    file: '/test-video-av1.webm',
    label: 'AV1 Main',
    codec: 'av1',
    width: 1920,
    height: 1080,
    duration: 9.75,
    frameRate: 60,
    fileSizeBytes: 1_540_616,
    testTrimSeconds: 5,
    maxConversionTimeMs: 300_000,
  },
] as const;

/** Look up a test video by its ID. */
export function getVideoById(id: string): TestVideoEntry | undefined {
  return TEST_VIDEOS.find((v) => v.id === id);
}

/** Get all videos for a given codec. */
export function getVideosByCodec(codec: TestCodec): TestVideoEntry[] {
  return TEST_VIDEOS.filter((v) => v.codec === codec);
}

/**
 * Get the file path for a test video.
 * Supports both canonical names (test-video-h264-baseline.mp4) and
 * legacy aliases (sample-h264-test.mp4) for backward compatibility.
 */
export function getVideoFilePath(idOrAlias: string): string | undefined {
  // Direct ID match
  const byId = TEST_VIDEOS.find((v) => v.id === idOrAlias);
  if (byId) return byId.file;

  // Legacy alias mapping
  const aliases: Record<string, string> = {
    'sample-h264-test.mp4': '/test-video-h264-baseline.mp4',
    'sample-color-test.webm': '/test-video-vp8.webm',
    'sample-short-test.webm': '/test-video-vp8.webm',
  };
  return aliases[idOrAlias];
}

/** Expected output sizes (approximate, in bytes) from previous test runs. */
export interface ExpectedOutputRange {
  minBytes: number;
  maxBytes: number;
}

/**
 * Baseline conversion results from manual testing (commit 264c417).
 * Used for regression detection — if output size deviates significantly,
 * it may indicate a regression in encoding quality or settings.
 *
 * Format: `[videoId][quality][scale] → { minBytes, maxBytes }`
 */
export const BASELINE_RESULTS: Record<
  string,
  Record<string, ExpectedOutputRange>
> = {
  'h264-baseline': {
    medium: { minBytes: 25_000_000, maxBytes: 45_000_000 },
    high: { minBytes: 30_000_000, maxBytes: 50_000_000 },
  },
  'h264-main': {
    medium: { minBytes: 25_000_000, maxBytes: 45_000_000 },
    high: { minBytes: 30_000_000, maxBytes: 50_000_000 },
  },
  'h264-high': {
    medium: { minBytes: 25_000_000, maxBytes: 45_000_000 },
    high: { minBytes: 30_000_000, maxBytes: 50_000_000 },
  },
  hevc: {
    medium: { minBytes: 1_200_000, maxBytes: 2_000_000 },
    high: { minBytes: 1_500_000, maxBytes: 2_500_000 },
  },
  vp8: {
    medium: { minBytes: 30_000_000, maxBytes: 55_000_000 },
    high: { minBytes: 40_000_000, maxBytes: 65_000_000 },
  },
  vp9: {
    medium: { minBytes: 25_000_000, maxBytes: 45_000_000 },
    high: { minBytes: 30_000_000, maxBytes: 50_000_000 },
  },
  av1: {
    medium: { minBytes: 25_000_000, maxBytes: 45_000_000 },
    high: { minBytes: 30_000_000, maxBytes: 50_000_000 },
  },
} as const;

/**
 * Conversion timing baselines (seconds) from manual testing.
 * Used for performance regression detection.
 */
export const BASELINE_TIMINGS: Record<string, Record<string, number>> = {
  'h264-baseline': { medium: 25, high: 35 },
  'h264-main': { medium: 25, high: 35 },
  'h264-high': { medium: 25, high: 35 },
  hevc: { medium: 15, high: 25 },
  vp8: { medium: 30, high: 40 },
  vp9: { medium: 25, high: 35 },
  av1: { medium: 25, high: 35 },
} as const;
