// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMemoryInfo } from '@utils/memory-info';

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

  it('estimates a heap limit from positive device memory when performance.memory is absent', () => {
    setPerformanceMemory(undefined);
    vi.stubGlobal('navigator', { deviceMemory: 4 });

    const info = getMemoryInfo();
    expect(info?.usedJSHeapSize).toBe(0);
    expect(info?.usagePercentage).toBe(0);
    expect(info?.jsHeapSizeLimit).toBe(4 * 1024 * 1024 * 1024 * 0.25);
  });

  it('returns null when neither memory API is available', () => {
    setPerformanceMemory(undefined);
    vi.stubGlobal('navigator', { deviceMemory: 0 });
    expect(getMemoryInfo()).toBeNull();
  });
});
