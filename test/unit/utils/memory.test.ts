// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEstimatedHeapLimitBytes, getMemoryInfo } from '@utils/memory-info';

const setPerformanceMemory = (memory: object | undefined) => {
  if (memory === undefined) {
    Reflect.deleteProperty(performance, 'memory');
    return;
  }
  Object.defineProperty(performance, 'memory', {
    configurable: true,
    value: memory,
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(performance, 'memory');
});

describe('getMemoryInfo', () => {
  it('reports measured heap usage and optional device memory', () => {
    setPerformanceMemory({
      usedJSHeapSize: 40,
      totalJSHeapSize: 80,
      jsHeapSizeLimit: 100,
    });
    vi.stubGlobal('navigator', { deviceMemory: 8 });

    expect(getMemoryInfo()).toEqual({
      usedJSHeapSize: 40,
      totalJSHeapSize: 80,
      jsHeapSizeLimit: 100,
      usagePercentage: 40,
      deviceMemoryGB: 8,
    });
  });

  it('leaves device memory undefined when the browser does not expose it', () => {
    setPerformanceMemory({ usedJSHeapSize: 1, totalJSHeapSize: 2, jsHeapSizeLimit: 4 });
    vi.stubGlobal('navigator', {});
    expect(getMemoryInfo()?.deviceMemoryGB).toBeUndefined();
  });

  it('does not present device RAM as a measured JS heap', () => {
    setPerformanceMemory(undefined);
    vi.stubGlobal('navigator', { deviceMemory: 4 });
    expect(getMemoryInfo()).toBeNull();
    expect(getEstimatedHeapLimitBytes()).toBe(1024 * 1024 * 1024);
  });

  it.each([
    { usedJSHeapSize: Number.NaN, totalJSHeapSize: 80, jsHeapSizeLimit: 100 },
    { usedJSHeapSize: 40, totalJSHeapSize: Number.POSITIVE_INFINITY, jsHeapSizeLimit: 100 },
    { usedJSHeapSize: 40, totalJSHeapSize: 80, jsHeapSizeLimit: 0 },
    { usedJSHeapSize: 90, totalJSHeapSize: 80, jsHeapSizeLimit: 100 },
    { usedJSHeapSize: 80, totalJSHeapSize: 120, jsHeapSizeLimit: 100 },
    { usedJSHeapSize: 120, totalJSHeapSize: 120, jsHeapSizeLimit: 100 },
  ])('rejects invalid performance.memory fields: %o', (memory) => {
    setPerformanceMemory(memory);
    vi.stubGlobal('navigator', { deviceMemory: 8 });
    expect(getMemoryInfo()).toBeNull();
  });

  it('ignores invalid device memory while retaining valid heap measurements', () => {
    setPerformanceMemory({ usedJSHeapSize: 1, totalJSHeapSize: 2, jsHeapSizeLimit: 4 });
    vi.stubGlobal('navigator', { deviceMemory: Number.POSITIVE_INFINITY });
    expect(getMemoryInfo()?.deviceMemoryGB).toBeUndefined();
  });

  it('returns null when neither memory API is available', () => {
    setPerformanceMemory(undefined);
    vi.stubGlobal('navigator', { deviceMemory: 0 });
    expect(getMemoryInfo()).toBeNull();
  });
});

describe('getEstimatedHeapLimitBytes', () => {
  it('derives a conservative cap from device RAM independently of heap measurement', () => {
    setPerformanceMemory(undefined);
    vi.stubGlobal('navigator', { deviceMemory: 1 });
    expect(getEstimatedHeapLimitBytes()).toBe(256 * 1024 * 1024);
    expect(getMemoryInfo()).toBeNull();
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e30])(
    'rejects absent or invalid device memory %s',
    (deviceMemory) => {
      vi.stubGlobal('navigator', { deviceMemory });
      expect(getEstimatedHeapLimitBytes()).toBeNull();
    }
  );
});
