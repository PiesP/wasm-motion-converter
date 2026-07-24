// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { describe, expect, it } from 'vitest';
import { ConversionProfiler } from '@services/conversion-profiler';

describe('conversion-profiler', () => {
  let profiler: ConversionProfiler;

  beforeEach(() => {
    profiler = new ConversionProfiler();
  });

  describe('ConversionProfiler', () => {
    it('starts with empty phases', () => {
      const report = profiler.getReport();
      expect(report.phases).toBeInstanceOf(Array);
      expect(report.phases.length).toBe(0);
    });

    it('requires start() before recording phases', () => {
      profiler.start();
      profiler.startPhase('demux' as any);
      const report = profiler.getReport();
      expect(report.phases).toBeInstanceOf(Array);
    });
  });
});