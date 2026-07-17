// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { describe, it, expect } from 'vitest';
import {
  formatDuration,
  formatNumber,
  formatPercent,
} from '@utils/intl-utils';
import { formatBytes } from '@utils/format-utils';

describe('formatDuration', () => {
  describe('English locale', () => {
    it('formats milliseconds under 1 second', () => {
      expect(formatDuration(500, 'en')).toBe('500ms');
      expect(formatDuration(999, 'en')).toBe('999ms');
      expect(formatDuration(0, 'en')).toBe('0ms');
    });

    it('formats seconds under 1 minute', () => {
      expect(formatDuration(1000, 'en')).toBe('1.0s');
      expect(formatDuration(5500, 'en')).toBe('5.5s');
      expect(formatDuration(30000, 'en')).toBe('30.0s');
      expect(formatDuration(59900, 'en')).toBe('59.9s');
    });

    it('formats minutes and seconds', () => {
      expect(formatDuration(60000, 'en')).toBe('1m 0s');
      expect(formatDuration(90000, 'en')).toBe('1m 30s');
      expect(formatDuration(125000, 'en')).toBe('2m 5s');
      expect(formatDuration(3600000, 'en')).toBe('60m 0s');
    });
  });

  describe('Korean locale', () => {
    it('formats milliseconds under 1 second', () => {
      expect(formatDuration(500, 'ko')).toBe('500ms');
      expect(formatDuration(999, 'ko')).toBe('999ms');
    });

    it('formats seconds under 1 minute', () => {
      expect(formatDuration(1000, 'ko')).toBe('1.0초');
      expect(formatDuration(5500, 'ko')).toBe('5.5초');
      expect(formatDuration(30000, 'ko')).toBe('30.0초');
    });

    it('formats minutes and seconds', () => {
      expect(formatDuration(60000, 'ko')).toBe('1분 0초');
      expect(formatDuration(90000, 'ko')).toBe('1분 30초');
      expect(formatDuration(125000, 'ko')).toBe('2분 5초');
    });
  });
});

describe('formatBytes', () => {
  describe('English locale', () => {
    it('formats zero bytes', () => {
      expect(formatBytes(0, 'en')).toContain('0');
      expect(formatBytes(0, 'en')).toContain('B');
    });

    it('formats bytes (under 1 KB)', () => {
      expect(formatBytes(1, 'en')).toBe('1 B');
      expect(formatBytes(500, 'en')).toBe('500 B');
      expect(formatBytes(1023, 'en')).toBe('1,023 B');
    });

    it('formats kilobytes', () => {
      expect(formatBytes(1024, 'en')).toBe('1 KB');
      expect(formatBytes(1536, 'en')).toBe('1.5 KB');
      expect(formatBytes(10240, 'en')).toBe('10 KB');
      expect(formatBytes(102400, 'en')).toBe('100 KB');
    });

    it('formats megabytes', () => {
      expect(formatBytes(1048576, 'en')).toBe('1 MB');
      expect(formatBytes(1572864, 'en')).toBe('1.5 MB');
      expect(formatBytes(52428800, 'en')).toBe('50 MB');
    });

    it('formats gigabytes', () => {
      expect(formatBytes(1073741824, 'en')).toBe('1 GB');
      expect(formatBytes(1610612736, 'en')).toBe('1.5 GB');
    });
  });

  describe('Korean locale', () => {
    it('formats zero bytes', () => {
      expect(formatBytes(0, 'ko')).toContain('0');
    });

    it('formats bytes with Korean unit', () => {
      expect(formatBytes(500, 'ko')).toContain('바이트');
      expect(formatBytes(1023, 'ko')).toContain('바이트');
    });

    it('formats kilobytes (same SI prefix)', () => {
      expect(formatBytes(1024, 'ko')).toBe('1 KB');
      expect(formatBytes(1536, 'ko')).toBe('1.5 KB');
    });

    it('formats megabytes', () => {
      expect(formatBytes(1048576, 'ko')).toBe('1 MB');
    });

    it('formats gigabytes', () => {
      expect(formatBytes(1073741824, 'ko')).toBe('1 GB');
    });
  });
});

describe('formatNumber', () => {
  describe('English locale', () => {
    it('formats small numbers without grouping', () => {
      expect(formatNumber(0, 'en')).toBe('0');
      expect(formatNumber(42, 'en')).toBe('42');
      expect(formatNumber(999, 'en')).toBe('999');
    });

    it('formats thousands with grouping', () => {
      expect(formatNumber(1000, 'en')).toBe('1,000');
      expect(formatNumber(1000000, 'en')).toBe('1,000,000');
    });

    it('formats with decimal options', () => {
      expect(formatNumber(1234.56, 'en', { minimumFractionDigits: 2 })).toBe('1,234.56');
    });
  });

  describe('Korean locale', () => {
    it('uses same grouping as English', () => {
      expect(formatNumber(1000, 'ko')).toBe('1,000');
      expect(formatNumber(1000000, 'ko')).toBe('1,000,000');
    });
  });
});

describe('formatPercent', () => {
  it('formats whole percentages', () => {
    expect(formatPercent(0, 'en')).toBe('0%');
    expect(formatPercent(50, 'en')).toBe('50%');
    expect(formatPercent(100, 'en')).toBe('100%');
  });

  it('formats with decimals', () => {
    expect(formatPercent(33.33, 'en', 1)).toBe('33.3%');
    expect(formatPercent(66.666, 'en', 2)).toBe('66.67%');
  });

  it('formats Korean locale percentage', () => {
    expect(formatPercent(50, 'ko')).toBe('50%');
    expect(formatPercent(100, 'ko')).toBe('100%');
  });

  it('formats small percentages', () => {
    expect(formatPercent(1, 'en')).toBe('1%');
    expect(formatPercent(5, 'en')).toBe('5%');
  });

  it('formats with zero digits by default', () => {
    expect(formatPercent(33, 'en')).toBe('33%');
  });
});
