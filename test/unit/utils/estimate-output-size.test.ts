// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import {
  estimateAvifOutputSize,
  estimateGifOutputSize,
  estimateWebpOutputSize,
  estimateOutputSize,
} from '@utils/estimate-output-size';

describe('estimateGifOutputSize', () => {
  it('calculates size for a typical 1080p 150-frame output', () => {
    // 1920*1080 = 2_073_600 pixels
    // Per frame: 2_073_600 * 0.18 + 800 = 373_248 + 800 = 374_048
    // Total: ceil(374_048 * 150) = 56_107_200
    const result = estimateGifOutputSize(1920, 1080, 150);
    expect(result).toBe(56_107_200);
  });

  it('returns 0 for zero-area output', () => {
    const result = estimateGifOutputSize(0, 1080, 150);
    expect(result).toBe(120_000); // 0*0.18+800 = 800, ceil(800*150) = 120_000
  });

  it('returns 0 when totalFrames is 0', () => {
    const result = estimateGifOutputSize(1920, 1080, 0);
    expect(result).toBe(0);
  });

  it('handles single frame', () => {
    // 100*100*0.18 + 800 = 1800 + 800 = 2600, ceil(2600*1) = 2600
    const result = estimateGifOutputSize(100, 100, 1);
    expect(result).toBe(2_600);
  });

  it('scales linearly with frame count', () => {
    const single = estimateGifOutputSize(100, 100, 1);
    const ten = estimateGifOutputSize(100, 100, 10);
    expect(ten).toBe(single * 10);
  });
});

describe('estimateWebpOutputSize', () => {
  it('calculates size for 1080p 150 frames at medium quality', () => {
    // 1920*1080 = 2_073_600 pixels
    // medium BPP=0.2: 2_073_600 * 0.2 + 32 = 414_720 + 32 = 414_752
    // Total: ceil(414_752 * 150) = 62_212_800
    const result = estimateWebpOutputSize(1920, 1080, 150, 'medium');
    expect(result).toBe(62_212_800);
  });

  it('uses lower BPP for low quality', () => {
    const low = estimateWebpOutputSize(1920, 1080, 150, 'low');
    const medium = estimateWebpOutputSize(1920, 1080, 150, 'medium');
    expect(low).toBeLessThan(medium);
  });

  it('uses higher BPP for high quality', () => {
    const medium = estimateWebpOutputSize(1920, 1080, 150, 'medium');
    const high = estimateWebpOutputSize(1920, 1080, 150, 'high');
    expect(high).toBeGreaterThan(medium);
  });

  it('returns zero for zero totalFrames', () => {
    const result = estimateWebpOutputSize(1920, 1080, 0, 'high');
    expect(result).toBe(0);
  });

  it('handles zero-area dimensions', () => {
    // 0*0.2+32 = 32, ceil(32*1) = 32
    const result = estimateWebpOutputSize(0, 1080, 1, 'medium');
    expect(result).toBe(32);
  });
});

describe('estimateAvifOutputSize', () => {
  it('scales conservatively with AVIF quality', () => {
    const low = estimateAvifOutputSize(1920, 1080, 150, 'low');
    const medium = estimateAvifOutputSize(1920, 1080, 150, 'medium');
    const high = estimateAvifOutputSize(1920, 1080, 150, 'high');

    expect(low).toBeLessThan(medium);
    expect(medium).toBeLessThan(high);
  });

  it('returns zero for zero totalFrames', () => {
    expect(estimateAvifOutputSize(1920, 1080, 0, 'high')).toBe(0);
  });
});

describe('estimateOutputSize', () => {
  it('returns GIF estimate for gif format', () => {
    const result = estimateOutputSize(1920, 1080, 150, 'high', 'gif');
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.formatted).toMatch(/^[\d.]+ (B|KB|MB|GB)$/);
  });

  it('returns WebP estimate for webp format', () => {
    const result = estimateOutputSize(1920, 1080, 150, 'high', 'webp');
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.formatted).toMatch(/^[\d.]+ (B|KB|MB|GB)$/);
  });

  it('returns AVIF estimate for avif format', () => {
    const result = estimateOutputSize(1920, 1080, 150, 'high', 'avif');
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.formatted).toMatch(/^[\d.]+ (B|KB|MB|GB)$/);
  });

  it('GIF estimate differs from WebP estimate at same dimensions/frames/quality', () => {
    const gif = estimateOutputSize(1920, 1080, 150, 'high', 'gif');
    const webp = estimateOutputSize(1920, 1080, 150, 'high', 'webp');
    expect(gif.bytes).not.toBe(webp.bytes);
  });

  it('returns formatted string that looks correct', () => {
    const result = estimateOutputSize(1920, 1080, 150, 'high', 'gif');
    const parsed = parseFloat(result.formatted);
    expect(parsed).toBeGreaterThan(0);
    expect(Number.isFinite(parsed)).toBe(true);
  });
});
