// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMemoryInfo } = vi.hoisted(() => ({ getMemoryInfo: vi.fn() }));
vi.mock('@utils/memory-info', () => ({ getMemoryInfo }));

import {
  checkMemoryForConversion,
  getMemoryInfo as getMemoryInfoFromMonitor,
  getMemoryUsageMB,
  isMemoryCritical,
} from '@utils/memory-monitor';

describe('memory monitor', () => {
  beforeEach(() => {
    getMemoryInfo.mockReset();
  });

  it('returns false and null when memory is unavailable', () => {
    getMemoryInfo.mockReturnValue(null);
    expect(getMemoryInfoFromMonitor()).toBeNull();
    expect(isMemoryCritical()).toBe(false);
    expect(getMemoryUsageMB()).toBeNull();
  });

  it('detects critical usage and rounds current heap usage', () => {
    const info = {
      usedJSHeapSize: 80 * 1024 * 1024,
      totalJSHeapSize: 100 * 1024 * 1024,
      jsHeapSizeLimit: 100 * 1024 * 1024,
      usagePercentage: 80.1,
    };
    getMemoryInfo.mockReturnValue(info);
    expect(isMemoryCritical()).toBe(true);
    expect(getMemoryUsageMB()).toBe(80);
    expect(getMemoryInfoFromMonitor()).toBe(info);
  });

  it('classifies conversion estimates as ok, warning, or critical', () => {
    getMemoryInfo.mockReturnValue(null);
    expect(checkMemoryForConversion(10, 10, 1, 'gif').level).toBe('ok');

    getMemoryInfo.mockReturnValue({
      usedJSHeapSize: 0,
      totalJSHeapSize: 0,
      jsHeapSizeLimit: 100 * 1024 * 1024,
      usagePercentage: 0,
    });
    expect(checkMemoryForConversion(1000, 1000, 100, 'webp').level).toBe('critical');
    expect(checkMemoryForConversion(1000, 1000, 10, 'gif').level).toBe('warning');
    expect(checkMemoryForConversion(1000, 1000, 100, 'avif').level).toBe('warning');
  });
});
